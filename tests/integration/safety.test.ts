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

async function createMatchedUser(providerUserHash: string) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "matched",
      matchingEnabled: true,
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
    const leavingUser = await createMatchedUser("safety-leave-actor");
    const otherUser = await createMatchedUser("safety-leave-other");
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
      body: "Thanks for the conversation.",
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
