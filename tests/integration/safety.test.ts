import { createHash } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { closeForLeave, reportConnection, submitEcho } from "../../src/domain/safety";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";

const now = new Date("2026-06-30T10:00:00.000Z");

async function cleanDatabase() {
  await prisma.rateLimitEvent.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
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
    },
  });
}

async function createActiveConnection(userAId: string, userBId: string) {
  return prisma.connection.create({
    data: {
      userAId,
      userBId,
      state: "active",
      startedAt: now,
    },
  });
}

async function createClosedConnection(userAId: string, userBId: string) {
  return prisma.connection.create({
    data: {
      userAId,
      userBId,
      state: "closed",
      closeReason: "timeout",
      startedAt: now,
      closedAt: now,
    },
  });
}

function orderedPair(userAId: string, userBId: string) {
  return userAId < userBId
    ? { userLowId: userAId, userHighId: userBId }
    : { userLowId: userBId, userHighId: userAId };
}

describe("safety actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("leave closes the active connection, blocks the pair, and moves both users to cooldown", async () => {
    const leavingUser = await createMatchedUser("safety-leave-actor", false);
    const otherUser = await createMatchedUser("safety-leave-other", false);
    const connection = await createActiveConnection(leavingUser.id, otherUser.id);

    await closeForLeave({
      connectionId: connection.id,
      actorUserId: leavingUser.id,
      now,
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
      closedAt: now,
    });
    await expect(prisma.pairBlock.findUnique({ where: { userLowId_userHighId: orderedPair(leavingUser.id, otherUser.id) } })).resolves.toMatchObject({
      reason: "left",
    });

    const users = await prisma.user.findMany({
      where: { id: { in: [leavingUser.id, otherUser.id] } },
      orderBy: { providerUserHash: "asc" },
      select: { state: true, matchingEnabled: true },
    });
    expect(users).toEqual([
      { state: "cooldown", matchingEnabled: false },
      { state: "cooldown", matchingEnabled: false },
    ]);
  });

  it("creates leave notifications atomically and keeps a repeated leave idempotent", async () => {
    const leavingUser = await createMatchedUser("safety-leave-notify-actor", false);
    const otherUser = await createMatchedUser("safety-leave-notify-other", false);
    const connection = await createActiveConnection(leavingUser.id, otherUser.id);
    const notifications = {
      actorIdempotencyKey: "safety-leave-notify:actor",
      actorBody: voice.leaveConfirmed(),
      peerIdempotencyKey: "safety-leave-notify:peer",
      peerBody: voice.partnerLeft(),
    };

    await closeForLeave({
      connectionId: connection.id,
      actorUserId: leavingUser.id,
      now,
      notifications,
    });
    await closeForLeave({
      connectionId: connection.id,
      actorUserId: leavingUser.id,
      now: new Date(now.getTime() + 1),
      notifications,
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "awaiting_echo",
      closeReason: "left",
      closedAt: now,
    });
    await expect(prisma.pairBlock.count()).resolves.toBe(1);
    await expect(prisma.scheduledJob.count({ where: { type: "cooldown_release" } })).resolves.toBe(2);

    const messages = await prisma.messageOutbox.findMany({
      where: { connectionId: connection.id },
      orderBy: { idempotencyKey: "asc" },
      select: { recipientUserId: true, idempotencyKey: true, bodyCiphertextOrBody: true },
    });
    expect(messages).toEqual([
      {
        recipientUserId: leavingUser.id,
        idempotencyKey: "safety-leave-notify:actor",
        bodyCiphertextOrBody: voice.leaveConfirmed(),
      },
      {
        recipientUserId: otherUser.id,
        idempotencyKey: "safety-leave-notify:peer",
        bodyCiphertextOrBody: voice.partnerLeft(),
      },
    ]);
  });

  it("schedules cooldown release when a user leaves an active connection", async () => {
    await withEnv({ COOLDOWN_SECONDS: "30" }, async () => {
      const leavingUser = await createMatchedUser("safety-leave-cooldown-actor", false);
      const otherUser = await createMatchedUser("safety-leave-cooldown-other", false);
      const connection = await createActiveConnection(leavingUser.id, otherUser.id);

      await closeForLeave({
        connectionId: connection.id,
        actorUserId: leavingUser.id,
        now,
      });

      const jobs = await prisma.scheduledJob.findMany({
        where: { type: "cooldown_release" },
      });
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: leavingUser.id, runAt: new Date("2026-06-30T10:00:30.000Z"), status: "pending" }),
        expect.objectContaining({ userId: otherUser.id, runAt: new Date("2026-06-30T10:00:30.000Z"), status: "pending" }),
      ]));
      expect(jobs.map((job) => job.idempotencyKey).sort()).toEqual([
        `manual-left:${connection.id}:cooldown-release:${leavingUser.id}`,
        `manual-left:${connection.id}:cooldown-release:${otherUser.id}`,
      ].sort());
    });
  });

  it("report keeps non-blocked users eligible for future random matching", async () => {
    const reporter = await createMatchedUser("safety-report-open-reporter");
    const reported = await createMatchedUser("safety-report-open-reported");
    const connection = await createActiveConnection(reporter.id, reported.id);

    await reportConnection({
      connectionId: connection.id,
      reporterUserId: reporter.id,
      reason: "user_requested",
      now,
    });

    const users = await prisma.user.findMany({
      where: { id: { in: [reporter.id, reported.id] } },
      orderBy: { providerUserHash: "asc" },
      select: { state: true, matchingEnabled: true },
    });
    expect(users).toEqual([
      { state: "cooldown", matchingEnabled: true },
      { state: "cooldown", matchingEnabled: true },
    ]);
  });

  it("schedules cooldown release when a user reports an active connection", async () => {
    await withEnv({ COOLDOWN_SECONDS: "45" }, async () => {
      const reporter = await createMatchedUser("safety-report-cooldown-reporter", false);
      const reported = await createMatchedUser("safety-report-cooldown-reported", false);
      const connection = await createActiveConnection(reporter.id, reported.id);

      await reportConnection({
        connectionId: connection.id,
        reporterUserId: reporter.id,
        reason: "user_requested",
        now,
      });

      const jobs = await prisma.scheduledJob.findMany({
        where: { type: "cooldown_release" },
      });
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: reporter.id, runAt: new Date("2026-06-30T10:00:45.000Z"), status: "pending" }),
        expect.objectContaining({ userId: reported.id, runAt: new Date("2026-06-30T10:00:45.000Z"), status: "pending" }),
      ]));
      expect(jobs.map((job) => job.idempotencyKey).sort()).toEqual([
        `manual-reported:${connection.id}:cooldown-release:${reported.id}`,
        `manual-reported:${connection.id}:cooldown-release:${reporter.id}`,
      ].sort());
    });
  });

  it("does not reactivate a closed connection when a user leaves late", async () => {
    const leavingUser = await prisma.user.create({
      data: { providerUserHash: "safety-late-leave-actor", state: "available", matchingEnabled: true },
    });
    const otherUser = await prisma.user.create({
      data: { providerUserHash: "safety-late-leave-other", state: "available", matchingEnabled: true },
    });
    const connection = await createClosedConnection(leavingUser.id, otherUser.id);

    await closeForLeave({
      connectionId: connection.id,
      actorUserId: leavingUser.id,
      now: new Date(now.getTime() + 1),
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "closed",
      closeReason: "timeout",
      closedAt: now,
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [leavingUser.id, otherUser.id] } },
      orderBy: { providerUserHash: "asc" },
      select: { state: true, matchingEnabled: true },
    });
    expect(users).toEqual([
      { state: "available", matchingEnabled: true },
      { state: "available", matchingEnabled: true },
    ]);
    await expect(prisma.pairBlock.count()).resolves.toBe(0);
  });

  it("rejects leave, report, and echo from blocked users", async () => {
    const blockedUser = await prisma.user.create({
      data: { providerUserHash: "safety-blocked-actor", state: "blocked", matchingEnabled: false, blockedAt: now },
    });
    const otherUser = await prisma.user.create({
      data: { providerUserHash: "safety-blocked-other", state: "matched", matchingEnabled: true },
    });
    const activeConnection = await createActiveConnection(blockedUser.id, otherUser.id);
    const echoConnection = await prisma.connection.create({
      data: {
        userAId: blockedUser.id,
        userBId: otherUser.id,
        state: "awaiting_echo",
        closeReason: "timeout",
        startedAt: now,
        closedAt: now,
      },
    });

    await expect(closeForLeave({ connectionId: activeConnection.id, actorUserId: blockedUser.id, now })).rejects.toThrow("actor_blocked");
    await expect(reportConnection({ connectionId: activeConnection.id, reporterUserId: blockedUser.id, reason: "user_requested", now })).rejects.toThrow("actor_blocked");
    await expect(submitEcho({ connectionId: echoConnection.id, fromUserId: blockedUser.id, body: "late echo", now })).rejects.toThrow("actor_blocked");

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: activeConnection.id } })).resolves.toMatchObject({
      state: "active",
      closeReason: null,
      closedAt: null,
    });
    await expect(prisma.report.count()).resolves.toBe(0);
    await expect(prisma.echo.count()).resolves.toBe(0);
    await expect(prisma.pairBlock.count()).resolves.toBe(0);
  });

  it("does not reactivate a closed connection when a user reports late", async () => {
    const reporter = await prisma.user.create({
      data: { providerUserHash: "safety-late-report-reporter", state: "available", matchingEnabled: true },
    });
    const reported = await prisma.user.create({
      data: { providerUserHash: "safety-late-report-reported", state: "available", matchingEnabled: true },
    });
    const connection = await createClosedConnection(reporter.id, reported.id);

    await reportConnection({
      connectionId: connection.id,
      reporterUserId: reporter.id,
      reason: "user_requested",
      now: new Date(now.getTime() + 1),
    });

    await expect(prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({
      state: "closed",
      closeReason: "timeout",
      closedAt: now,
    });
    await expect(prisma.report.count({ where: { reportedUserId: reported.id } })).resolves.toBe(1);
  });

  it("blocks a user after three distinct reporters", async () => {
    const reportedUser = await createMatchedUser("safety-reported");
    const reporters = await Promise.all([
      createMatchedUser("safety-reporter-1"),
      createMatchedUser("safety-reporter-2"),
      createMatchedUser("safety-reporter-3"),
    ]);

    for (const [index, reporter] of reporters.entries()) {
      await prisma.user.updateMany({
        where: { id: { in: [reportedUser.id, reporter.id] } },
        data: { state: "matched", matchingEnabled: true },
      });
      const connection = await createActiveConnection(reporter.id, reportedUser.id);

      await reportConnection({
        connectionId: connection.id,
        reporterUserId: reporter.id,
        reason: "user_requested",
        now: new Date(now.getTime() + index),
      });

      if (index < reporters.length - 1) {
        await prisma.connection.update({
          where: { id: connection.id },
          data: { state: "closed" },
        });
      }
    }

    await expect(prisma.report.count({ where: { reportedUserId: reportedUser.id } })).resolves.toBe(3);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: reportedUser.id },
        select: { state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toEqual({
      state: "blocked",
      matchingEnabled: false,
      blockedAt: new Date(now.getTime() + 2),
    });
  });

  it("blocks a user when concurrent reports cross the threshold", async () => {
    const reportedUser = await prisma.user.create({
      data: { providerUserHash: "safety-concurrent-reported", state: "available", matchingEnabled: true },
    });
    const priorReporter = await prisma.user.create({ data: { providerUserHash: "safety-concurrent-prior" } });
    const priorConnection = await createClosedConnection(priorReporter.id, reportedUser.id);
    await prisma.report.create({
      data: {
        reporterUserId: priorReporter.id,
        reportedUserId: reportedUser.id,
        connectionId: priorConnection.id,
        reason: "user_requested",
        createdAt: now,
      },
    });

    const reporterA = await prisma.user.create({ data: { providerUserHash: "safety-concurrent-a" } });
    const reporterB = await prisma.user.create({ data: { providerUserHash: "safety-concurrent-b" } });
    const connectionA = await createClosedConnection(reporterA.id, reportedUser.id);
    const connectionB = await createClosedConnection(reporterB.id, reportedUser.id);

    const results = await Promise.allSettled([
      reportConnection({
        connectionId: connectionA.id,
        reporterUserId: reporterA.id,
        reason: "user_requested",
        now: new Date(now.getTime() + 1),
      }),
      reportConnection({
        connectionId: connectionB.id,
        reporterUserId: reporterB.id,
        reason: "user_requested",
        now: new Date(now.getTime() + 2),
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    await expect(prisma.report.count({ where: { reportedUserId: reportedUser.id } })).resolves.toBe(3);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: reportedUser.id },
        select: { state: true, matchingEnabled: true, blockedAt: true },
      }),
    ).resolves.toMatchObject({
      state: "blocked",
      matchingEnabled: false,
      blockedAt: expect.any(Date),
    });
  });

  it("allows only one concurrent leave or report to close and notify the connection", async () => {
    const leavingUser = await createMatchedUser("safety-race-leave-user", false);
    const reportingUser = await createMatchedUser("safety-race-report-user", false);
    const connection = await createActiveConnection(leavingUser.id, reportingUser.id);

    const results = await Promise.allSettled([
      closeForLeave({
        connectionId: connection.id,
        actorUserId: leavingUser.id,
        now,
        notifications: {
          actorIdempotencyKey: "safety-race-leave:actor",
          actorBody: voice.leaveConfirmed(),
          peerIdempotencyKey: "safety-race-leave:peer",
          peerBody: voice.partnerLeft(),
        },
      }),
      reportConnection({
        connectionId: connection.id,
        reporterUserId: reportingUser.id,
        reason: "user_requested",
        now: new Date(now.getTime() + 1),
        notifications: {
          actorIdempotencyKey: "safety-race-report:actor",
          actorBody: voice.reportConfirmed(),
          peerIdempotencyKey: "safety-race-report:peer",
          peerBody: voice.peerEnded(),
        },
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);

    const closedConnection = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(closedConnection.state).toBe("awaiting_echo");
    expect(["left", "reported"]).toContain(closedConnection.closeReason);

    const messages = await prisma.messageOutbox.findMany({
      where: { connectionId: connection.id },
      orderBy: { idempotencyKey: "asc" },
      select: { idempotencyKey: true, bodyCiphertextOrBody: true },
    });
    expect(messages).toHaveLength(2);
    if (closedConnection.closeReason === "left") {
      expect(messages).toEqual([
        { idempotencyKey: "safety-race-leave:actor", bodyCiphertextOrBody: voice.leaveConfirmed() },
        { idempotencyKey: "safety-race-leave:peer", bodyCiphertextOrBody: voice.partnerLeft() },
      ]);
    } else {
      expect(messages).toEqual([
        { idempotencyKey: "safety-race-report:actor", bodyCiphertextOrBody: voice.reportConfirmed() },
        { idempotencyKey: "safety-race-report:peer", bodyCiphertextOrBody: voice.peerEnded() },
      ]);
    }

    await expect(prisma.report.count({ where: { reportedUserId: leavingUser.id } })).resolves.toBe(1);
    await expect(prisma.scheduledJob.count({ where: { type: "cooldown_release" } })).resolves.toBe(2);
  });

  it("allows one echo per user and rejects a second echo from the same user", async () => {
    const fromUser = await createMatchedUser("safety-echo-from");
    const toUser = await createMatchedUser("safety-echo-to");
    const connection = await prisma.connection.create({
      data: {
        userAId: fromUser.id,
        userBId: toUser.id,
        state: "awaiting_echo",
        closeReason: "timeout",
        closedAt: now,
      },
    });

    await expect(
      submitEcho({
        connectionId: connection.id,
        fromUserId: fromUser.id,
        body: "Thanks for the conversation.",
        now,
      }),
    ).resolves.toMatchObject({
      connectionId: connection.id,
      fromUserId: fromUser.id,
      toUserId: toUser.id,
      body: "[redacted]",
    });
    const bodyDigest = createHash("sha256").update("Thanks for the conversation.").digest("hex");
    await expect(prisma.echo.findFirstOrThrow()).resolves.toMatchObject({
      body: expect.not.stringContaining("Thanks for the conversation."),
    });
    await expect(prisma.echo.findFirstOrThrow()).resolves.toMatchObject({
      body: expect.not.stringContaining(bodyDigest),
    });

    await expect(
      submitEcho({
        connectionId: connection.id,
        fromUserId: fromUser.id,
        body: "One more thought.",
        now,
      }),
    ).rejects.toThrow("echo_already_submitted");
    await expect(prisma.echo.count({ where: { connectionId: connection.id, fromUserId: fromUser.id } })).resolves.toBe(1);
  });

  it.each(["left", "reported", "provider_expired"] as const)("rejects echo after %s endings because it would not reach the peer", async (closeReason) => {
    const fromUser = await createMatchedUser(`safety-no-echo-${closeReason}-from`);
    const toUser = await createMatchedUser(`safety-no-echo-${closeReason}-to`);
    const connection = await prisma.connection.create({
      data: {
        userAId: fromUser.id,
        userBId: toUser.id,
        state: "awaiting_echo",
        closeReason,
        closedAt: now,
      },
    });

    await expect(
      submitEcho({
        connectionId: connection.id,
        fromUserId: fromUser.id,
        body: "This should not be accepted.",
        now,
      }),
    ).rejects.toThrow("echo_not_allowed");
    await expect(prisma.echo.count({ where: { connectionId: connection.id } })).resolves.toBe(0);
  });
});
