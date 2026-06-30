import type { ConnectionState, Prisma, ScheduledJobType } from "@prisma/client";
import { matchWaitingUsers } from "../domain/matching";
import { isProviderWindowExpired, shouldSendRenewalPrompt } from "../domain/provider-policy";
import { voice } from "../domain/voice";
import { prisma } from "../storage/prisma";
import { getAdminOverview, recordAppError, recordWorkerHeartbeat } from "./admin-metrics";

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
const scheduledJobsWorkerName = "scheduled-jobs";
type BeforeScheduledUserStateUpdateHook = (input: {
  reason: "cooldown_release" | "provider_expired_user" | "provider_expired_peers";
  userIds: string[];
}) => Promise<void>;

let beforeScheduledUserStateUpdateHook: BeforeScheduledUserStateUpdateHook | null = null;

export function setBeforeScheduledUserStateUpdateHookForTest(hook: BeforeScheduledUserStateUpdateHook | null) {
  beforeScheduledUserStateUpdateHook = hook;
}

export async function processScheduledJobs(input: ProcessScheduledJobsInput) {
  try {
    const result = await processScheduledJobsBatch(input);
    await recordWorkerHeartbeat({
      workerName: scheduledJobsWorkerName,
      status: "ok",
      now: input.now,
      metadata: result,
    });
    return result;
  } catch (error) {
    const fingerprint = await recordAppError({
      source: scheduledJobsWorkerName,
      error,
      now: input.now,
    });
    await recordWorkerHeartbeat({
      workerName: scheduledJobsWorkerName,
      status: "error",
      now: input.now,
      metadata: { errorFingerprint: fingerprint },
    });
    throw error;
  }
}

async function processScheduledJobsBatch(input: ProcessScheduledJobsInput) {
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
      const claimedJob = await prisma.scheduledJob.findUnique({
        where: { id: job.id },
        select: { type: true },
      });
      if (!claimedJob) continue;
      if (claimedJob.type === "metric_snapshot") {
        await processMetricSnapshotJob(prisma, input.now);
        await prisma.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            completedAt: input.now,
          },
        });
        result.completed += 1;
        continue;
      }

      const completedJob = await prisma.$transaction(async (tx) => {
        const freshJob = await tx.scheduledJob.findUnique({
          where: { id: job.id },
          include: { connection: true },
        });
        if (!freshJob) return null;

        let releasedCapacity = false;
        if (isReminderJob(freshJob.type)) {
          await processReminderJob(tx, freshJob, freshJob.type, input.now);
        } else if (freshJob.type === "close_connection") {
          await processCloseConnectionJob(tx, freshJob, input.now, input.cooldownSeconds);
        } else if (freshJob.type === "cooldown_release") {
          await processCooldownReleaseJob(tx, freshJob, input.now, input.cooldownSeconds);
        } else if (freshJob.type === "reachability_renewal_prompt") {
          releasedCapacity = await processReachabilityRenewalJob(tx, freshJob.idempotencyKey, freshJob.userId, input.now, input.cooldownSeconds);
        } else if (freshJob.type === "outbox_body_cleanup") {
          await processOutboxBodyCleanupJob(tx, input.now, input.bodyTtlSeconds ?? envInt("OUTBOX_BODY_TTL_SECONDS", 900));
        } else if (freshJob.type === "entity_cleanup") {
          await processEntityCleanupJob(tx, input.now);
        }

        await tx.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            completedAt: input.now,
          },
        });
        return { type: freshJob.type, releasedCapacity };
      });
      result.completed += 1;
      if (completedJob && (completedJob.type === "close_connection" || completedJob.type === "cooldown_release" || completedJob.releasedCapacity)) {
        await triggerWaitingMatching(input.now);
      }
    } catch (error) {
      const currentJob = await prisma.scheduledJob.findUnique({
        where: { id: job.id },
        select: { attempts: true, type: true },
      });
      const attempts = currentJob?.attempts ?? maxAttempts;
      const exhausted = attempts >= maxAttempts;
      await recordAppError({
        source: scheduledJobsWorkerName,
        error,
        now: input.now,
        context: {
          jobId: job.id,
          jobType: currentJob?.type ?? "unknown",
          exhausted,
        },
      });
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

  await seedOperationalJobs(input.now);

  return result;
}

