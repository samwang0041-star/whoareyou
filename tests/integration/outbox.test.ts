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
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
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
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
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

    const retryAt = new Date(now.getTime() + 30_000);
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
      now: retryAt,
      limit: 10,
      maxRetries: 2,
      send: async () => {
        throw new Error("temporary_provider_failure");
      },
    });

    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id } })).resolves.toMatchObject({
      status: "failed",
      retryCount: 2,
      failedAt: retryAt,
      bodyCiphertextOrBody: null,
      bodyClearedAt: retryAt,
    });
  });

  it("claims messages before sending so concurrent batches do not duplicate provider sends", async () => {
    const user = await createReachableUser("outbox-concurrent-recipient");
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-concurrent-message",
        bodyCiphertextOrBody: "send once",
        nextAttemptAt: now,
      },
    });

    const sent: string[] = [];
    await Promise.all([
      processOutboxBatch({
        now,
        limit: 10,
        send: async (message) => {
          sent.push(message.idempotencyKey);
        },
      }),
      processOutboxBatch({
        now,
        limit: 10,
        send: async (message) => {
          sent.push(message.idempotencyKey);
        },
      }),
    ]);

    expect(sent).toEqual(["outbox-concurrent-message"]);
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "sent",
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    });
  });

  it("does not oversend when one recipient has multiple due messages and one quota", async () => {
    const user = await createReachableUser("outbox-quota-batch-recipient", 1);
    await prisma.messageOutbox.createMany({
      data: [
        {
          recipientUserId: user.id,
          idempotencyKey: "outbox-quota-batch-1",
          bodyCiphertextOrBody: "first",
          nextAttemptAt: now,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "outbox-quota-batch-2",
          bodyCiphertextOrBody: "second",
          nextAttemptAt: now,
        },
      ],
    });

    const sent: string[] = [];
    await processOutboxBatch({
      now,
      limit: 10,
      send: async (message) => {
        sent.push(message.idempotencyKey);
      },
    });

    expect(sent).toHaveLength(1);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { providerSendQuota: true },
      }),
    ).resolves.toEqual({ providerSendQuota: 0 });
    const messages = await prisma.messageOutbox.findMany({ orderBy: { idempotencyKey: "asc" } });
    expect(messages.map((message) => message.status)).toEqual(["sent", "provider_window_expired"]);
    expect(messages.map((message) => message.bodyCiphertextOrBody)).toEqual([null, null]);
  });

  it("keeps a long in-flight send from being reclaimed by a later batch", async () => {
    const user = await createReachableUser("outbox-long-send-recipient");
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-long-send-message",
        bodyCiphertextOrBody: "send once slowly",
        nextAttemptAt: now,
      },
    });

    let releaseSend!: () => void;
    const sent: string[] = [];
    const pendingBatches: Promise<unknown>[] = [];
    const sendStarted = new Promise<void>((resolve) => {
      const firstBatch = processOutboxBatch({
        now,
        limit: 10,
        send: async (message) => {
          sent.push(message.idempotencyKey);
          resolve();
          await new Promise<void>((release) => {
            releaseSend = release;
          });
        },
      });
      pendingBatches.push(firstBatch);
    });

    await sendStarted;
    pendingBatches.push(
      processOutboxBatch({
        now: new Date(now.getTime() + 31_000),
        limit: 10,
        send: async (message) => {
          sent.push(`duplicate:${message.idempotencyKey}`);
        },
      }),
    );

    releaseSend();
    await Promise.all(pendingBatches);

    expect(sent).toEqual(["outbox-long-send-message"]);
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "sent",
      bodyCiphertextOrBody: null,
    });
  });
});
