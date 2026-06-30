import { createHmac } from "crypto";
import type { ConnectionState, OutboxStatus, UserState } from "@prisma/client";
import { loadProviderModeConfig } from "../config";
import { prisma } from "../storage/prisma";

const connectionListLimit = 50;
const connectionDetailChildLimit = 50;
const nearBlockListLimit = 50;
const nearBlockThreshold = 3;
const nearBlockFloor = 2;
const openClawUpdatesWorkerName = "openclaw-updates";
const baselineWorkerNames = ["outbox", "scheduled-jobs"];

type AnonymousParticipant = {
  role: "A" | "B";
  anonymousId: string;
  state: UserState;
  matchingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  reachableUntil: string | null;
  blockedAt: string | null;
};

type OutboxSummary = {
  total: number;
  pending: number;
  retrying: number;
  sending: number;
  sent: number;
  failed: number;
  providerWindowExpired: number;
  backlog: number;
};

type HealthOutboxSummary = OutboxSummary & {
  oldestPendingOrRetryingCreatedAt: string | null;
  oldestPendingOrRetryingAgeSeconds: number | null;
};

export type ConnectionListItem = {
  id: string;
  state: ConnectionState;
  startedAt: string;
  endingAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  participantAnonymousIds: [string, string];
  outboxMessageCount: number;
  reportCount: number;
  echoCount: number;
};

export type ConnectionDetail = ConnectionListItem & {
  participants: [AnonymousParticipant, AnonymousParticipant];
  outboxSummary: OutboxSummary;
  outboxMessages: Array<{
    id: string;
    recipientAnonymousId: string;
    status: OutboxStatus;
    retryCount: number;
    nextAttemptAt: string;
    createdAt: string;
    sentAt: string | null;
    failedAt: string | null;
    bodyClearedAt: string | null;
    providerWindowCheckedAt: string | null;
  }>;
  scheduledJobs: Array<{
    id: string;
    type: string;
    status: string;
    attempts: number;
    runAt: string;
    lockedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  }>;
  reports: Array<{
    id: string;
    reporterAnonymousId: string;
    reportedAnonymousId: string;
    reason: string;
    createdAt: string;
  }>;
  echoes: Array<{
    id: string;
    fromAnonymousId: string;
    toAnonymousId: string;
    createdAt: string;
  }>;
};

export type HealthMetrics = {
  generatedAt: string;
  callbacksTotal: number;
  callbackDuplicates: number;
  callbackFailed: number;
  callbacksByStatus: Array<{ status: string; count: number }>;
  outbox: HealthOutboxSummary;
  providerWindowExpiredCount: number;
  activeAppErrors: number;
  activeAppErrorsBySeverity: Array<{ severity: string; count: number }>;
  workerHeartbeatCount: number;
  workerHeartbeats: Array<{
    workerName: string;
    status: string;
    lastSeenAt: string;
    secondsSinceLastSeen: number | null;
    metadataPresent: boolean;
  }>;
};

export type SafetyMetrics = {
  generatedAt: string;
  totalReports: number;
  blockedUsers: number;
  nearBlockThreshold: number;
  nearBlockReportedUserCount: number;
  nearBlockReportedUsers: Array<{ anonymousId: string; reportCount: number }>;
  reportsByReason: Array<{ reason: string; count: number }>;
  connectionCloseReasons: {
    timeout: number;
    left: number;
    reported: number;
    providerExpired: number;
  };
};

