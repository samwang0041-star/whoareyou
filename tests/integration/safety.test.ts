import { createHash } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { closeForLeave, reportConnection, submitEcho } from "../../src/domain/safety";
import { prisma } from "../../src/storage/prisma";

const now = new Date("2026-06-30T10:00:00.000Z");

async function cleanDatabase() {
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
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
      { state: "cooldown", matchingEnabled: true },
      { state: "cooldown", matchingEnabled: true },
    ]);
  });

  it("report keeps non-blocked users eligible for future random matching", async () => {
    const reporter = await createMatchedUser("safety-report-open-reporter", false);
    const reported = await createMatchedUser("safety-report-open-reported", false);
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
});