async function triggerWaitingMatching(now: Date) {
  try {
    await matchWaitingUsers({ now });
  } catch (error) {
    await recordAppError({
      source: scheduledJobsWorkerName,
      error,
      now,
      context: { phase: "waiting_match_trigger" },
    });
  }
}

async function seedOperationalJobs(now: Date) {
  const operationalInterval = envInt("OPERATIONAL_JOB_INTERVAL_SECONDS", 60);
  const operationalRunAt = nextOperationalRunAt(now, operationalInterval);
  const operationalJobs = ["metric_snapshot", "outbox_body_cleanup"] as const;

  const cleanupInterval = envInt("ENTITY_CLEANUP_INTERVAL_SECONDS", 6 * 60 * 60);
  const cleanupRunAt = nextOperationalRunAt(now, cleanupInterval);
  const cleanupJobs = ["entity_cleanup"] as const;

  await prisma.scheduledJob.createMany({
    data: [
      ...operationalJobs.map((type) => ({
        type,
        runAt: operationalRunAt,
        idempotencyKey: `operational:${type}:${operationalRunAt.toISOString()}`,
      })),
      ...cleanupJobs.map((type) => ({
        type,
        runAt: cleanupRunAt,
        idempotencyKey: `operational:${type}:${cleanupRunAt.toISOString()}`,
      })),
    ],
    skipDuplicates: true,
  });
}

function nextOperationalRunAt(now: Date, intervalSeconds: number): Date {
  const intervalMs = intervalSeconds * 1000;
  const nowMs = now.getTime();
  const nextBucketMs = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  return new Date(nextBucketMs);
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
      connectionId: freshConnection.id,
      userId,
      type: "cooldown_release",
      runAt: addSeconds(now, cooldownSeconds),
      idempotencyKey: `${job.idempotencyKey}:cooldown-release:${userId}`,
    })),
    skipDuplicates: true,
  });
}

async function processCooldownReleaseJob(
  tx: ScheduledJobTransaction,
  job: ScheduledJobWithConnection,
  now: Date,
  cooldownSeconds: number,
) {
  if (!job.userId) return;

  const user = await tx.user.findUnique({ where: { id: job.userId } });
  if (!user || user.state === "blocked") return;
  if (!(await isCurrentCooldownReleaseJob(tx, job, user.id))) return;
  if (user.state !== "cooldown") return;

  if (isProviderWindowExpired(now, user.reachableUntil) || user.providerSendQuota <= 0) {
    await markUserUnreachable(tx, user.id, now, cooldownSeconds);
    return;
  }

  if (!user.matchingEnabled) {
    await runBeforeScheduledUserStateUpdateHook({ reason: "cooldown_release", userIds: [user.id] });
    await tx.user.updateMany({
      where: { id: user.id, state: "cooldown" },
      data: {
        state: "paused",
        matchingEnabled: false,
      },
    });
    return;
  }

  await runBeforeScheduledUserStateUpdateHook({ reason: "cooldown_release", userIds: [user.id] });
  await tx.user.updateMany({
    where: { id: user.id, state: "cooldown" },
    data: {
      state: "available",
      matchingEnabled: true,
    },
  });
}

async function isCurrentCooldownReleaseJob(
  tx: ScheduledJobTransaction,
  job: ScheduledJobWithConnection,
  userId: string,
): Promise<boolean> {
  if (!job.connectionId) return true;

  const connection = job.connection ?? await tx.connection.findUnique({ where: { id: job.connectionId } });
  if (!connection || !isConnectionParticipant(connection, userId) || !connection.closedAt) return false;

  const newerClosedConnection = await tx.connection.findFirst({
    where: {
      id: { not: connection.id },
      closedAt: { gt: connection.closedAt },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true },
  });

  return newerClosedConnection === null;
}

function isConnectionParticipant(connection: { userAId: string; userBId: string }, userId: string): boolean {
  return connection.userAId === userId || connection.userBId === userId;
}

async function processReachabilityRenewalJob(
  tx: ScheduledJobTransaction,
  idempotencyKey: string,
  userId: string | null,
  now: Date,
  cooldownSeconds: number,
): Promise<boolean> {
  if (!userId) return false;

  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.state === "blocked") return false;

  if (isProviderWindowExpired(now, user.reachableUntil) || user.providerSendQuota <= 0) {
    return markUserUnreachable(tx, user.id, now, cooldownSeconds);
  }

  if (!shouldSendRenewalPrompt(now, user.reachableUntil, envInt("REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES", 60))) {
    return false;
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
  return false;
}