export async function getConnectionDetail(connectionId: string): Promise<ConnectionDetail | null> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      state: true,
      startedAt: true,
      endingAt: true,
      closedAt: true,
      closeReason: true,
      userA: {
        select: {
          providerUserHash: true,
          state: true,
          matchingEnabled: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          reachableUntil: true,
          blockedAt: true,
        },
      },
      userB: {
        select: {
          providerUserHash: true,
          state: true,
          matchingEnabled: true,
          createdAt: true,
          updatedAt: true,
          lastSeenAt: true,
          reachableUntil: true,
          blockedAt: true,
        },
      },
      outboxMessages: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: connectionDetailChildLimit,
        select: {
          id: true,
          recipientUserId: true,
          status: true,
          retryCount: true,
          nextAttemptAt: true,
          createdAt: true,
          sentAt: true,
          failedAt: true,
          bodyClearedAt: true,
          providerWindowCheckedAt: true,
        },
      },
      scheduledJobs: {
        orderBy: [{ runAt: "asc" }, { id: "asc" }],
        take: connectionDetailChildLimit,
        select: {
          id: true,
          type: true,
          status: true,
          attempts: true,
          runAt: true,
          lockedAt: true,
          completedAt: true,
          createdAt: true,
        },
      },
      reports: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: connectionDetailChildLimit,
        select: {
          id: true,
          reporterUserId: true,
          reportedUserId: true,
          reason: true,
          createdAt: true,
        },
      },
      echoes: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: connectionDetailChildLimit,
        select: {
          id: true,
          fromUserId: true,
          toUserId: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          outboxMessages: true,
          reports: true,
          echoes: true,
        },
      },
    },
  });

  if (!connection) return null;

  const outboxStatusCounts = await prisma.messageOutbox.groupBy({
    by: ["status"],
    where: { connectionId },
    _count: { _all: true },
  });

  const userIdToAnonymousId = new Map([
    [connection.userAId, anonymousUserId(connection.userA.providerUserHash)],
    [connection.userBId, anonymousUserId(connection.userB.providerUserHash)],
  ]);
  const participantAnonymousIds = [
    userIdToAnonymousId.get(connection.userAId) ?? "u_unknown",
    userIdToAnonymousId.get(connection.userBId) ?? "u_unknown",
  ] as [string, string];

  return {
    id: connection.id,
    state: connection.state,
    startedAt: toIso(connection.startedAt),
    endingAt: nullableIso(connection.endingAt),
    closedAt: nullableIso(connection.closedAt),
    closeReason: connection.closeReason,
    participantAnonymousIds,
    outboxMessageCount: connection._count.outboxMessages,
    reportCount: connection._count.reports,
    echoCount: connection._count.echoes,
    participants: [
      participant("A", connection.userA),
      participant("B", connection.userB),
    ],
    outboxSummary: summarizeOutboxCounts(groupCountMap(outboxStatusCounts, (row) => row.status)),
    outboxMessages: connection.outboxMessages.map((message) => ({
      id: message.id,
      recipientAnonymousId: anonymousIdForUser(userIdToAnonymousId, message.recipientUserId),
      status: message.status,
      retryCount: message.retryCount,
      nextAttemptAt: toIso(message.nextAttemptAt),
      createdAt: toIso(message.createdAt),
      sentAt: nullableIso(message.sentAt),
      failedAt: nullableIso(message.failedAt),
      bodyClearedAt: nullableIso(message.bodyClearedAt),
      providerWindowCheckedAt: nullableIso(message.providerWindowCheckedAt),
    })),
    scheduledJobs: connection.scheduledJobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      runAt: toIso(job.runAt),
      lockedAt: nullableIso(job.lockedAt),
      completedAt: nullableIso(job.completedAt),
      createdAt: toIso(job.createdAt),
    })),
    reports: connection.reports.map((report) => ({
      id: report.id,
      reporterAnonymousId: anonymousIdForUser(userIdToAnonymousId, report.reporterUserId),
      reportedAnonymousId: anonymousIdForUser(userIdToAnonymousId, report.reportedUserId),
      reason: report.reason,
      createdAt: toIso(report.createdAt),
    })),
    echoes: connection.echoes.map((echo) => ({
      id: echo.id,
      fromAnonymousId: anonymousIdForUser(userIdToAnonymousId, echo.fromUserId),
      toAnonymousId: anonymousIdForUser(userIdToAnonymousId, echo.toUserId),
      createdAt: toIso(echo.createdAt),
    })),
  };
}

export async function listConnections(state?: ConnectionState): Promise<ConnectionListItem[]> {
  const connections = await prisma.connection.findMany({
    where: state ? { state } : undefined,
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: connectionListLimit,
    select: {
      id: true,
      state: true,
      startedAt: true,
      endingAt: true,
      closedAt: true,
      closeReason: true,
      userA: { select: { providerUserHash: true } },
      userB: { select: { providerUserHash: true } },
      _count: {
        select: {
          outboxMessages: true,
          reports: true,
          echoes: true,
        },
      },
    },
  });

  return connections.map((connection) => ({
    id: connection.id,
    state: connection.state,
    startedAt: toIso(connection.startedAt),
    endingAt: nullableIso(connection.endingAt),
    closedAt: nullableIso(connection.closedAt),
    closeReason: connection.closeReason,
    participantAnonymousIds: [
      anonymousUserId(connection.userA.providerUserHash),
      anonymousUserId(connection.userB.providerUserHash),
    ],
    outboxMessageCount: connection._count.outboxMessages,
    reportCount: connection._count.reports,
    echoCount: connection._count.echoes,
  }));
}

