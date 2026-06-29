import type { ConnectionState, Prisma, ScheduledJobType } from "@prisma/client";
import { isProviderWindowExpired, shouldSendRenewalPrompt } from "../domain/provider-policy";
import { voice } from "../domain/voice";
import { prisma } from "../storage/prisma";

type ProcessScheduledJobsInput = {
  now: Date;
  limit: number;
  cooldownSeconds: number;
  bodyTtlSeconds?: number;
  maxAttempts?: number;
};

type ScheduledJobTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type ScheduledJobWithConnection = Prisma.ScheduledJobGetPayload<{ include: { connection: true } }>;
type ReminderJobType = Extract<ScheduledJobType, "reminder_10" | "reminder_20" | "reminder_30" | "reminder_40" | "reminder_50">;

const activeReminderStates: ConnectionState[] = ["active", "ending"];

export async function processScheduledJobs(input: ProcessScheduledJobsInput) {
  const maxAttempts = input.maxAttempts ?? envInt("SCHEDULED_JOB_MAX_ATTEMPTS", 3);
  const staleLockedBefore = addSeconds(input.now, -60);
  const jobs = await prisma.scheduledJob.findMany({
    where: {
      OR: [
        { status: "pending" },
        { status: "running", lockedAt: { lte: staleLockedBefore } },
      ],
      runAt: { lte: input.now },
    },
    select: { id: true },
    orderBy: [{ runAt: "asc" }, { id: "asc" }],
    take: input.limit,
  });

  const result = { processed: 0, completed: 0, failed: 0 };

  for (const job of jobs) {
    const claimed = await prisma.scheduledJob.updateMany({
      where: {
        id: job.id,
        runAt: { lte: input.now },
        OR: [
          { status: "pending" },
          { status: "running", lockedAt: { lte: staleLockedBefore } },
        ],
      },
      data: {
        status: "running",
        lockedAt: input.now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) continue;

    result.processed += 1;
    try {
      await prisma.$transaction(async (tx) => {
        const freshJob = await tx.scheduledJob.findUnique({
          where: { id: job.id },
          include: { connection: true },
        });
        if (!freshJob) return;

        if (isReminderJob(freshJob.type)) {
          await processReminderJob(tx, freshJob, freshJob.type, input.now);
        } else if (freshJob.type === "close_connection") {
          await processCloseConnectionJob(tx, freshJob, input.now, input.cooldownSeconds);
        } else if (freshJob.type === "cooldown_release") {
          await processCooldownReleaseJob(tx, freshJob.userId, input.now);
        } else if (freshJob.type === "reachability_renewal_prompt") {
          await processReachabilityRenewalJob(tx, freshJob.idempotencyKey, freshJob.userId, input.now);
        } else if (freshJob.type === "outbox_body_cleanup") {
          await processOutboxBodyCleanupJob(tx, input.now, input.bodyTtlSeconds ?? envInt("OUTBOX_BODY_TTL_SECONDS", 900));
        }

        await tx.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            completedAt: input.now,
          },
        });
      });
      result.completed += 1;
    } catch {
      const currentJob = await prisma.scheduledJob.findUnique({
        where: { id: job.id },
        select: { attempts: true },
      });
      const attempts = currentJob?.attempts ?? maxAttempts;
      const exhausted = attempts >= maxAttempts;
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? "failed" : "pending",
          runAt: exhausted ? undefined : addSeconds(input.now, attempts * 30),
          lockedAt: null,
        },
      });
      result.failed += 1;
    }
  }

  return result;
}

function isReminderJob(type: ScheduledJobType): type is ReminderJobType {
  return type === "reminder_10" || type === "reminder_20" || type === "reminder_30" || type === "reminder_40" || type === "reminder_50";
}