async function processOutboxBodyCleanupJob(tx: ScheduledJobTransaction, now: Date, bodyTtlSeconds: number) {
  const cutoff = addSeconds(now, -bodyTtlSeconds);
  await tx.messageOutbox.updateMany({
    where: {
      bodyCiphertextOrBody: { not: null },
      OR: [
        { status: "sent", sentAt: { lte: cutoff } },
        { status: "failed", failedAt: { lte: cutoff } },
        { status: "provider_window_expired", providerWindowCheckedAt: { lte: cutoff } },
      ],
    },
    data: {
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });

  const maxPendingSeconds = envOptionalPositiveInt("OUTBOX_BODY_MAX_PENDING_SECONDS");
  if (!maxPendingSeconds) return;

  await tx.messageOutbox.updateMany({
    where: {
      bodyCiphertextOrBody: { not: null },
      status: { in: ["pending", "retrying"] },
      createdAt: { lte: addSeconds(now, -maxPendingSeconds) },
    },
    data: {
      status: "failed",
      failedAt: now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });
}

const entityCleanupBatchSize = 500;
const cleanableSessionStatuses = ["expired", "superseded", "provider_error"];

type EntityCleanupConfig = {
  sessionRetentionHours: number;
  inboundDedupeRetentionHours: number;
  appErrorRetentionHours: number;
  rateLimitRetentionHours: number;
};

async function processEntityCleanupJob(tx: ScheduledJobTransaction, now: Date) {
  const config: EntityCleanupConfig = {
    sessionRetentionHours: envInt("ENTITY_CLEANUP_SESSION_RETENTION_HOURS", 24),
    inboundDedupeRetentionHours: envInt("ENTITY_CLEANUP_INBOUND_DEDUPE_RETENTION_HOURS", 24 * 7),
    appErrorRetentionHours: envInt("ENTITY_CLEANUP_APP_ERROR_RETENTION_HOURS", 24 * 30),
    rateLimitRetentionHours: envInt("ENTITY_CLEANUP_RATE_LIMIT_RETENTION_HOURS", 24 * 7),
  };

  await deleteExpiredSessions(tx, now, config.sessionRetentionHours);
  await deleteOldInboundDedupe(tx, now, config.inboundDedupeRetentionHours);
  await deleteResolvedAppErrors(tx, now, config.appErrorRetentionHours);
  await deleteOldRateLimitEvents(tx, now, config.rateLimitRetentionHours);
}

async function deleteExpiredSessions(tx: ScheduledJobTransaction, now: Date, retentionHours: number) {
  const cutoff = addSeconds(now, -retentionHours * 60 * 60);
  const expired = await tx.openClawBotSession.findMany({
    where: {
      status: { in: cleanableSessionStatuses },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
    take: entityCleanupBatchSize,
  });
  if (expired.length === 0) return;
  await tx.openClawBotSession.deleteMany({
    where: { id: { in: expired.map((row) => row.id) } },
  });
}

async function deleteOldInboundDedupe(tx: ScheduledJobTransaction, now: Date, retentionHours: number) {
  const cutoff = addSeconds(now, -retentionHours * 60 * 60);
  const oldRows = await tx.inboundDedupe.findMany({
    where: { receivedAt: { lt: cutoff } },
    select: { id: true },
    take: entityCleanupBatchSize,
  });
  if (oldRows.length === 0) return;
  await tx.inboundDedupe.deleteMany({
    where: { id: { in: oldRows.map((row) => row.id) } },
  });
}

async function deleteResolvedAppErrors(tx: ScheduledJobTransaction, now: Date, retentionHours: number) {
  const cutoff = addSeconds(now, -retentionHours * 60 * 60);
  const resolved = await tx.appError.findMany({
    where: {
      resolvedAt: { not: null, lt: cutoff },
    },
    select: { id: true },
    take: entityCleanupBatchSize,
  });
  if (resolved.length === 0) return;
  await tx.appError.deleteMany({
    where: { id: { in: resolved.map((row) => row.id) } },
  });
}

async function deleteOldRateLimitEvents(tx: ScheduledJobTransaction, now: Date, retentionHours: number) {
  const cutoff = addSeconds(now, -retentionHours * 60 * 60);
  const oldEvents = await tx.rateLimitEvent.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: entityCleanupBatchSize,
  });
  if (oldEvents.length === 0) return;
  await tx.rateLimitEvent.deleteMany({
    where: { id: { in: oldEvents.map((row) => row.id) } },
  });
}

async function processMetricSnapshotJob(
  tx: Pick<typeof prisma, "appError" | "messageOutbox" | "metricSnapshot" | "user">,
  now: Date,
) {
  const bucketStart = startOfUtcHour(now);
  const overview = await getAdminOverview({
    now,
    minReachableMinutesToMatch: envInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70),
    renewalPromptBeforeMinutes: envInt("REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES", 60),
  });
  const [activeErrorCount, renewalPromptSentCount, renewalPromptAnsweredCount] = await Promise.all([
    tx.appError.count({ where: { resolvedAt: null } }),
    tx.messageOutbox.count({ where: { idempotencyKey: { contains: ":reachability-renewal:" } } }),
    tx.user.count({ where: { lastUserMessageAt: { gte: bucketStart, lte: now } } }),
  ]);

  const data = {
    bucketStart,
    bucketSize: "hour",
    activeUsers: overview.recentUsers,
    waitingUsers: overview.waitingUsers,
    activeConnections: overview.activeConnections,
    matchingEnabledUsers: overview.matchingEnabledUsers,
    reachableUsers: overview.reachableUsers,
    expiringReachabilityUsers: overview.expiringReachabilityUsers,
    completedConnections: overview.closedConnections,
    oneHourCompletionRate: overview.oneHourCompletionRate,
    renewalPromptSentCount,
    renewalPromptAnsweredCount,
    outboxPending: overview.outboxPending,
    providerWindowExpiredCount: overview.providerWindowExpiredCount,
    scheduledJobLagSeconds: overview.scheduledJobLagSeconds,
    reportCount: overview.reportCount,
    blockedCount: overview.blockedUsers,
    errorCount: activeErrorCount,
  };

  await tx.metricSnapshot.upsert({
    where: {
      bucketStart_bucketSize: {
        bucketStart,
        bucketSize: "hour",
      },
    },
    create: data,
    update: data,
  });
}

