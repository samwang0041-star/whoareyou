import { beforeEach, describe, expect, it } from "vitest";
import { voice } from "../../src/domain/voice";
import { prisma } from "../../src/storage/prisma";
import { processScheduledJobs } from "../../src/workers/scheduled-jobs";

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
  const userA = await createMatchedUser("scheduled-user-a", false);
  const userB = await createMatchedUser("scheduled-user-b", false);
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
        reachableUntil: new Date("2026-06-30T09:59:59.000Z"),
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
});