export async function getHealthMetrics(): Promise<HealthMetrics> {
  const now = new Date();
  const [
    callbackStatusRows,
    duplicateCallbacks,
    outboxStatusRows,
    oldestPendingOrRetrying,
    activeAppErrors,
    activeErrorRows,
    workerHeartbeats,
  ] = await Promise.all([
    prisma.inboundDedupe.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.inboundDedupe.aggregate({ _sum: { duplicateCount: true } }),
    prisma.messageOutbox.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.messageOutbox.findFirst({
      where: { status: { in: ["pending", "retrying"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true },
    }),
    prisma.appError.count({ where: { resolvedAt: null } }),
    prisma.appError.groupBy({
      by: ["severity"],
      where: { resolvedAt: null },
      _count: { _all: true },
    }),
    prisma.workerHeartbeat.findMany({
      orderBy: { workerName: "asc" },
      select: {
        workerName: true,
        status: true,
        lastSeenAt: true,
        metadataJson: true,
      },
    }),
  ]);
  const callbacksByStatus = groupCountMap(callbackStatusRows, (row) => row.status);
  const outbox = summarizeHealthOutboxCounts(groupCountMap(outboxStatusRows, (row) => row.status), oldestPendingOrRetrying, now);
  const normalizedWorkerHeartbeats = normalizeWorkerHeartbeats(workerHeartbeats, now, expectedWorkerNames());

  return {
    generatedAt: now.toISOString(),
    callbacksTotal: sumCounts(callbacksByStatus),
    callbackDuplicates: (callbacksByStatus.get("duplicate") ?? 0) + (duplicateCallbacks._sum.duplicateCount ?? 0),
    callbackFailed: callbacksByStatus.get("failed") ?? 0,
    callbacksByStatus: toSortedCountRows(callbacksByStatus, "status"),
    outbox,
    providerWindowExpiredCount: outbox.providerWindowExpired,
    activeAppErrors,
    activeAppErrorsBySeverity: toSortedCountRows(groupCountMap(activeErrorRows, (row) => row.severity), "severity"),
    workerHeartbeatCount: normalizedWorkerHeartbeats.length,
    workerHeartbeats: normalizedWorkerHeartbeats,
  };
}

export async function getSafetyMetrics(): Promise<SafetyMetrics> {
  const [totalReports, reportsByReasonRows, nearBlockCountRows, nearBlockRows, blockedUsers, closeReasonRows] = await Promise.all([
    prisma.report.count(),
    prisma.report.groupBy({ by: ["reason"], _count: { _all: true } }),
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT report."reportedUserId"
        FROM "Report" report
        INNER JOIN "User" reported_user ON reported_user."id" = report."reportedUserId"
        WHERE reported_user."state" <> 'blocked'
        GROUP BY report."reportedUserId"
        HAVING COUNT(*) >= ${nearBlockFloor} AND COUNT(*) < ${nearBlockThreshold}
      ) near_block
    `,
    prisma.$queryRaw<{ reportedUserId: string; providerUserHash: string; reportCount: number }[]>`
      SELECT
        report."reportedUserId" AS "reportedUserId",
        reported_user."providerUserHash" AS "providerUserHash",
        COUNT(*)::int AS "reportCount"
      FROM "Report" report
      INNER JOIN "User" reported_user ON reported_user."id" = report."reportedUserId"
      WHERE reported_user."state" <> 'blocked'
      GROUP BY report."reportedUserId", reported_user."providerUserHash"
      HAVING COUNT(*) >= ${nearBlockFloor} AND COUNT(*) < ${nearBlockThreshold}
      ORDER BY "reportCount" DESC, reported_user."providerUserHash" ASC
      LIMIT ${nearBlockListLimit}
    `,
    prisma.user.count({ where: { state: "blocked" } }),
    prisma.connection.groupBy({
      by: ["closeReason"],
      where: { closeReason: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const nearBlockReportedUsers = nearBlockRows.map((row) => ({
    anonymousId: anonymousUserId(row.providerUserHash),
    reportCount: row.reportCount,
  }));

  return {
    generatedAt: new Date().toISOString(),
    totalReports,
    blockedUsers,
    nearBlockThreshold,
    nearBlockReportedUserCount: nearBlockCountRows[0]?.count ?? 0,
    nearBlockReportedUsers,
    reportsByReason: toSortedCountRows(groupCountMap(reportsByReasonRows, (row) => row.reason), "reason"),
    connectionCloseReasons: summarizeCloseReasonCounts(groupCountMap(closeReasonRows, (row) => row.closeReason ?? "")),
  };
}

function participant(
  role: "A" | "B",
  user: {
    providerUserHash: string;
    state: UserState;
    matchingEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
    lastSeenAt: Date | null;
    reachableUntil: Date | null;
    blockedAt: Date | null;
  },
): AnonymousParticipant {
  return {
    role,
    anonymousId: anonymousUserId(user.providerUserHash),
    state: user.state,
    matchingEnabled: user.matchingEnabled,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
    lastSeenAt: nullableIso(user.lastSeenAt),
    reachableUntil: nullableIso(user.reachableUntil),
    blockedAt: nullableIso(user.blockedAt),
  };
}

function anonymousUserId(providerUserHash: string): string {
  const key = process.env.ADMIN_TOKEN ?? "whoareyou-admin-anonymous-id-v1";
  return `u_${createHmac("sha256", key).update(providerUserHash).digest("hex").slice(0, 12)}`;
}

function anonymousIdForUser(userIdToAnonymousId: Map<string, string>, userId: string): string {
  return userIdToAnonymousId.get(userId) ?? "u_unknown";
}

function summarizeOutboxCounts(counts: Map<string, number>): OutboxSummary {
  const pending = counts.get("pending") ?? 0;
  const retrying = counts.get("retrying") ?? 0;
  const sending = counts.get("sending") ?? 0;

  return {
    total: sumCounts(counts),
    pending,
    retrying,
    sending,
    sent: counts.get("sent") ?? 0,
    failed: counts.get("failed") ?? 0,
    providerWindowExpired: counts.get("provider_window_expired") ?? 0,
    backlog: pending + retrying + sending,
  };
}

function summarizeHealthOutboxCounts(
  counts: Map<string, number>,
  oldestPendingOrRetrying: { createdAt: Date } | null,
  now: Date,
): HealthOutboxSummary {
  const summary = summarizeOutboxCounts(counts);

  return {
    ...summary,
    oldestPendingOrRetryingCreatedAt: oldestPendingOrRetrying ? toIso(oldestPendingOrRetrying.createdAt) : null,
    oldestPendingOrRetryingAgeSeconds: oldestPendingOrRetrying ? elapsedSeconds(oldestPendingOrRetrying.createdAt, now) : null,
  };
}

function summarizeCloseReasonCounts(counts: Map<string, number>): SafetyMetrics["connectionCloseReasons"] {
  return {
    timeout: counts.get("timeout") ?? 0,
    left: counts.get("left") ?? 0,
    reported: counts.get("reported") ?? 0,
    providerExpired: counts.get("provider_expired") ?? 0,
  };
}

function normalizeWorkerHeartbeats(
  heartbeats: Array<{ workerName: string; status: string; lastSeenAt: Date; metadataJson: unknown }>,
  now: Date,
  expectedNames: string[],
): HealthMetrics["workerHeartbeats"] {
  const byName = new Map(heartbeats.map((heartbeat) => [heartbeat.workerName, heartbeat]));
  const names = [
    ...expectedNames,
    ...heartbeats
      .map((heartbeat) => heartbeat.workerName)
      .filter((workerName) => !expectedNames.includes(workerName))
      .sort(),
  ];

  return names.map((workerName) => {
    const heartbeat = byName.get(workerName);
    if (!heartbeat) {
      return {
        workerName,
        status: "missing",
        lastSeenAt: "",
        secondsSinceLastSeen: null,
        metadataPresent: false,
      };
    }

    const secondsSinceLastSeen = elapsedSeconds(heartbeat.lastSeenAt, now);
    return {
      workerName,
      status: workerHealthStatus(heartbeat.status, secondsSinceLastSeen),
      lastSeenAt: toIso(heartbeat.lastSeenAt),
      secondsSinceLastSeen,
      metadataPresent: heartbeat.metadataJson !== null,
    };
  });
}

function expectedWorkerNames(): string[] {
  return loadProviderModeConfig().PROVIDER_MODE === "openclaw" ? [openClawUpdatesWorkerName, ...baselineWorkerNames] : baselineWorkerNames;
}

function workerHealthStatus(status: string, secondsSinceLastSeen: number): string {
  if (status === "running") return secondsSinceLastSeen > envInt("WORKER_HEARTBEAT_STALE_SECONDS", 60) ? "stale" : "ok";
  if (status !== "ok") return "down";
  return secondsSinceLastSeen > envInt("WORKER_HEARTBEAT_STALE_SECONDS", 60) ? "stale" : "ok";
}

function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function groupCountMap<T extends { _count: { _all: number } }>(items: T[], getKey: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(getKey(item), item._count._all);
  }
  return counts;
}

function sumCounts(counts: Map<string, number>): number {
  return Array.from(counts.values()).reduce((total, count) => total + count, 0);
}

function toSortedCountRows<Key extends string>(
  counts: Map<string, number>,
  keyName: Key,
): Array<Record<Key, string> & { count: number }> {
  return Array.from(counts.entries())
    .map(([key, count]) => ({ [keyName]: key, count }) as Record<Key, string> & { count: number })
    .sort((left, right) => right.count - left.count || left[keyName].localeCompare(right[keyName]));
}

function toIso(date: Date): string {
  return date.toISOString();
}

function nullableIso(date: Date | null): string | null {
  return date ? toIso(date) : null;
}
