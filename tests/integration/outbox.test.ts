import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/storage/prisma";
import { processOutboxBatch } from "../../src/workers/outbox";

const now = new Date("2026-06-30T10:00:00.000Z");
const reachableUntil = new Date("2026-06-30T12:00:00.000Z");

async function cleanDatabase() {
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
}

async function createReachableUser(providerUserHash: string, providerSendQuota = 999) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "available",
      matchingEnabled: true,
      reachableUntil,
      providerSendQuota,
    },
  });
}

describe("outbox", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("sends pending and retrying reachable messages and clears their bodies", async () => {
    const pendingRecipient = await createReachableUser("outbox-pending-recipient");
    const retryingRecipient = await createReachableUser("outbox-retrying-recipient");
    await prisma.messageOutbox.createMany({
      data: [
        {
          recipientUserId: pendingRecipient.id,
          idempotencyKey: "outbox-pending-message",
          bodyCiphertextOrBody: "pending body",
          nextAttemptAt: now,
        },
        {
          recipientUserId: retryingRecipient.id,
          idempotencyKey: "outbox-retrying-message",
          bodyCiphertextOrBody: "retrying body",
          status: "retrying",
          retryCount: 1,
          nextAttemptAt: now,
        },
      ],
    });

    const sent: string[] = [];
    await processOutboxBatch({
      now,
      limit: 10,
      send: async (message) => {
        sent.push(`${message.idempotencyKey}:${message.body}`);
      },
    });

    expect(sent).toEqual(["outbox-pending-message:pending body", "outbox-retrying-message:retrying body"]);

    const messages = await prisma.messageOutbox.findMany({ orderBy: { idempotencyKey: "asc" } });
    expect(
      messages.map((message) => ({
        key: message.idempotencyKey,
        status: message.status,
        body: message.bodyCiphertextOrBody,
        bodyClearedAt: message.bodyClearedAt,
        sentAt: message.sentAt,
      })),
    ).toEqual([
      {
        key: "outbox-pending-message",
        status: "sent",
        body: null,
        bodyClearedAt: now,
        sentAt: now,
      },
      {
        key: "outbox-retrying-message",
        status: "sent",
        body: null,
        bodyClearedAt: now,
        sentAt: now,
      },
    ]);

    const users = await prisma.user.findMany({
      orderBy: { providerUserHash: "asc" },
      select: { providerSendQuota: true },
    });
    expect(users.map((user) => user.providerSendQuota)).toEqual([998, 998]);
  });

  it("marks expired provider windows unreachable without sending", async () => {
    const user = await prisma.user.create({
      data: {
        providerUserHash: "outbox-expired-recipient",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-expired-message",
        bodyCiphertextOrBody: "hello",
        nextAttemptAt: now,
      },
    });

    await processOutboxBatch({
      now,
      limit: 10,
      send: async () => {
        throw new Error("send_should_not_run");
      },
    });

    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "provider_window_expired",
      providerWindowCheckedAt: now,
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "unreachable", matchingEnabled: false });
  });

  it("marks exhausted provider quota unreachable without sending", async () => {
    const user = await createReachableUser("outbox-quota-recipient", 0);
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-quota-message",
        bodyCiphertextOrBody: "hello",
        nextAttemptAt: now,
      },
    });

    await processOutboxBatch({
      now,
      limit: 10,
      send: async () => {
        throw new Error("send_should_not_run");
      },
    });

    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "provider_window_expired",
      providerWindowCheckedAt: now,
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "unreachable", matchingEnabled: false });
  });

  it("retries send failures until the max retry limit", async () => {
    const user = await createReachableUser("outbox-retry-recipient");
    const message = await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-retry-message",
        bodyCiphertextOrBody: "retry me",
        nextAttemptAt: now,
      },
    });

    await processOutboxBatch({
      now,
      limit: 10,
      maxRetries: 2,
      send: async () => {
        throw new Error("temporary_provider_failure");
      },
    });

    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id } })).resolves.toMatchObject({
      status: "retrying",
      retryCount: 1,
      failedAt: null,
      bodyCiphertextOrBody: "retry me",
    });

    await processOutboxBatch({
      now,
      limit: 10,
      maxRetries: 2,
      send: async () => {
        throw new Error("temporary_provider_failure");
      },
    });

    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id } })).resolves.toMatchObject({
      status: "failed",
      retryCount: 2,
      failedAt: now,
      bodyCiphertextOrBody: "retry me",
    });
  });
});