async function markUserUnreachable(tx: ScheduledJobTransaction, userId: string, now: Date, cooldownSeconds: number): Promise<boolean> {
  await runBeforeScheduledUserStateUpdateHook({ reason: "provider_expired_user", userIds: [userId] });
  const markedUnreachable = await tx.user.updateMany({
    where: {
      id: userId,
      state: { not: "blocked" },
      OR: [
        { reachableUntil: { lte: now } },
        { providerSendQuota: { lte: 0 } },
      ],
    },
    data: {
      state: "unreachable",
      matchingEnabled: false,
    },
  });
  if (markedUnreachable.count === 0) return false;

  const connections = await tx.connection.findMany({
    where: {
      state: { in: activeReminderStates },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true, userAId: true, userBId: true },
  });

  let closedCount = 0;
  if (connections.length > 0) {
    const connectionIds = connections.map((connection) => connection.id);
    const closed = await tx.connection.updateMany({
      where: {
        id: { in: connectionIds },
        state: { in: activeReminderStates },
      },
      data: {
        state: "awaiting_echo",
        closeReason: "provider_expired",
        closedAt: now,
      },
    });
    closedCount = closed.count;
    await tx.messageOutbox.updateMany({
      where: {
        connectionId: { in: connectionIds },
        status: { in: ["pending", "retrying", "sending"] },
      },
      data: {
        status: "provider_window_expired",
        providerWindowCheckedAt: now,
        bodyCiphertextOrBody: null,
        bodyClearedAt: now,
      },
    });
    await moveReachablePeersToCooldown(tx, connections, userId, now, cooldownSeconds);
  }
  return closedCount > 0;
}

