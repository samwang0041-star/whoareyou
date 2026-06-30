import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptOutboxBody } from "../../src/domain/outbox-body";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";
import { processOutboxBatch } from "../../src/workers/outbox";

const now = new Date("2026-06-30T10:00:00.000Z");
const reachableUntil = new Date("2026-06-30T12:00:00.000Z");

async function cleanDatabase() {
  await prisma.metricSnapshot.deleteMany();
  await prisma.workerHeartbeat.deleteMany();
  await prisma.appError.deleteMany();
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

async function withEnv<T>(updates: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("outbox", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("logs default fake sends without message body or identifiers", async () => {
    const user = await createReachableUser("outbox-log-recipient");
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-sensitive-idempotency-key",
        bodyCiphertextOrBody: "outbox sensitive body",
        nextAttemptAt: now,
      },
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withEnv({ PROVIDER_MODE: "fake" }, async () => {
      await processOutboxBatch({ now, limit: 10 });
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("fake-send");
    expect(output).not.toContain(user.id);
    expect(output).not.toContain("outbox-sensitive-idempotency-key");
    expect(output).not.toContain("outbox sensitive body");
  });

  it("decrypts encrypted chat bodies only in memory while sending", async () => {
    const user = await createReachableUser("outbox-encrypted-recipient");
    const storedBody = encryptOutboxBody("private human message");
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-encrypted-message",
        bodyCiphertextOrBody: storedBody,
        nextAttemptAt: now,
      },
    });
    expect(storedBody).not.toContain("private human message");

    const sent: string[] = [];
    await processOutboxBatch({
      now,
      limit: 10,
      send: async (message) => {
        sent.push(message.body);
      },
    });

    expect(sent).toEqual(["private human message"]);
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "sent",
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    });
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

  it("fails and clears stale pending or retrying message bodies before sending", async () => {
    const pendingRecipient = await createReachableUser("outbox-stale-pending-recipient");
    const retryingRecipient = await createReachableUser("outbox-stale-retrying-recipient");
    const freshRecipient = await createReachableUser("outbox-fresh-recipient");
    await prisma.messageOutbox.createMany({
      data: [
        {
          recipientUserId: pendingRecipient.id,
          idempotencyKey: "outbox-stale-pending",
          bodyCiphertextOrBody: "stale pending body",
          status: "pending",
          createdAt: new Date(now.getTime() - 121_000),
          nextAttemptAt: now,
        },
        {
          recipientUserId: retryingRecipient.id,
          idempotencyKey: "outbox-stale-retrying",
          bodyCiphertextOrBody: "stale retrying body",
          status: "retrying",
          retryCount: 1,
          createdAt: new Date(now.getTime() - 121_000),
          nextAttemptAt: now,
        },
        {
          recipientUserId: freshRecipient.id,
          idempotencyKey: "outbox-fresh-pending",
          bodyCiphertextOrBody: "fresh body",
          status: "pending",
          createdAt: new Date(now.getTime() - 119_000),
          nextAttemptAt: now,
        },
      ],
    });

    const sent: string[] = [];
    await withEnv({ OUTBOX_BODY_MAX_PENDING_SECONDS: "120" }, () =>
      processOutboxBatch({
        now,
        limit: 10,
        send: async (message) => {
          sent.push(message.idempotencyKey);
        },
      }),
    );

    expect(sent).toEqual(["outbox-fresh-pending"]);
    const messages = await prisma.messageOutbox.findMany({
      orderBy: { idempotencyKey: "asc" },
      select: { idempotencyKey: true, status: true, bodyCiphertextOrBody: true, bodyClearedAt: true, failedAt: true },
    });
    expect(messages).toEqual([
      {
        idempotencyKey: "outbox-fresh-pending",
        status: "sent",
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
        failedAt: null,
      },
      {
        idempotencyKey: "outbox-stale-pending",
        status: "failed",
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
        failedAt: now,
      },
      {
        idempotencyKey: "outbox-stale-retrying",
        status: "failed",
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
        failedAt: now,
      },
    ]);
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

  it("closes a quota-exhausted participant connection and cancels queued connection messages", async () => {
    const exhaustedUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-quota-close-exhausted",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 0,
      },
    });
    const peerUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-quota-close-peer",
        state: "matched",
        matchingEnabled: false,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: exhaustedUser.id,
        userBId: peerUser.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.messageOutbox.createMany({
      data: [
        {
          connectionId: connection.id,
          recipientUserId: exhaustedUser.id,
          idempotencyKey: "outbox-quota-close-exhausted-message",
          bodyCiphertextOrBody: "cannot send",
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: peerUser.id,
          idempotencyKey: "outbox-quota-close-peer-message",
          bodyCiphertextOrBody: "do not continue",
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

    expect(sent).toEqual([]);
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
      closedAt: now,
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [exhaustedUser.id, peerUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "outbox-quota-close-exhausted", state: "unreachable", matchingEnabled: false },
      { providerUserHash: "outbox-quota-close-peer", state: "cooldown", matchingEnabled: false },
    ]);

    const messages = await prisma.messageOutbox.findMany({
      orderBy: { idempotencyKey: "asc" },
      select: { idempotencyKey: true, status: true, bodyCiphertextOrBody: true, bodyClearedAt: true },
    });
    expect(messages).toEqual([
      {
        idempotencyKey: "outbox-quota-close-exhausted-message",
        status: "provider_window_expired",
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
      },
      {
        idempotencyKey: "outbox-quota-close-peer-message",
        status: "provider_window_expired",
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
      },
      {
        idempotencyKey: `provider-expired:${connection.id}:peer-notice:${peerUser.id}`,
        status: "pending",
        bodyCiphertextOrBody: voice.closedNoRelay(),
        bodyClearedAt: null,
      },
    ]);
    await expect(prisma.scheduledJob.findFirstOrThrow({ where: { userId: peerUser.id, type: "cooldown_release" } })).resolves.toMatchObject({
      connectionId: connection.id,
      runAt: new Date("2026-06-30T10:01:00.000Z"),
    });
  });

  it("marks an unreachable peer unreachable when provider expiry closes the connection", async () => {
    const exhaustedUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-quota-close-both-exhausted",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 0,
      },
    });
    const peerUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-quota-close-both-peer",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 0,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: exhaustedUser.id,
        userBId: peerUser.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.messageOutbox.createMany({
      data: [
        {
          connectionId: connection.id,
          recipientUserId: exhaustedUser.id,
          idempotencyKey: "outbox-quota-both-exhausted-message",
          bodyCiphertextOrBody: "cannot send",
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: peerUser.id,
          idempotencyKey: "outbox-quota-both-peer-message",
          bodyCiphertextOrBody: "also cannot send",
          nextAttemptAt: now,
        },
      ],
    });

    await processOutboxBatch({
      now,
      limit: 10,
      send: async () => {
        throw new Error("should not send");
      },
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
      closedAt: now,
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [exhaustedUser.id, peerUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "outbox-quota-close-both-exhausted", state: "unreachable", matchingEnabled: false },
      { providerUserHash: "outbox-quota-close-both-peer", state: "unreachable", matchingEnabled: false },
    ]);
    await expect(prisma.scheduledJob.count({ where: { connectionId: connection.id, type: "cooldown_release" } })).resolves.toBe(0);
    await expect(prisma.messageOutbox.count({ where: { idempotencyKey: { startsWith: `provider-expired:${connection.id}:peer-notice` } } })).resolves.toBe(0);
  });

  it("matches waiting users after provider expiry releases active capacity", async () => {
    const exhaustedUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-release-exhausted",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 0,
      },
    });
    const peerUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-release-peer",
        state: "matched",
        matchingEnabled: false,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const waitingA = await prisma.user.create({
      data: {
        providerUserHash: "outbox-release-waiting-a",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const waitingB = await prisma.user.create({
      data: {
        providerUserHash: "outbox-release-waiting-b",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: exhaustedUser.id,
        userBId: peerUser.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.messageOutbox.create({
      data: {
        connectionId: connection.id,
        recipientUserId: exhaustedUser.id,
        idempotencyKey: "outbox-release-expired-message",
        bodyCiphertextOrBody: "cannot send",
        nextAttemptAt: now,
      },
    });

    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1" }, async () => {
      await processOutboxBatch({
        now,
        limit: 10,
        send: async () => {
          throw new Error("should_not_send");
        },
      });
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
    });
    const nextConnection = await prisma.connection.findFirstOrThrow({
      where: {
        state: "active",
        OR: [
          { userAId: waitingA.id, userBId: waitingB.id },
          { userAId: waitingB.id, userBId: waitingA.id },
        ],
      },
    });
    await expect(prisma.messageOutbox.count({ where: { connectionId: nextConnection.id } })).resolves.toBe(2);
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

  it("does not overwrite an in-flight message that was expired before send success returned", async () => {
    const user = await createReachableUser("outbox-inflight-expired-success");
    const message = await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-inflight-expired-success",
        bodyCiphertextOrBody: "success returns late",
        nextAttemptAt: now,
      },
    });

    let releaseSend!: () => void;
    let batch!: ReturnType<typeof processOutboxBatch>;
    const sendStarted = new Promise<void>((resolve) => {
      batch = processOutboxBatch({
        now,
        limit: 10,
        send: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseSend = release;
          });
        },
      });
    });

    await sendStarted;
    await prisma.messageOutbox.update({
      where: { id: message.id },
      data: {
        status: "provider_window_expired",
        providerWindowCheckedAt: now,
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
      },
    });
    releaseSend();
    await expect(batch).resolves.toMatchObject({ sent: 0 });

    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id } })).resolves.toMatchObject({
      status: "provider_window_expired",
      sentAt: null,
      bodyCiphertextOrBody: null,
    });
  });

  it("does not overwrite an in-flight message that was expired before send failure returned", async () => {
    const user = await createReachableUser("outbox-inflight-expired-failure");
    const message = await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-inflight-expired-failure",
        bodyCiphertextOrBody: "failure returns late",
        nextAttemptAt: now,
      },
    });

    let releaseSend!: () => void;
    let batch!: ReturnType<typeof processOutboxBatch>;
    const sendStarted = new Promise<void>((resolve) => {
      batch = processOutboxBatch({
        now,
        limit: 10,
        send: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseSend = release;
          });
          throw new Error("late failure");
        },
      });
    });

    await sendStarted;
    await prisma.messageOutbox.update({
      where: { id: message.id },
      data: {
        status: "provider_window_expired",
        providerWindowCheckedAt: now,
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
      },
    });
    releaseSend();
    await expect(batch).resolves.toMatchObject({ retried: 0, failed: 0 });

    await expect(prisma.messageOutbox.findUniqueOrThrow({ where: { id: message.id } })).resolves.toMatchObject({
      status: "provider_window_expired",
      retryCount: 0,
      failedAt: null,
      bodyCiphertextOrBody: null,
    });
  });

  it("fails messages for blocked recipients instead of sending them", async () => {
    const blockedUser = await prisma.user.create({
      data: {
        providerUserHash: "outbox-blocked-recipient",
        state: "blocked",
        matchingEnabled: false,
        reachableUntil,
        providerSendQuota: 999,
        blockedAt: now,
      },
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: blockedUser.id,
        idempotencyKey: "outbox-blocked-message",
        bodyCiphertextOrBody: "do not send",
        nextAttemptAt: now,
      },
    });

    await expect(
      processOutboxBatch({
        now,
        limit: 10,
        send: async () => {
          throw new Error("should_not_send_blocked_user");
        },
      }),
    ).resolves.toMatchObject({ failed: 1 });
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "failed",
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    });
  });

  it("recovers stale sending messages and restores reserved quota before retrying", async () => {
    const user = await createReachableUser("outbox-stale-sending-recipient", 998);
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-stale-sending-message",
        bodyCiphertextOrBody: "send after recovery",
        status: "sending",
        nextAttemptAt: new Date(now.getTime() - 6 * 60_000),
        providerWindowCheckedAt: new Date(now.getTime() - 6 * 60_000),
      },
    });

    const sent: string[] = [];
    await processOutboxBatch({
      now,
      limit: 10,
      send: async (message) => {
        sent.push(`${message.idempotencyKey}:${message.body}`);
      },
    });

    expect(sent).toEqual(["outbox-stale-sending-message:send after recovery"]);
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      status: "sent",
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
      sentAt: now,
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { providerSendQuota: true },
      }),
    ).resolves.toEqual({ providerSendQuota: 998 });
  });

  it("records an ok worker heartbeat after a batch", async () => {
    const user = await createReachableUser("outbox-heartbeat-recipient");
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: user.id,
        idempotencyKey: "outbox-heartbeat-message",
        bodyCiphertextOrBody: "heartbeat body",
        nextAttemptAt: now,
      },
    });

    await expect(
      processOutboxBatch({
        now,
        limit: 10,
        send: async () => {},
      }),
    ).resolves.toEqual({ processed: 1, sent: 1, retried: 0, failed: 0, providerWindowExpired: 0 });

    await expect(prisma.workerHeartbeat.findUniqueOrThrow({ where: { workerName: "outbox" } })).resolves.toMatchObject({
      workerName: "outbox",
      status: "ok",
      lastSeenAt: now,
      metadataJson: { processed: 1, sent: 1, retried: 0, failed: 0, providerWindowExpired: 0 },
    });
  });

  it("records an app error and error heartbeat for unexpected batch failures", async () => {
    vi.spyOn(prisma.messageOutbox, "findMany").mockRejectedValueOnce(new Error("outbox_database_unavailable"));

    await expect(
      processOutboxBatch({
        now,
        limit: 10,
        send: async () => {},
      }),
    ).rejects.toThrow("outbox_database_unavailable");

    await expect(prisma.appError.findFirstOrThrow()).resolves.toMatchObject({
      source: "outbox",
      severity: "error",
      fingerprint: "outbox:outbox_database_unavailable",
      message: "outbox_database_unavailable",
    });
    await expect(prisma.workerHeartbeat.findUniqueOrThrow({ where: { workerName: "outbox" } })).resolves.toMatchObject({
      workerName: "outbox",
      status: "error",
      lastSeenAt: now,
      metadataJson: { errorFingerprint: "outbox:outbox_database_unavailable" },
    });
  });
});
