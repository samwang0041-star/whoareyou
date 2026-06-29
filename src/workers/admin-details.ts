import { createHmac } from "crypto";
import type { ConnectionState, OutboxStatus, UserState } from "@prisma/client";
import { prisma } from "../storage/prisma";

const connectionListLimit = 50;
const nearBlockThreshold = 3;
const nearBlockFloor = 2;

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
  outbox: OutboxSummary;
  providerWindowExpiredCount: number;
  activeAppErrors: number;
  activeAppErrorsBySeverity: Array<{ severity: string; count: number }>;
  workerHeartbeatCount: number;
  workerHeartbeats: Array<{
    workerName: string;
    status: string;
    lastSeenAt: string;
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
    outboxSummary: summarizeOutbox(connection.outboxMessages),
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
  const [
    callbackRows,
    outboxRows,
    activeAppErrors,
    activeErrorRows,
    workerHeartbeats,
  ] = await Promise.all([
    prisma.inboundDedupe.findMany({ select: { status: true } }),
    prisma.messageOutbox.findMany({ select: { status: true } }),
    prisma.appError.count({ where: { resolvedAt: null } }),
    prisma.appError.findMany({ where: { resolvedAt: null }, select: { severity: true } }),
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
  const callbacksByStatus = countBy(callbackRows, (row) => row.status);
  const outbox = summarizeOutbox(outboxRows);

  return {
    generatedAt: new Date().toISOString(),
    callbacksTotal: callbackRows.length,
    callbackDuplicates: callbacksByStatus.get("duplicate") ?? 0,
    callbackFailed: callbacksByStatus.get("failed") ?? 0,
    callbacksByStatus: toSortedCountRows(callbacksByStatus, "status"),
    outbox,
    providerWindowExpiredCount: outbox.providerWindowExpired,
    activeAppErrors,
    activeAppErrorsBySeverity: toSortedCountRows(countBy(activeErrorRows, (row) => row.severity), "severity"),
    workerHeartbeatCount: workerHeartbeats.length,
    workerHeartbeats: workerHeartbeats.map((heartbeat) => ({
      workerName: heartbeat.workerName,
      status: heartbeat.status,
      lastSeenAt: toIso(heartbeat.lastSeenAt),
      metadataPresent: heartbeat.metadataJson !== null,
    })),
  };
}

export async function getSafetyMetrics(): Promise<SafetyMetrics> {
  const [reports, blockedUsers, closeReasonRows] = await Promise.all([
    prisma.report.findMany({
      select: {
        reason: true,
        reported: {
          select: {
            id: true,
            providerUserHash: true,
            state: true,
          },
        },
      },
    }),
    prisma.user.count({ where: { state: "blocked" } }),
    prisma.connection.findMany({
      where: { closeReason: { not: null } },
      select: { closeReason: true },
    }),
  ]);

  const reportsByReason = countBy(reports, (report) => report.reason);
  const reportsByUser = new Map<string, { anonymousId: string; reportCount: number; state: UserState }>();
  for (const report of reports) {
    const current = reportsByUser.get(report.reported.id);
    reportsByUser.set(report.reported.id, {
      anonymousId: anonymousUserId(report.reported.providerUserHash),
      reportCount: (current?.reportCount ?? 0) + 1,
      state: report.reported.state,
    });
  }
  const nearBlockReportedUsers = Array.from(reportsByUser.values())
    .filter((user) => user.state !== "blocked" && user.reportCount >= nearBlockFloor && user.reportCount < nearBlockThreshold)
    .map((user) => ({ anonymousId: user.anonymousId, reportCount: user.reportCount }))
    .sort((left, right) => right.reportCount - left.reportCount || left.anonymousId.localeCompare(right.anonymousId));

  return {
    generatedAt: new Date().toISOString(),
    totalReports: reports.length,
    blockedUsers,
    nearBlockThreshold,
    nearBlockReportedUserCount: nearBlockReportedUsers.length,
    nearBlockReportedUsers,
    reportsByReason: toSortedCountRows(reportsByReason, "reason"),
    connectionCloseReasons: summarizeCloseReasons(closeReasonRows),
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

function summarizeOutbox(messages: Array<{ status: OutboxStatus }>): OutboxSummary {
  const counts = countBy(messages, (message) => message.status);
  const pending = counts.get("pending") ?? 0;
  const retrying = counts.get("retrying") ?? 0;
  const sending = counts.get("sending") ?? 0;

  return {
    total: messages.length,
    pending,
    retrying,
    sending,
    sent: counts.get("sent") ?? 0,
    failed: counts.get("failed") ?? 0,
    providerWindowExpired: counts.get("provider_window_expired") ?? 0,
    backlog: pending + retrying + sending,
  };
}

function summarizeCloseReasons(rows: Array<{ closeReason: string | null }>): SafetyMetrics["connectionCloseReasons"] {
  const counts = countBy(rows, (row) => row.closeReason ?? "");
  return {
    timeout: counts.get("timeout") ?? 0,
    left: counts.get("left") ?? 0,
    reported: counts.get("reported") ?? 0,
    providerExpired: counts.get("provider_expired") ?? 0,
  };
}

function countBy<T>(items: T[], getKey: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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
