import { beforeEach, describe, expect, it } from "vitest";
import { tryMatchUser } from "../../src/domain/matching";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";

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

async function createMatchableUser(providerUserHash: string) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "available",
      matchingEnabled: true,
      reachableUntil,
    },
  });
}

function orderedPair(userAId: string, userBId: string) {
  return userAId < userBId
    ? { userLowId: userAId, userHighId: userBId }
    : { userLowId: userBId, userHighId: userAId };
}

describe("transactional matching", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("matches two reachable available users into one active connection", async () => {
    const currentUser = await createMatchableUser("matching-current-user");
    const candidate = await createMatchableUser("matching-candidate-user");

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result.status).toBe("matched");
    expect(result).toHaveProperty("connectionId");

    if (result.status !== "matched") throw new Error("expected a match");

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: result.connectionId },
    });
    expect(connection).toMatchObject({
      userAId: currentUser.id,
      userBId: candidate.id,
      state: "active",
      startedAt: now,
    });

    const users = await prisma.user.findMany({
      where: { id: { in: [currentUser.id, candidate.id] } },
      orderBy: { providerUserHash: "asc" },
    });
    expect(users.map((user) => user.state)).toEqual(["matched", "matched"]);

    const jobs = await prisma.scheduledJob.findMany({
      where: { connectionId: connection.id },
      orderBy: { runAt: "asc" },
    });
    expect(
      jobs.map((job) => ({
        type: job.type,
        runAt: job.runAt.toISOString(),
        status: job.status,
      })),
    ).toEqual([
      { type: "reminder_10", runAt: "2026-06-30T10:10:00.000Z", status: "pending" },
      { type: "reminder_20", runAt: "2026-06-30T10:20:00.000Z", status: "pending" },
      { type: "reminder_30", runAt: "2026-06-30T10:30:00.000Z", status: "pending" },
      { type: "reminder_40", runAt: "2026-06-30T10:40:00.000Z", status: "pending" },
      { type: "reminder_50", runAt: "2026-06-30T10:50:00.000Z", status: "pending" },
      { type: "close_connection", runAt: "2026-06-30T11:00:00.000Z", status: "pending" },
    ]);

    const outboxMessages = await prisma.messageOutbox.findMany({
      where: { connectionId: connection.id },
      orderBy: { recipientUserId: "asc" },
    });
    expect(outboxMessages).toHaveLength(2);
    expect(outboxMessages.map((message) => message.bodyCiphertextOrBody)).toEqual([
      voice.matchStarted(),
      voice.matchStarted(),
    ]);
    expect(outboxMessages.map((message) => message.status)).toEqual(["pending", "pending"]);
    expect(outboxMessages.map((message) => message.nextAttemptAt.toISOString())).toEqual([
      now.toISOString(),
      now.toISOString(),
    ]);
  });

  it("does not rematch a pair blocked by a pair block", async () => {
    const currentUser = await createMatchableUser("matching-blocked-current");
    const blockedCandidate = await createMatchableUser("matching-blocked-candidate");
    await prisma.pairBlock.create({
      data: {
        ...orderedPair(currentUser.id, blockedCandidate.id),
        reason: "left",
      },
    });

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result).toEqual({ status: "waiting" });

    await expect(prisma.connection.count()).resolves.toBe(0);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: currentUser.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "waiting" });
  });
});
