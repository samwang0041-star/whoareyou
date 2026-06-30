import { Prisma, type UserState } from "@prisma/client";
import { prisma } from "../storage/prisma";

export type AdminOverviewInput = {
  now: Date;
  minReachableMinutesToMatch: number;
  renewalPromptBeforeMinutes: number;
};

export type AdminOverview = {
  generatedAt: string;
  scannedUsers: number;
  recentUsers: number;
  matchingEnabledUsers: number;
  openUsers: number;
  reachableUsers: number;
  reachableEntranceUsers: number;
  reachableEntranceRate: number;
  waitingUsers: number;
  activeConnections: number;
  endingConnections: number;
  activeOrEndingConnections: number;
  currentMatchedUsers: number;
  expiringReachabilityUsers: number;
  outboxPending: number;
  outboxSending: number;
  outboxRetrying: number;
  outboxInFlight: number;
  providerWindowExpiredCount: number;
  reportCount: number;
  reportsToday: number;
  blockedUsers: number;
  blockedToday: number;
  closedConnections: number;
  timeoutClosedConnections: number;
  oneHourCompletionRate: number;
  echoedClosedConnections: number;
  echoRate: number;
  scheduledJobLagSeconds: number;
};

const entranceStates: UserState[] = ["available", "waiting"];

export async function recordWorkerHeartbeat(input: {
  workerName: string;
  status: string;
  now: Date;
  metadata?: Record<string, unknown>;
}) {
  await prisma.workerHeartbeat.upsert({
    where: { workerName: input.workerName },
    create: {
      workerName: input.workerName,
      status: input.status,
      lastSeenAt: input.now,
      metadataJson: jsonOrUndefined(input.metadata),
    },
    update: {
      status: input.status,
      lastSeenAt: input.now,
      metadataJson: jsonOrUndefined(input.metadata),
    },
  });
}

export async function recordAppError(input: {
  source: string;
  severity?: string;
  error: unknown;
  now: Date;
  context?: Record<string, unknown>;
}): Promise<string> {
  const message = errorMessage(input.error);
  const fingerprint = `${input.source}:${message}`;
  const data = {
    source: input.source,
    severity: input.severity ?? "error",
    fingerprint,
    message,
    contextJson: jsonOrUndefined(input.context),
    createdAt: input.now,
    lastSeenAt: input.now,
  };

  try {
    await prisma.appError.create({ data });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const updated = await prisma.appError.updateMany({
      where: {
        source: input.source,
        fingerprint,
        resolvedAt: null,
      },
      data: {
        severity: input.severity ?? "error",
        message,
        contextJson: jsonOrUndefined(input.context),
        lastSeenAt: input.now,
        occurrenceCount: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      await prisma.appError.create({ data });
    }
  }
  return fingerprint;
}

export async function getAdminOverview(input: AdminOverviewInput): Promise<AdminOverview> {
  const recentSince = addMinutes(input.now, -10);
  const reachableCutoff = addMinutes(input.now, input.minReachableMinutesToMatch);
  const renewalCutoff = addMinutes(input.now, input.renewalPromptBeforeMinutes);
  const todayStart = startOfUtcDay(input.now);

  const [
    scannedUsers,
    recentUsers,
    nonBlockedUsers,
    reachableEntranceUsers,
    matchingEnabledUsers,
    openUsers,
    reachableUsers,
    waitingUsers,
    activeConnections,
    endingConnections,
    expiringReachabilityUsers,
    outboxPending,
    outboxSending,
    outboxRetrying,
    providerWindowExpiredCount,
    reportCount,
    reportsToday,
    blockedUsers,
    blockedToday,
    closedConnections,
    timeoutClosedConnections,
    echoedClosedConnectionRows,
    oldestDueJob,
  ] = await Promise.all([
    prisma.user.count({
      where: {
        OR: [
          { createdAt: { gte: recentSince } },
          { lastSeenAt: { gte: recentSince } },
        ],
      },
    }),
    prisma.user.count({
      where: {
        OR: [
          { createdAt: { gte: recentSince } },
          { lastSeenAt: { gte: recentSince } },
        ],
      },
    }),
    prisma.user.count({ where: { state: { not: "blocked" } } }),
    prisma.user.count({
      where: {
        matchingEnabled: true,
        state: { not: "blocked" },
        reachableUntil: { gte: reachableCutoff },
      },
    }),
    prisma.user.count({ where: { matchingEnabled: true, state: { not: "blocked" } } }),
    prisma.user.count({
      where: {
        matchingEnabled: true,
        state: { in: entranceStates },
      },
    }),
    prisma.user.count({
      where: {
        matchingEnabled: true,
        state: { in: entranceStates },
        reachableUntil: { gte: reachableCutoff },
      },
    }),
    prisma.user.count({ where: { state: { in: entranceStates } } }),
    prisma.connection.count({ where: { state: "active" } }),
    prisma.connection.count({ where: { state: "ending" } }),
    prisma.user.count({
      where: {
        matchingEnabled: true,
        state: { not: "blocked" },
        reachableUntil: { gte: input.now, lte: renewalCutoff },
      },
    }),
    prisma.messageOutbox.count({ where: { status: "pending" } }),
    prisma.messageOutbox.count({ where: { status: "sending" } }),
    prisma.messageOutbox.count({ where: { status: "retrying" } }),
    prisma.messageOutbox.count({ where: { status: "provider_window_expired" } }),
    prisma.report.count(),
    prisma.report.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { state: "blocked" } }),
    prisma.user.count({ where: { state: "blocked", blockedAt: { gte: todayStart } } }),
    prisma.connection.count({ where: { closedAt: { not: null } } }),
    prisma.connection.count({
      where: {
        closedAt: { not: null },
        closeReason: "timeout",
      },
    }),
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT "Echo"."connectionId")::int AS count
      FROM "Echo"
      INNER JOIN "Connection" ON "Connection"."id" = "Echo"."connectionId"
      WHERE "Connection"."closedAt" IS NOT NULL
    `,
    prisma.scheduledJob.findFirst({
      where: {
        status: { in: ["pending", "running"] },
        runAt: { lte: input.now },
      },
      orderBy: [{ runAt: "asc" }, { id: "asc" }],
      select: { runAt: true },
    }),
  ]);

  const activeOrEndingConnections = activeConnections + endingConnections;
  const echoedClosedConnections = echoedClosedConnectionRows[0]?.count ?? 0;

  return {
    generatedAt: input.now.toISOString(),
    scannedUsers,
    recentUsers,
    matchingEnabledUsers,
    openUsers,
    reachableUsers,
    reachableEntranceUsers,
    reachableEntranceRate: rate(reachableEntranceUsers, nonBlockedUsers),
    waitingUsers,
    activeConnections,
    endingConnections,
    activeOrEndingConnections,
    currentMatchedUsers: activeOrEndingConnections * 2,
    expiringReachabilityUsers,
    outboxPending,
    outboxSending,
    outboxRetrying,
    outboxInFlight: outboxPending + outboxSending + outboxRetrying,
    providerWindowExpiredCount,
    reportCount,
    reportsToday,
    blockedUsers,
    blockedToday,
    closedConnections,
    timeoutClosedConnections,
    oneHourCompletionRate: rate(timeoutClosedConnections, closedConnections),
    echoedClosedConnections,
    echoRate: rate(echoedClosedConnections, closedConnections),
    scheduledJobLagSeconds: oldestDueJob ? elapsedSeconds(oldestDueJob.runAt, input.now) : 0,
  };
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return "unknown_error";
}

function jsonOrUndefined(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  return value as Prisma.InputJsonValue | undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
