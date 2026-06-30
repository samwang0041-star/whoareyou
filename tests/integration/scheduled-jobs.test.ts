import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";
import { processScheduledJobs, setBeforeScheduledUserStateUpdateHookForTest } from "../../src/workers/scheduled-jobs";

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
  await prisma.rateLimitEvent.deleteMany();
  await prisma.inboundDedupe.deleteMany();
  await prisma.userProviderRef.deleteMany();
  await prisma.openClawBotSession.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
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

async function createMatchedUser(providerUserHash: string, matchingEnabled = true) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "matched",
      matchingEnabled,
      reachableUntil,
    },
  });
}

async function createConnection() {
  const userA = await createMatchedUser("scheduled-user-a");
  const userB = await createMatchedUser("scheduled-user-b");
  const connection = await prisma.connection.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      state: "active",
      startedAt: now,
    },
  });
  return { connection, userA, userB };
}

describe("scheduled jobs", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(() => {
    setBeforeScheduledUserStateUpdateHookForTest(null);
  });

  it("self-seeds recurring operational jobs when the DB has no scheduled jobs", async () => {
    await expect(processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 })).resolves.toEqual({
      processed: 0,
      completed: 0,
      failed: 0,
    });

    const jobs = await prisma.scheduledJob.findMany({
      orderBy: { idempotencyKey: "asc" },
      select: { type: true, status: true, runAt: true, idempotencyKey: true },
    });
    expect(jobs).toEqual([
      {
        type: "entity_cleanup",
        status: "pending",
        runAt: new Date("2026-06-30T12:00:00.000Z"),
        idempotencyKey: "operational:entity_cleanup:2026-06-30T12:00:00.000Z",
      },
      {
        type: "metric_snapshot",
        status: "pending",
        runAt: new Date("2026-06-30T10:01:00.000Z"),
        idempotencyKey: "operational:metric_snapshot:2026-06-30T10:01:00.000Z",
      },
      {
        type: "outbox_body_cleanup",
        status: "pending",
        runAt: new Date("2026-06-30T10:01:00.000Z"),
        idempotencyKey: "operational:outbox_body_cleanup:2026-06-30T10:01:00.000Z",
      },
    ]);
  });

  it("does not seed duplicate operational jobs on every worker poll inside the same interval", async () => {
    await withEnv({ OPERATIONAL_JOB_INTERVAL_SECONDS: "60" }, async () => {
      await processScheduledJobs({ now: new Date("2026-06-30T10:00:00.000Z"), limit: 10, cooldownSeconds: 60 });
      await processScheduledJobs({ now: new Date("2026-06-30T10:00:05.000Z"), limit: 10, cooldownSeconds: 60 });
      await processScheduledJobs({ now: new Date("2026-06-30T10:00:10.000Z"), limit: 10, cooldownSeconds: 60 });
    });

    const jobs = await prisma.scheduledJob.findMany({
      where: { idempotencyKey: { startsWith: "operational:" } },
      orderBy: { idempotencyKey: "asc" },
      select: { type: true, runAt: true, idempotencyKey: true },
    });
    expect(jobs).toEqual([
      {
        type: "entity_cleanup",
        runAt: new Date("2026-06-30T12:00:00.000Z"),
        idempotencyKey: "operational:entity_cleanup:2026-06-30T12:00:00.000Z",
      },
      {
        type: "metric_snapshot",
        runAt: new Date("2026-06-30T10:01:00.000Z"),
        idempotencyKey: "operational:metric_snapshot:2026-06-30T10:01:00.000Z",
      },
      {
        type: "outbox_body_cleanup",
        runAt: new Date("2026-06-30T10:01:00.000Z"),
        idempotencyKey: "operational:outbox_body_cleanup:2026-06-30T10:01:00.000Z",
      },
    ]);
  });

  it("entity_cleanup deletes expired sessions, old inbound dedupe, resolved app errors, and old rate limit events", async () => {
    await withEnv(
      {
        ENTITY_CLEANUP_SESSION_RETENTION_HOURS: "24",
        ENTITY_CLEANUP_INBOUND_DEDUPE_RETENTION_HOURS: "24",
        ENTITY_CLEANUP_APP_ERROR_RETENTION_HOURS: "24",
        ENTITY_CLEANUP_RATE_LIMIT_RETENTION_HOURS: "24",
      },
      async () => {
        const staleSessionCutoff = new Date("2026-06-28T10:00:00.000Z");
        const recentSessionCutoff = new Date("2026-06-30T09:30:00.000Z");
        await prisma.openClawBotSession.create({
          data: {
            qrcode: "cleanup-expired-session",
            status: "expired",
            expiresAt: staleSessionCutoff,
            updatedAt: staleSessionCutoff,
          },
        });
        await prisma.openClawBotSession.create({
          data: {
            qrcode: "cleanup-active-session",
            status: "waiting_to_scan",
            expiresAt: new Date("2026-06-30T12:00:00.000Z"),
            updatedAt: recentSessionCutoff,
          },
        });
        await prisma.inboundDedupe.create({
          data: {
            providerMessageKey: "cleanup-old-inbound",
            receivedAt: staleSessionCutoff,
            status: "processed",
          },
        });
        await prisma.inboundDedupe.create({
          data: {
            providerMessageKey: "cleanup-fresh-inbound",
            receivedAt: now,
            status: "processed",
          },
        });
        await prisma.appError.create({
          data: {
            source: "test",
            severity: "error",
            fingerprint: "test:resolved-old",
            message: "resolved old error",
            resolvedAt: staleSessionCutoff,
            createdAt: staleSessionCutoff,
          },
        });
        await prisma.appError.create({
          data: {
            source: "test",
            severity: "error",
            fingerprint: "test:unresolved",
            message: "unresolved error",
            createdAt: now,
          },
        });
        await prisma.rateLimitEvent.create({
          data: { userId: "ignored", eventType: "cleanup-old-event", createdAt: staleSessionCutoff },
        });
        await prisma.rateLimitEvent.create({
          data: { userId: "ignored", eventType: "cleanup-fresh-event", createdAt: now },
        });

        await prisma.scheduledJob.create({
          data: { type: "entity_cleanup", runAt: now, idempotencyKey: "test-entity-cleanup" },
        });
        await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

        const remainingSessions = await prisma.openClawBotSession.findMany({ select: { qrcode: true } });
        expect(remainingSessions.map((row) => row.qrcode).sort()).toEqual(["cleanup-active-session"]);

        const remainingInbound = await prisma.inboundDedupe.findMany({ select: { providerMessageKey: true } });
        expect(remainingInbound.map((row) => row.providerMessageKey).sort()).toEqual(["cleanup-fresh-inbound"]);

        const remainingErrors = await prisma.appError.findMany({ select: { fingerprint: true } });
        expect(remainingErrors.map((row) => row.fingerprint).sort()).toEqual(["test:unresolved"]);

        const remainingEvents = await prisma.rateLimitEvent.findMany({ select: { eventType: true } });
        expect(remainingEvents.map((row) => row.eventType).sort()).toEqual(["cleanup-fresh-event"]);
      },
    );
  });

  it("creates reminder outbox messages for every reminder and sets ending at 50 minutes", async () => {
    const { connection } = await createConnection();
    await prisma.scheduledJob.createMany({
      data: [
        { connectionId: connection.id, type: "reminder_10", runAt: now, idempotencyKey: "scheduled-reminder-10" },
        { connectionId: connection.id, type: "reminder_20", runAt: now, idempotencyKey: "scheduled-reminder-20" },
        { connectionId: connection.id, type: "reminder_30", runAt: now, idempotencyKey: "scheduled-reminder-30" },
        { connectionId: connection.id, type: "reminder_40", runAt: now, idempotencyKey: "scheduled-reminder-40" },
        { connectionId: connection.id, type: "reminder_50", runAt: now, idempotencyKey: "scheduled-reminder-50" },
      ],
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });
    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "ending",
      endingAt: now,
    });
    await expect(prisma.scheduledJob.count({ where: { status: "completed" } })).resolves.toBe(5);

    const messages = await prisma.messageOutbox.findMany({
      orderBy: [{ idempotencyKey: "asc" }, { recipientUserId: "asc" }],
      select: { idempotencyKey: true, bodyCiphertextOrBody: true, status: true },
    });
    expect(messages).toHaveLength(10);
    expect(messages.map((message) => message.status)).toEqual(Array(10).fill("pending"));
    expect(messages.map((message) => message.bodyCiphertextOrBody)).toEqual([
      voice.minuteReminder(50),
      voice.minuteReminder(50),
      voice.minuteReminder(40),
      voice.minuteReminder(40),
      voice.minuteReminder(30),
      voice.minuteReminder(30),
      voice.minuteReminder(20),
      voice.minuteReminder(20),
      voice.ending(),
      voice.ending(),
    ]);
  });

  it("closes the connection at 60 minutes and keeps ended users matching enabled in cooldown", async () => {
    const { connection, userA, userB } = await createConnection();
    await prisma.scheduledJob.create({
      data: {
        connectionId: connection.id,
        type: "close_connection",
        runAt: now,
        idempotencyKey: "scheduled-close",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });
    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "timeout",
      closedAt: now,
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [userA.id, userB.id] } },
      orderBy: { providerUserHash: "asc" },
      select: { state: true, matchingEnabled: true },
    });
    expect(users).toEqual([
      { state: "cooldown", matchingEnabled: true },
      { state: "cooldown", matchingEnabled: true },
    ]);
    await expect(prisma.messageOutbox.count()).resolves.toBe(2);
    await expect(prisma.messageOutbox.findFirstOrThrow()).resolves.toMatchObject({
      bodyCiphertextOrBody: voice.ended(),
    });
  });

  it("matches waiting users after a timed-out active connection releases capacity", async () => {
    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1", MAX_WAITING_USERS: "5" }, async () => {
      const { connection } = await createConnection();
      const [waitingA, waitingB] = await Promise.all([
        prisma.user.create({
          data: {
            providerUserHash: "scheduled-waiting-a",
            state: "waiting",
            matchingEnabled: true,
            reachableUntil,
          },
        }),
        prisma.user.create({
          data: {
            providerUserHash: "scheduled-waiting-b",
            state: "waiting",
            matchingEnabled: true,
            reachableUntil,
          },
        }),
      ]);
      await prisma.scheduledJob.create({
        data: {
          connectionId: connection.id,
          type: "close_connection",
          runAt: now,
          idempotencyKey: "scheduled-close-capacity-release",
        },
      });

      await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

      await expect(
        prisma.connection.findFirst({
          where: {
            state: "active",
            OR: [
              { userAId: waitingA.id, userBId: waitingB.id },
              { userAId: waitingB.id, userBId: waitingA.id },
            ],
          },
        }),
      ).resolves.toMatchObject({
        state: "active",
      });
    });
  });

  it("preserves a paused user's matching preference through close and cooldown release", async () => {
    const pausedUser = await createMatchedUser("scheduled-close-paused-user", false);
    const matchingUser = await createMatchedUser("scheduled-close-enabled-user", true);
    const connection = await prisma.connection.create({
      data: {
        userAId: pausedUser.id,
        userBId: matchingUser.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        connectionId: connection.id,
        type: "close_connection",
        runAt: now,
        idempotencyKey: "scheduled-close-preserve-paused",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findMany({
        where: { id: { in: [pausedUser.id, matchingUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-close-enabled-user", state: "cooldown", matchingEnabled: true },
      { providerUserHash: "scheduled-close-paused-user", state: "cooldown", matchingEnabled: false },
    ]);

    await processScheduledJobs({ now: new Date("2026-06-30T10:01:00.000Z"), limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findMany({
        where: { id: { in: [pausedUser.id, matchingUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-close-enabled-user", state: "available", matchingEnabled: true },
      { providerUserHash: "scheduled-close-paused-user", state: "paused", matchingEnabled: false },
    ]);
  });

  it("does not overwrite a connection already closed by leave or report", async () => {
    const { connection } = await createConnection();
    const leftAt = new Date(now.getTime() - 1_000);
    await prisma.connection.update({
      where: { id: connection.id },
      data: {
        state: "awaiting_echo",
        closeReason: "left",
        closedAt: leftAt,
      },
    });
    await prisma.scheduledJob.createMany({
      data: [
        {
          connectionId: connection.id,
          type: "reminder_50",
          runAt: now,
          idempotencyKey: "scheduled-stale-reminder",
        },
        {
          connectionId: connection.id,
          type: "close_connection",
          runAt: now,
          idempotencyKey: "scheduled-stale-close",
        },
      ],
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
      closedAt: leftAt,
    });
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);
    await expect(prisma.scheduledJob.count({ where: { status: "completed" } })).resolves.toBe(2);
  });

  it("recovers a stale running job", async () => {
    const user = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-stale-running-user",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: user.id,
        type: "cooldown_release",
        runAt: now,
        idempotencyKey: "scheduled-stale-running",
        status: "running",
        lockedAt: new Date(now.getTime() - 120_000),
        attempts: 1,
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "available", matchingEnabled: true });
    await expect(prisma.scheduledJob.findUniqueOrThrow({ where: { idempotencyKey: "scheduled-stale-running" } })).resolves.toMatchObject({
      status: "completed",
      attempts: 2,
      completedAt: now,
    });
  });

  it("releases cooldown users when reachable and marks expired users unreachable", async () => {
    const reachableUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-cooldown-reachable",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-cooldown-expired",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil: now,
        providerSendQuota: 999,
      },
    });
    await prisma.scheduledJob.createMany({
      data: [
        { userId: reachableUser.id, type: "cooldown_release", runAt: now, idempotencyKey: "scheduled-cooldown-reachable" },
        { userId: expiredUser.id, type: "cooldown_release", runAt: now, idempotencyKey: "scheduled-cooldown-expired" },
      ],
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    const users = await prisma.user.findMany({
      orderBy: { providerUserHash: "asc" },
      select: { providerUserHash: true, state: true, matchingEnabled: true },
    });
    expect(users).toEqual([
      { providerUserHash: "scheduled-cooldown-expired", state: "unreachable", matchingEnabled: false },
      { providerUserHash: "scheduled-cooldown-reachable", state: "available", matchingEnabled: true },
    ]);
  });

  it("does not release a cooldown user blocked after the scheduled job lookup", async () => {
    const blockedDuringRelease = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-cooldown-race-blocked",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: blockedDuringRelease.id,
        type: "cooldown_release",
        runAt: now,
        idempotencyKey: "scheduled-cooldown-race-blocked",
      },
    });
    setBeforeScheduledUserStateUpdateHookForTest(async ({ reason, userIds }) => {
      if (reason !== "cooldown_release") return;
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { state: "blocked", matchingEnabled: false, blockedAt: now },
      });
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: blockedDuringRelease.id },
        select: { state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toEqual({
      state: "blocked",
      matchingEnabled: false,
      blockedAt: now,
    });
  });

  it("does not mark a non-cooldown user unreachable from an old cooldown release job", async () => {
    const activeUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-old-release-active-user",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: activeUser.id,
        type: "cooldown_release",
        runAt: now,
        idempotencyKey: "scheduled-old-release-active-user",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: activeUser.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "matched", matchingEnabled: true });
    await expect(prisma.scheduledJob.findUniqueOrThrow({ where: { idempotencyKey: "scheduled-old-release-active-user" } })).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("does not let an old connection cooldown release unlock a newer cooldown", async () => {
    const cooldownUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-cooldown-bound-user",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const oldPeer = await createMatchedUser("scheduled-cooldown-bound-old-peer");
    const newPeer = await createMatchedUser("scheduled-cooldown-bound-new-peer");
    const oldConnection = await prisma.connection.create({
      data: {
        userAId: cooldownUser.id,
        userBId: oldPeer.id,
        state: "awaiting_echo",
        startedAt: new Date("2026-06-30T08:00:00.000Z"),
        closedAt: new Date("2026-06-30T09:00:00.000Z"),
        closeReason: "timeout",
      },
    });
    const newConnection = await prisma.connection.create({
      data: {
        userAId: cooldownUser.id,
        userBId: newPeer.id,
        state: "awaiting_echo",
        startedAt: new Date("2026-06-30T09:30:00.000Z"),
        closedAt: new Date("2026-06-30T09:59:00.000Z"),
        closeReason: "left",
      },
    });
    await prisma.scheduledJob.create({
      data: {
        connectionId: oldConnection.id,
        userId: cooldownUser.id,
        type: "cooldown_release",
        runAt: now,
        idempotencyKey: "scheduled-old-cooldown-release",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: cooldownUser.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "cooldown", matchingEnabled: true });
    await expect(prisma.scheduledJob.findUniqueOrThrow({ where: { idempotencyKey: "scheduled-old-cooldown-release" } })).resolves.toMatchObject({
      status: "completed",
    });

    await prisma.scheduledJob.create({
      data: {
        connectionId: newConnection.id,
        userId: cooldownUser.id,
        type: "cooldown_release",
        runAt: now,
        idempotencyKey: "scheduled-new-cooldown-release",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: cooldownUser.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "available", matchingEnabled: true });
  });

  it("sends reachability renewal prompts and expires users after the provider window", async () => {
    const promptUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-prompt",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T10:30:00.000Z"),
        providerSendQuota: 999,
      },
    });
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-expired",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    await prisma.scheduledJob.createMany({
      data: [
        { userId: promptUser.id, type: "reachability_renewal_prompt", runAt: now, idempotencyKey: "scheduled-renewal-prompt" },
        { userId: expiredUser.id, type: "reachability_renewal_prompt", runAt: now, idempotencyKey: "scheduled-renewal-expired" },
      ],
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });
    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.messageOutbox.findMany()).resolves.toMatchObject([
      {
        recipientUserId: promptUser.id,
        idempotencyKey: `scheduled-renewal-prompt:reachability-renewal:${promptUser.id}`,
        bodyCiphertextOrBody: voice.reachabilityRenewal(),
      },
    ]);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: expiredUser.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "unreachable", matchingEnabled: false });
    await expect(prisma.scheduledJob.count({ where: { status: "completed" } })).resolves.toBe(2);
  });

  it("closes active connections when reachability expiry makes a participant unreachable", async () => {
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-expired-matched",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    const peerUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-expired-peer",
        state: "matched",
        matchingEnabled: false,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: expiredUser.id,
        userBId: peerUser.id,
        state: "active",
        startedAt: now,
      },
    });
    const waitingA = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-waiting-a",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const waitingB = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-waiting-b",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: expiredUser.id,
        type: "reachability_renewal_prompt",
        runAt: now,
        idempotencyKey: "scheduled-renewal-expired-active",
      },
    });
    await prisma.messageOutbox.createMany({
      data: [
        {
          connectionId: connection.id,
          recipientUserId: expiredUser.id,
          idempotencyKey: "scheduled-renewal-expired-active-message",
          bodyCiphertextOrBody: "cannot continue",
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: peerUser.id,
          idempotencyKey: "scheduled-renewal-expired-peer-message",
          bodyCiphertextOrBody: "also stop peer",
          nextAttemptAt: now,
        },
      ],
    });

    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1" }, async () => {
      await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
      closedAt: now,
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [expiredUser.id, peerUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-renewal-expired-matched", state: "unreachable", matchingEnabled: false },
      { providerUserHash: "scheduled-renewal-expired-peer", state: "cooldown", matchingEnabled: false },
    ]);
    const messages = await prisma.messageOutbox.findMany({
      where: { connectionId: connection.id },
      orderBy: { idempotencyKey: "asc" },
      select: { recipientUserId: true, status: true, bodyCiphertextOrBody: true, bodyClearedAt: true },
    });
    expect(messages).toHaveLength(3);
    expect(messages).toEqual(expect.arrayContaining([
      { recipientUserId: expiredUser.id, status: "provider_window_expired", bodyCiphertextOrBody: null, bodyClearedAt: now },
      { recipientUserId: peerUser.id, status: "provider_window_expired", bodyCiphertextOrBody: null, bodyClearedAt: now },
      { recipientUserId: peerUser.id, status: "pending", bodyCiphertextOrBody: voice.closedNoRelay(), bodyClearedAt: null },
    ]));
    await expect(
      prisma.scheduledJob.findFirstOrThrow({
        where: {
          userId: peerUser.id,
          type: "cooldown_release",
          idempotencyKey: `provider-expired:${connection.id}:cooldown-release:${peerUser.id}`,
        },
      }),
    ).resolves.toMatchObject({
      runAt: new Date("2026-06-30T10:01:00.000Z"),
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
    await expect(
      prisma.user.findMany({
        where: { id: { in: [waitingA.id, waitingB.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-renewal-waiting-a", state: "matched" },
      { providerUserHash: "scheduled-renewal-waiting-b", state: "matched" },
    ]);
    await expect(prisma.messageOutbox.count({ where: { connectionId: nextConnection.id } })).resolves.toBe(2);
  });

  it("does not close an active connection when an expired reachability job races with a renewed user", async () => {
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-race-user",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    const peerUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-race-peer",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: expiredUser.id,
        userBId: peerUser.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: expiredUser.id,
        type: "reachability_renewal_prompt",
        runAt: now,
        idempotencyKey: "scheduled-renewal-race-active",
      },
    });
    setBeforeScheduledUserStateUpdateHookForTest(async ({ reason, userIds }) => {
      if (reason !== "provider_expired_user") return;
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: {
          reachableUntil,
          providerSendQuota: 999,
        },
      });
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "active",
      closeReason: null,
      closedAt: null,
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [expiredUser.id, peerUser.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true, reachableUntil: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-renewal-race-peer", state: "matched", matchingEnabled: true, reachableUntil },
      { providerUserHash: "scheduled-renewal-race-user", state: "matched", matchingEnabled: true, reachableUntil },
    ]);
  });

  it("does not move unreachable peers to cooldown when reachability expiry closes a connection", async () => {
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-both-expired-user",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    const expiredPeer = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-both-expired-peer",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: now,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: expiredUser.id,
        userBId: expiredPeer.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: expiredUser.id,
        type: "reachability_renewal_prompt",
        runAt: now,
        idempotencyKey: "scheduled-renewal-both-expired-active",
      },
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [expiredUser.id, expiredPeer.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual([
      { providerUserHash: "scheduled-renewal-both-expired-peer", state: "unreachable", matchingEnabled: false },
      { providerUserHash: "scheduled-renewal-both-expired-user", state: "unreachable", matchingEnabled: false },
    ]);
    await expect(
      prisma.scheduledJob.count({
        where: {
          userId: expiredPeer.id,
          type: "cooldown_release",
        },
      }),
    ).resolves.toBe(0);
  });

  it("does not schedule cooldown release for a peer blocked after provider-expired peer lookup", async () => {
    const expiredUser = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-block-race-user",
        state: "matched",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
        providerSendQuota: 999,
      },
    });
    const blockedPeer = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-renewal-block-race-peer",
        state: "matched",
        matchingEnabled: true,
        reachableUntil,
        providerSendQuota: 999,
      },
    });
    const connection = await prisma.connection.create({
      data: {
        userAId: expiredUser.id,
        userBId: blockedPeer.id,
        state: "active",
        startedAt: now,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        userId: expiredUser.id,
        type: "reachability_renewal_prompt",
        runAt: now,
        idempotencyKey: "scheduled-renewal-block-race-active",
      },
    });
    setBeforeScheduledUserStateUpdateHookForTest(async ({ reason, userIds }) => {
      if (reason !== "provider_expired_peers") return;
      await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { state: "blocked", matchingEnabled: false, blockedAt: now },
      });
    });

    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "provider_expired",
    });
    await expect(
      prisma.user.findMany({
        where: { id: { in: [expiredUser.id, blockedPeer.id] } },
        orderBy: { providerUserHash: "asc" },
        select: { providerUserHash: true, state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toEqual([
      {
        providerUserHash: "scheduled-renewal-block-race-peer",
        state: "blocked",
        matchingEnabled: false,
        blockedAt: now,
      },
      {
        providerUserHash: "scheduled-renewal-block-race-user",
        state: "unreachable",
        matchingEnabled: false,
        blockedAt: null,
      },
    ]);
    await expect(
      prisma.scheduledJob.count({
        where: {
          userId: blockedPeer.id,
          type: "cooldown_release",
        },
      }),
    ).resolves.toBe(0);
  });

  it("clears old terminal outbox bodies with the cleanup TTL", async () => {
    const user = await createMatchedUser("scheduled-cleanup-user");
    const oldTerminalAt = new Date(now.getTime() - 901_000);
    const recentTerminalAt = new Date(now.getTime() - 899_000);
    await prisma.messageOutbox.createMany({
      data: [
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-old-sent",
          status: "sent",
          bodyCiphertextOrBody: "old sent body",
          sentAt: oldTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-old-failed",
          status: "failed",
          bodyCiphertextOrBody: "old failed body",
          failedAt: oldTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-old-expired",
          status: "provider_window_expired",
          bodyCiphertextOrBody: "old expired body",
          providerWindowCheckedAt: oldTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-recent-sent",
          status: "sent",
          bodyCiphertextOrBody: "recent sent body",
          sentAt: recentTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-old-pending",
          status: "pending",
          bodyCiphertextOrBody: "old pending body",
          createdAt: oldTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-old-retrying",
          status: "retrying",
          bodyCiphertextOrBody: "old retrying body",
          createdAt: oldTerminalAt,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "cleanup-live-pending",
          status: "pending",
          bodyCiphertextOrBody: "live pending body",
          createdAt: recentTerminalAt,
        },
      ],
    });
    await prisma.scheduledJob.create({
      data: {
        userId: user.id,
        type: "outbox_body_cleanup",
        runAt: now,
        idempotencyKey: "scheduled-outbox-body-cleanup",
      },
    });

    await withEnv({ OUTBOX_BODY_MAX_PENDING_SECONDS: "900" }, () =>
      processScheduledJobs({ now, limit: 10, cooldownSeconds: 60, bodyTtlSeconds: 900 }),
    );

    const messages = await prisma.messageOutbox.findMany({
      orderBy: { idempotencyKey: "asc" },
      select: { idempotencyKey: true, status: true, bodyCiphertextOrBody: true, bodyClearedAt: true, failedAt: true },
    });
    expect(messages).toEqual([
      { idempotencyKey: "cleanup-live-pending", status: "pending", bodyCiphertextOrBody: "live pending body", bodyClearedAt: null, failedAt: null },
      { idempotencyKey: "cleanup-old-expired", status: "provider_window_expired", bodyCiphertextOrBody: null, bodyClearedAt: now, failedAt: null },
      { idempotencyKey: "cleanup-old-failed", status: "failed", bodyCiphertextOrBody: null, bodyClearedAt: now, failedAt: oldTerminalAt },
      { idempotencyKey: "cleanup-old-pending", status: "failed", bodyCiphertextOrBody: null, bodyClearedAt: now, failedAt: now },
      { idempotencyKey: "cleanup-old-retrying", status: "failed", bodyCiphertextOrBody: null, bodyClearedAt: now, failedAt: now },
      { idempotencyKey: "cleanup-old-sent", status: "sent", bodyCiphertextOrBody: null, bodyClearedAt: now, failedAt: null },
      { idempotencyKey: "cleanup-recent-sent", status: "sent", bodyCiphertextOrBody: "recent sent body", bodyClearedAt: null, failedAt: null },
    ]);
  });

  it("writes metric snapshots and a scheduled worker heartbeat", async () => {
    const user = await prisma.user.create({
      data: {
        providerUserHash: "scheduled-metric-user",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
      },
    });
    await prisma.messageOutbox.createMany({
      data: [
        {
          recipientUserId: user.id,
          idempotencyKey: "scheduled-metric-pending",
          status: "pending",
          nextAttemptAt: now,
        },
        {
          recipientUserId: user.id,
          idempotencyKey: "scheduled-metric-expired",
          status: "provider_window_expired",
          nextAttemptAt: now,
        },
      ],
    });
    await prisma.appError.create({
      data: {
        source: "outbox",
        severity: "error",
        fingerprint: "scheduled-metric-active-error",
        message: "active error",
      },
    });
    await prisma.scheduledJob.create({
      data: {
        type: "metric_snapshot",
        runAt: now,
        idempotencyKey: "scheduled-metric-snapshot",
      },
    });

    await expect(processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 })).resolves.toEqual({
      processed: 1,
      completed: 1,
      failed: 0,
    });

    await expect(prisma.metricSnapshot.findFirstOrThrow()).resolves.toMatchObject({
      bucketStart: now,
      bucketSize: "hour",
      waitingUsers: 1,
      matchingEnabledUsers: 1,
      outboxPending: 1,
      providerWindowExpiredCount: 1,
      reportCount: 0,
      blockedCount: 0,
      errorCount: 1,
    });
    await expect(prisma.workerHeartbeat.findUniqueOrThrow({ where: { workerName: "scheduled-jobs" } })).resolves.toMatchObject({
      workerName: "scheduled-jobs",
      status: "ok",
      lastSeenAt: now,
      metadataJson: { processed: 1, completed: 1, failed: 0 },
    });
  });

  it("upserts repeated metric snapshots for the same hour bucket", async () => {
    await prisma.scheduledJob.create({
      data: {
        type: "metric_snapshot",
        runAt: now,
        idempotencyKey: "scheduled-metric-upsert-first",
      },
    });
    await processScheduledJobs({ now, limit: 10, cooldownSeconds: 60 });
    await prisma.scheduledJob.deleteMany();

    const laterSameHour = new Date("2026-06-30T10:02:00.000Z");
    await prisma.user.create({
      data: {
        providerUserHash: "scheduled-metric-upsert-waiting",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        type: "metric_snapshot",
        runAt: laterSameHour,
        idempotencyKey: "scheduled-metric-upsert-second",
      },
    });

    await processScheduledJobs({ now: laterSameHour, limit: 10, cooldownSeconds: 60 });

    await expect(prisma.metricSnapshot.count()).resolves.toBe(1);
    await expect(prisma.metricSnapshot.findFirstOrThrow()).resolves.toMatchObject({
      bucketStart: now,
      bucketSize: "hour",
      waitingUsers: 1,
    });
  });
});