async function moveReachablePeersToCooldown(
  tx: ScheduledJobTransaction,
  connections: { id: string; userAId: string; userBId: string }[],
  unreachableUserId: string,
  now: Date,
  cooldownSeconds: number,
) {
  const peerIds = [
    ...new Set(
      connections.map((connection) =>
        connection.userAId === unreachableUserId ? connection.userBId : connection.userAId,
      ),
    ),
  ];
  if (peerIds.length === 0) return;

  const peers = await tx.user.findMany({
    where: {
      id: { in: peerIds },
      state: { not: "blocked" },
    },
    select: { id: true, reachableUntil: true, providerSendQuota: true },
  });
  const cooldownPeerIds = peers
    .filter((peer) => !isProviderWindowExpired(now, peer.reachableUntil) && peer.providerSendQuota > 0)
    .map((peer) => peer.id);
  const unreachablePeerIds = peers
    .filter((peer) => isProviderWindowExpired(now, peer.reachableUntil) || peer.providerSendQuota <= 0)
    .map((peer) => peer.id);
  await runBeforeScheduledUserStateUpdateHook({ reason: "provider_expired_peers", userIds: peerIds });
  if (unreachablePeerIds.length > 0) {
    await tx.user.updateMany({
      where: {
        id: { in: unreachablePeerIds },
        state: { not: "blocked" },
        OR: [
          { reachableUntil: { lte: now } },
          { providerSendQuota: { lte: 0 } },
        ],
      },
      data: { state: "unreachable", matchingEnabled: false },
    });
  }
  if (cooldownPeerIds.length === 0) return;

  await tx.user.updateMany({
    where: {
      id: { in: cooldownPeerIds },
      state: { not: "blocked" },
      reachableUntil: { gte: now },
      providerSendQuota: { gt: 0 },
    },
    data: { state: "cooldown" },
  });
  const scheduledCooldownPeers = await tx.user.findMany({
    where: {
      id: { in: cooldownPeerIds },
      state: "cooldown",
      reachableUntil: { gte: now },
      providerSendQuota: { gt: 0 },
    },
    select: { id: true },
  });
  const scheduledCooldownPeerIds = scheduledCooldownPeers.map((peer) => peer.id);
  if (scheduledCooldownPeerIds.length === 0) return;

  await tx.scheduledJob.createMany({
    data: connections.flatMap((connection) => {
      const peerId = connection.userAId === unreachableUserId ? connection.userBId : connection.userAId;
      if (!scheduledCooldownPeerIds.includes(peerId)) return [];

      return [{
        connectionId: connection.id,
        userId: peerId,
        type: "cooldown_release" as const,
        runAt: addSeconds(now, cooldownSeconds),
        idempotencyKey: `provider-expired:${connection.id}:cooldown-release:${peerId}`,
      }];
    }),
    skipDuplicates: true,
  });
  await tx.messageOutbox.createMany({
    data: connections.flatMap((connection) => {
      const peerId = connection.userAId === unreachableUserId ? connection.userBId : connection.userAId;
      if (!scheduledCooldownPeerIds.includes(peerId)) return [];

      return [{
        connectionId: connection.id,
        recipientUserId: peerId,
        idempotencyKey: `provider-expired:${connection.id}:peer-notice:${peerId}`,
        bodyCiphertextOrBody: voice.closedNoRelay(),
        nextAttemptAt: now,
      }];
    }),
    skipDuplicates: true,
  });
}

async function runBeforeScheduledUserStateUpdateHook(input: Parameters<BeforeScheduledUserStateUpdateHook>[0]) {
  if (beforeScheduledUserStateUpdateHook) {
    await beforeScheduledUserStateUpdateHook(input);
  }
}

function reminderBody(type: ReminderJobType): string {
  if (type === "reminder_50") return voice.ending();
  return voice.minuteReminder(60 - Number(type.replace("reminder_", "")));
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function startOfUtcHour(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envOptionalPositiveInt(name: string): number | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function runScheduledWorkerLoop() {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      await processScheduledJobs({
        now: new Date(),
        limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
        cooldownSeconds: envInt("COOLDOWN_SECONDS", 60),
      });
    } catch (error) {
      console.error(error);
    }
    await sleep(envInt("WORKER_POLL_INTERVAL_MS", 5000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const run = process.env.WORKER_LOOP === "1"
    ? runScheduledWorkerLoop()
    : processScheduledJobs({
        now: new Date(),
        limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
        cooldownSeconds: envInt("COOLDOWN_SECONDS", 60),
      });
  run.finally(() => prisma.$disconnect());
}