async function processReminderJob(
  tx: ScheduledJobTransaction,
  job: ScheduledJobWithConnection,
  type: ReminderJobType,
  now: Date,
) {
  const connection = job.connection;
  if (!connection || !activeReminderStates.includes(connection.state)) return;

  await tx.$queryRaw`SELECT "id" FROM "Connection" WHERE "id" = ${connection.id} FOR UPDATE`;
  const freshConnection = await tx.connection.findUnique({ where: { id: connection.id } });
  if (!freshConnection || !activeReminderStates.includes(freshConnection.state)) return;

  if (type === "reminder_50") {
    await tx.connection.updateMany({
      where: { id: connection.id, state: "active" },
      data: {
        state: "ending",
        endingAt: now,
      },
    });
  }

  await tx.messageOutbox.createMany({
    data: [freshConnection.userAId, freshConnection.userBId].map((recipientUserId) => ({
      connectionId: freshConnection.id,
      recipientUserId,
      idempotencyKey: `${job.idempotencyKey}:reminder:${recipientUserId}`,
      bodyCiphertextOrBody: reminderBody(type),
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
}

async function processCloseConnectionJob(
  tx: ScheduledJobTransaction,
  job: ScheduledJobWithConnection,
  now: Date,
  cooldownSeconds: number,
) {
  const connection = job.connection;
  if (!connection || !activeReminderStates.includes(connection.state)) return;

  await tx.$queryRaw`SELECT "id" FROM "Connection" WHERE "id" = ${connection.id} FOR UPDATE`;
  const freshConnection = await tx.connection.findUnique({ where: { id: connection.id } });
  if (!freshConnection || !activeReminderStates.includes(freshConnection.state)) return;

  await tx.connection.updateMany({
    where: { id: freshConnection.id, state: { in: activeReminderStates } },
    data: {
      state: "awaiting_echo",
      closeReason: "timeout",
      closedAt: now,
    },
  });
  await tx.user.updateMany({
    where: {
      id: { in: [freshConnection.userAId, freshConnection.userBId] },
      state: { not: "blocked" },
    },
    data: {
      state: "cooldown",
      matchingEnabled: true,
    },
  });
  await tx.messageOutbox.createMany({
    data: [freshConnection.userAId, freshConnection.userBId].map((recipientUserId) => ({
      connectionId: freshConnection.id,
      recipientUserId,
      idempotencyKey: `${job.idempotencyKey}:ended:${recipientUserId}`,
      bodyCiphertextOrBody: voice.ended(),
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
  await tx.scheduledJob.createMany({
    data: [freshConnection.userAId, freshConnection.userBId].map((userId) => ({
      userId,
      type: "cooldown_release",
      runAt: addSeconds(now, cooldownSeconds),
      idempotencyKey: `${job.idempotencyKey}:cooldown-release:${userId}`,
    })),
    skipDuplicates: true,
  });
}

async function processCooldownReleaseJob(tx: ScheduledJobTransaction, userId: string | null, now: Date) {
  if (!userId) return;

  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.state === "blocked") return;

  if (isProviderWindowExpired(now, user.reachableUntil) || user.providerSendQuota <= 0) {
    await markUserUnreachable(tx, user.id);
    return;
  }

  if (user.state === "cooldown") {
    await tx.user.update({
      where: { id: user.id },
      data: {
        state: "available",
        matchingEnabled: true,
      },
    });
  }
}

async function processReachabilityRenewalJob(
  tx: ScheduledJobTransaction,
  idempotencyKey: string,
  userId: string | null,
  now: Date,
) {
  if (!userId) return;

  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.state === "blocked") return;

  if (isProviderWindowExpired(now, user.reachableUntil) || user.providerSendQuota <= 0) {
    await markUserUnreachable(tx, user.id);
    return;
  }

  if (!shouldSendRenewalPrompt(now, user.reachableUntil, envInt("REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES", 60))) {
    return;
  }

  await tx.messageOutbox.createMany({
    data: [
      {
        recipientUserId: user.id,
        idempotencyKey: `${idempotencyKey}:reachability-renewal:${user.id}`,
        bodyCiphertextOrBody: voice.reachabilityRenewal(),
        nextAttemptAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

async function processOutboxBodyCleanupJob(tx: ScheduledJobTransaction, now: Date, bodyTtlSeconds: number) {
  await tx.messageOutbox.updateMany({
    where: {
      status: "sent",
      bodyCiphertextOrBody: { not: null },
      sentAt: { lte: addSeconds(now, -bodyTtlSeconds) },
    },
    data: {
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });
}

async function markUserUnreachable(tx: ScheduledJobTransaction, userId: string) {
  await tx.user.updateMany({
    where: {
      id: userId,
      state: { not: "blocked" },
    },
    data: {
      state: "unreachable",
      matchingEnabled: false,
    },
  });
}

function reminderBody(type: ReminderJobType): string {
  if (type === "reminder_50") return voice.ending();
  return voice.minuteReminder(60 - Number(type.replace("reminder_", "")));
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

if (require.main === module) {
  processScheduledJobs({
    now: new Date(),
    limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
    cooldownSeconds: envInt("COOLDOWN_SECONDS", 60),
  }).finally(() => prisma.$disconnect());
}
