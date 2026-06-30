import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryMatchUser } from "../../src/domain/matching";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";

const now = new Date("2026-06-30T10:00:00.000Z");
const reachableUntil = new Date("2026-06-30T12:00:00.000Z");

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

async function createMatchableUser(providerUserHash: string, data: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  return prisma.user.create({
    data: {
      providerUserHash,
      state: "available",
      matchingEnabled: true,
      reachableUntil,
      ...data,
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

  it("removes unsent waiting prompts when a waiting user gets matched", async () => {
    const currentUser = await createMatchableUser("matching-current-stale-waiting");
    const waitingCandidate = await createMatchableUser("matching-candidate-stale-waiting", {
      state: "waiting",
    });
    await prisma.messageOutbox.create({
      data: {
        recipientUserId: waitingCandidate.id,
        idempotencyKey: "candidate-open:waiting",
        bodyCiphertextOrBody: voice.waitingFull(),
        nextAttemptAt: new Date(now.getTime() - 1_000),
      },
    });

    await expect(
      tryMatchUser({
        userId: currentUser.id,
        now,
        minReachableMinutesToMatch: 60,
      }),
    ).resolves.toMatchObject({ status: "matched" });

    await expect(
      prisma.messageOutbox.findUnique({
        where: { idempotencyKey: "candidate-open:waiting" },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.messageOutbox.count({
        where: {
          bodyCiphertextOrBody: voice.matchStarted(),
        },
      }),
    ).resolves.toBe(2);
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

  it("randomizes eligible candidates instead of always matching the oldest waiting user", async () => {
    const currentUser = await createMatchableUser("matching-random-current");
    const oldestCandidate = await createMatchableUser("matching-random-oldest");
    const newerCandidate = await createMatchableUser("matching-random-newer");
    await prisma.user.update({
      where: { id: oldestCandidate.id },
      data: { updatedAt: new Date("2026-06-30T09:00:00.000Z") },
    });
    await prisma.user.update({
      where: { id: newerCandidate.id },
      data: { updatedAt: new Date("2026-06-30T09:30:00.000Z") },
    });

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
      random: () => 0,
    });

    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected a match");
    await expect(prisma.connection.findUniqueOrThrow({ where: { id: result.connectionId } })).resolves.toMatchObject({
      userAId: currentUser.id,
      userBId: newerCandidate.id,
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: oldestCandidate.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "available" });
  });

  it("handles simultaneous match attempts for the same pair with one connection", async () => {
    const currentUser = await createMatchableUser("matching-race-current");
    const candidate = await createMatchableUser("matching-race-candidate");

    const results = await Promise.allSettled([
      tryMatchUser({
        userId: currentUser.id,
        now,
        minReachableMinutesToMatch: 60,
      }),
      tryMatchUser({
        userId: candidate.id,
        now,
        minReachableMinutesToMatch: 60,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);

    const values = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(values.map((result) => result.status).sort()).toEqual(["matched", "not_eligible"]);

    await expect(prisma.connection.count()).resolves.toBe(1);
  });

  it("marks an insufficiently reachable user unreachable and disables matching", async () => {
    const currentUser = await prisma.user.create({
      data: {
        providerUserHash: "matching-short-reachability",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T10:30:00.000Z"),
      },
    });

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result).toEqual({ status: "not_eligible" });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: currentUser.id },
        select: { state: true, matchingEnabled: true },
      }),
    ).resolves.toEqual({ state: "unreachable", matchingEnabled: false });
    await expect(prisma.connection.count()).resolves.toBe(0);
  });

  it("returns not eligible for a user with an existing active connection", async () => {
    const currentUser = await createMatchableUser("matching-existing-current");
    const connectedUser = await createMatchableUser("matching-existing-connected");
    await createMatchableUser("matching-existing-candidate");
    await prisma.connection.create({
      data: {
        userAId: currentUser.id,
        userBId: connectedUser.id,
        state: "active",
        startedAt: now,
      },
    });

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result).toEqual({ status: "not_eligible" });
    await expect(prisma.connection.count()).resolves.toBe(1);
  });

  it("does not create a match or extra waiting user when active and waiting capacity are full", async () => {
    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1", MAX_WAITING_USERS: "1" }, async () => {
      const connectedA = await createMatchableUser("matching-capacity-active-a");
      const connectedB = await createMatchableUser("matching-capacity-active-b");
      await prisma.connection.create({
        data: {
          userAId: connectedA.id,
          userBId: connectedB.id,
          state: "active",
          startedAt: now,
        },
      });
      await prisma.user.create({
        data: {
          providerUserHash: "matching-capacity-waiting",
          state: "waiting",
          matchingEnabled: true,
          reachableUntil,
        },
      });
      const currentUser = await createMatchableUser("matching-capacity-current");

      const result = await tryMatchUser({
        userId: currentUser.id,
        now,
        minReachableMinutesToMatch: 60,
      });

      expect(result).toEqual({ status: "capacity_full" });
      await expect(prisma.connection.count({ where: { state: "active" } })).resolves.toBe(1);
      await expect(prisma.user.count({ where: { state: "waiting" } })).resolves.toBe(1);
      await expect(
        prisma.user.findUniqueOrThrow({
          where: { id: currentUser.id },
          select: { state: true, matchingEnabled: true },
        }),
      ).resolves.toEqual({ state: "paused", matchingEnabled: false });
      await expect(prisma.rateLimitEvent.findFirstOrThrow({ where: { userId: currentUser.id } })).resolves.toMatchObject({
        eventType: "capacity_waiting_full",
        createdAt: now,
      });
    });
  });

  it("queues a user when active capacity is full but waiting capacity is available", async () => {
    await withEnv({ MAX_ACTIVE_CONNECTIONS: "1", MAX_WAITING_USERS: "2" }, async () => {
      const connectedA = await createMatchableUser("matching-active-full-a");
      const connectedB = await createMatchableUser("matching-active-full-b");
      await prisma.connection.create({
        data: {
          userAId: connectedA.id,
          userBId: connectedB.id,
          state: "active",
          startedAt: now,
        },
      });
      const currentUser = await createMatchableUser("matching-active-full-current");

      const result = await tryMatchUser({
        userId: currentUser.id,
        now,
        minReachableMinutesToMatch: 60,
      });

      expect(result).toEqual({ status: "waiting" });
      await expect(
        prisma.user.findUniqueOrThrow({
          where: { id: currentUser.id },
          select: { state: true, matchingEnabled: true },
        }),
      ).resolves.toEqual({ state: "waiting", matchingEnabled: true });
      await expect(prisma.rateLimitEvent.findFirstOrThrow({ where: { userId: currentUser.id } })).resolves.toMatchObject({
        eventType: "capacity_active_full",
        createdAt: now,
      });
    });
  });

  it("returns the final user state when retryable matching races exhaust retries", async () => {
    const waitingUser = await prisma.user.create({
      data: {
        providerUserHash: "matching-fallback-waiting",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil,
      },
    });
    const retryableRace = Object.assign(new Error("serializable race"), { code: "P2034" });
    const waitingTransactionSpy = vi.spyOn(prisma, "$transaction").mockRejectedValue(retryableRace);
    try {
      await expect(
        tryMatchUser({
          userId: waitingUser.id,
          now,
          minReachableMinutesToMatch: 60,
        }),
      ).resolves.toEqual({ status: "waiting" });
      expect(waitingTransactionSpy).toHaveBeenCalledTimes(3);
    } finally {
      waitingTransactionSpy.mockRestore();
    }

    await cleanDatabase();
    const pausedUser = await prisma.user.create({
      data: {
        providerUserHash: "matching-fallback-capacity",
        state: "paused",
        matchingEnabled: false,
        reachableUntil,
      },
    });
    await prisma.rateLimitEvent.create({
      data: {
        userId: pausedUser.id,
        eventType: "capacity_waiting_full",
        createdAt: now,
      },
    });
    const pausedTransactionSpy = vi.spyOn(prisma, "$transaction").mockRejectedValue(retryableRace);
    try {
      await expect(
        tryMatchUser({
          userId: pausedUser.id,
          now,
          minReachableMinutesToMatch: 60,
        }),
      ).resolves.toEqual({ status: "capacity_full" });
      expect(pausedTransactionSpy).toHaveBeenCalledTimes(3);
    } finally {
      pausedTransactionSpy.mockRestore();
    }
  });

  it("allows a user with an awaiting echo connection to match someone new", async () => {
    const currentUser = await createMatchableUser("matching-echo-current");
    const pastUser = await prisma.user.create({
      data: {
        providerUserHash: "matching-echo-past",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil,
      },
    });
    const candidate = await createMatchableUser("matching-echo-candidate");
    await prisma.connection.create({
      data: {
        userAId: currentUser.id,
        userBId: pastUser.id,
        state: "awaiting_echo",
        startedAt: new Date(now.getTime() - 60 * 60_000),
        closedAt: now,
        closeReason: "timeout",
      },
    });

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result.status).toBe("matched");
    if (result.status !== "matched") throw new Error("expected a match");
    await expect(
      prisma.connection.findUniqueOrThrow({
        where: { id: result.connectionId },
      }),
    ).resolves.toMatchObject({
      userAId: currentUser.id,
      userBId: candidate.id,
      state: "active",
    });
  });

  it.each(["blocked", "paused"] as const)("returns not eligible for a %s user", async (state) => {
    const currentUser = await prisma.user.create({
      data: {
        providerUserHash: `matching-${state}-current`,
        state,
        matchingEnabled: true,
        reachableUntil,
      },
    });
    await createMatchableUser(`matching-${state}-candidate`);

    const result = await tryMatchUser({
      userId: currentUser.id,
      now,
      minReachableMinutesToMatch: 60,
    });

    expect(result).toEqual({ status: "not_eligible" });
    await expect(prisma.connection.count()).resolves.toBe(0);
  });
});
