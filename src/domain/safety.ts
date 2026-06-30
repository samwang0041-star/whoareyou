import { Prisma } from "@prisma/client";
import type { ConnectionState } from "@prisma/client";
import { prisma } from "../storage/prisma";

const closeableConnectionStates: ConnectionState[] = ["active", "ending"];
const maxSafetyAttempts = 3;
const retryablePrismaCodes = new Set(["P2034", "P2002"]);
const retryableDatabaseCodes = new Set(["40001", "40P01", "23505"]);

export type ConnectionCloseNotificationsInput = {
  actorIdempotencyKey: string;
  actorBody: string;
  peerIdempotencyKey: string;
  peerBody: string;
};

export type CloseForLeaveInput = {
  connectionId: string;
  actorUserId: string;
  now?: Date;
  notifications?: ConnectionCloseNotificationsInput;
};

export type ReportConnectionInput = {
  connectionId: string;
  reporterUserId: string;
  reason: string;
  now?: Date;
  notifications?: ConnectionCloseNotificationsInput;
};

export type SubmitEchoInput = {
  connectionId: string;
  fromUserId: string;
  body: string;
  now?: Date;
};

type SafetyTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function closeForLeave(input: CloseForLeaveInput) {
  const now = input.now ?? new Date();
  const cooldownSeconds = envInt("COOLDOWN_SECONDS", 60);

  for (let attempt = 1; attempt <= maxSafetyAttempts; attempt += 1) {
    try {
      return await closeForLeaveOnce(input, now, cooldownSeconds);
    } catch (error) {
      if (!isRetryableSafetyRace(error) || attempt === maxSafetyAttempts) throw error;
    }
  }

  throw new Error("leave_retry_exhausted");
}

async function closeForLeaveOnce(input: CloseForLeaveInput, now: Date, cooldownSeconds: number) {
  return prisma.$transaction(
    async (tx) => {
      const connection = await findConnectionOrThrow(tx, input.connectionId);
      if (!isConnectionUser(connection, input.actorUserId)) throw new Error("user_not_in_connection");

      await ensureUserCanAct(tx, input.actorUserId);
      const closeResult = await closeConnectionIfOpen(tx, connection, "left", now);

      if (closeResult.didClose) {
        await upsertPairBlock(tx, connection.userAId, connection.userBId, "left");
        await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);
        await scheduleCooldownReleaseJobs(tx, "left", connection.id, [connection.userAId, connection.userBId], now, cooldownSeconds);
        await enqueueCloseNotifications(tx, closeResult.connection, input.actorUserId, input.notifications, now);
      }

      return closeResult.connection;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function reportConnection(input: ReportConnectionInput) {
  const now = input.now ?? new Date();
  const cooldownSeconds = envInt("COOLDOWN_SECONDS", 60);

  for (let attempt = 1; attempt <= maxSafetyAttempts; attempt += 1) {
    try {
      return await reportConnectionOnce(input, now, cooldownSeconds);
    } catch (error) {
      if (!isRetryableSafetyRace(error) || attempt === maxSafetyAttempts) throw error;
    }
  }

  throw new Error("report_retry_exhausted");
}

async function reportConnectionOnce(input: ReportConnectionInput, now: Date, cooldownSeconds: number) {
  return prisma.$transaction(
    async (tx) => {
      const connection = await findConnectionOrThrow(tx, input.connectionId);
      if (!isConnectionUser(connection, input.reporterUserId)) throw new Error("user_not_in_connection");
      await ensureUserCanAct(tx, input.reporterUserId);

      const reportedUserId = otherUserId(connection, input.reporterUserId);

      await tx.report.upsert({
        where: {
          reporterUserId_reportedUserId: {
            reporterUserId: input.reporterUserId,
            reportedUserId,
          },
        },
        create: {
          reporterUserId: input.reporterUserId,
          reportedUserId,
          connectionId: connection.id,
          reason: input.reason,
          createdAt: now,
        },
        update: {
          connectionId: connection.id,
          reason: input.reason,
        },
      });
      await upsertPairBlock(tx, connection.userAId, connection.userBId, "reported");
      const closeResult = await closeConnectionIfOpen(tx, connection, "reported", now);

      const reportCount = await tx.report.count({ where: { reportedUserId } });
      if (reportCount >= 3) {
        await tx.user.update({
          where: { id: reportedUserId },
          data: {
            state: "blocked",
            matchingEnabled: false,
            blockedAt: now,
          },
        });
        await failPendingMessagesForBlockedUser(tx, reportedUserId, now);
        await closeActiveConnectionsForBlockedUser(tx, reportedUserId, input.notifications, now, cooldownSeconds);
      }

      if (closeResult.didClose) {
        await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);
        await scheduleCooldownReleaseJobs(tx, "reported", connection.id, [connection.userAId, connection.userBId], now, cooldownSeconds);
        await enqueueCloseNotifications(tx, closeResult.connection, input.reporterUserId, input.notifications, now);
      } else if (shouldConfirmReportOnClosedConnection(closeResult.connection)) {
        await enqueueActorCloseNotification(tx, closeResult.connection, input.reporterUserId, input.notifications, now);
      }

      return closeResult.connection;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

function shouldConfirmReportOnClosedConnection(connection: Awaited<ReturnType<typeof findConnectionOrThrow>>): boolean {
  return connection.closeReason === "timeout" || connection.closeReason === "provider_expired";
}

async function closeActiveConnectionsForBlockedUser(
  tx: SafetyTransaction,
  blockedUserId: string,
  notifications: ConnectionCloseNotificationsInput | undefined,
  now: Date,
  cooldownSeconds: number,
) {
  const connections = await tx.connection.findMany({
    where: {
      state: { in: closeableConnectionStates },
      OR: [{ userAId: blockedUserId }, { userBId: blockedUserId }],
    },
  });
  if (connections.length === 0) return;

  await tx.connection.updateMany({
    where: {
      id: { in: connections.map((connection) => connection.id) },
      state: { in: closeableConnectionStates },
    },
    data: {
      state: "awaiting_echo",
      closeReason: "reported",
      closedAt: now,
    },
  });

  const peerIds = [...new Set(connections.map((connection) => otherUserId(connection, blockedUserId)))];
  await moveNonBlockedUsersToCooldown(tx, peerIds);
  await Promise.all(
    connections.map((connection) =>
      scheduleCooldownReleaseJobs(tx, "reported", connection.id, [otherUserId(connection, blockedUserId)], now, cooldownSeconds),
    ),
  );
  await enqueueBlockedPeerNotifications(tx, connections, blockedUserId, notifications, now);
}

async function enqueueActorCloseNotification(
  tx: SafetyTransaction,
  connection: Awaited<ReturnType<typeof findConnectionOrThrow>>,
  actorUserId: string,
  notifications: ConnectionCloseNotificationsInput | undefined,
  now: Date,
) {
  if (!notifications) return;

  await tx.messageOutbox.createMany({
    data: [
      {
        connectionId: connection.id,
        recipientUserId: actorUserId,
        idempotencyKey: notifications.actorIdempotencyKey,
        bodyCiphertextOrBody: notifications.actorBody,
        nextAttemptAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

async function enqueueBlockedPeerNotifications(
  tx: SafetyTransaction,
  connections: Awaited<ReturnType<typeof findConnectionOrThrow>>[],
  blockedUserId: string,
  notifications: ConnectionCloseNotificationsInput | undefined,
  now: Date,
) {
  if (!notifications) return;

  await tx.messageOutbox.createMany({
    data: connections.map((connection) => ({
      connectionId: connection.id,
      recipientUserId: otherUserId(connection, blockedUserId),
      idempotencyKey: `${notifications.peerIdempotencyKey}:blocked-peer:${connection.id}`,
      bodyCiphertextOrBody: notifications.peerBody,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
}

async function failPendingMessagesForBlockedUser(tx: SafetyTransaction, blockedUserId: string, now: Date) {
  await tx.messageOutbox.updateMany({
    where: {
      recipientUserId: blockedUserId,
      status: { in: ["pending", "retrying", "sending"] },
    },
    data: {
      status: "failed",
      failedAt: now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });
}

export async function submitEcho(input: SubmitEchoInput) {
  const now = input.now ?? new Date();
  if (input.body.length > 160) throw new Error("echo_body_too_long");

  try {
    return await prisma.$transaction(async (tx) => {
      const connection = await findConnectionOrThrow(tx, input.connectionId);
      if (connection.state !== "awaiting_echo" && connection.state !== "closed") {
        throw new Error("echo_not_allowed");
      }
      if (connection.closeReason !== "timeout") {
        throw new Error("echo_not_allowed");
      }
      if (!isConnectionUser(connection, input.fromUserId)) throw new Error("user_not_in_connection");
      await ensureUserCanAct(tx, input.fromUserId);

      const existingEcho = await tx.echo.findUnique({
        where: {
          connectionId_fromUserId: {
            connectionId: connection.id,
            fromUserId: input.fromUserId,
          },
        },
        select: { id: true },
      });
      if (existingEcho) throw new Error("echo_already_submitted");

      return tx.echo.create({
        data: {
          connectionId: connection.id,
          fromUserId: input.fromUserId,
          toUserId: otherUserId(connection, input.fromUserId),
          body: storedEchoBody(),
          createdAt: now,
        },
      });
    });
  } catch (error) {
    if (isUniqueEchoError(error)) throw new Error("echo_already_submitted");
    throw error;
  }
}

function isCloseableConnectionState(state: ConnectionState): boolean {
  return closeableConnectionStates.includes(state);
}

async function findConnectionOrThrow(tx: SafetyTransaction, connectionId: string) {
  const connection = await tx.connection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new Error("connection_not_found");
  return connection;
}

function isConnectionUser(connection: { userAId: string; userBId: string }, userId: string): boolean {
  return connection.userAId === userId || connection.userBId === userId;
}

function otherUserId(connection: { userAId: string; userBId: string }, userId: string): string {
  if (connection.userAId === userId) return connection.userBId;
  if (connection.userBId === userId) return connection.userAId;
  throw new Error("user_not_in_connection");
}

async function ensureUserCanAct(tx: SafetyTransaction, userId: string) {
  const actor = await tx.user.findUnique({
    where: { id: userId },
    select: { state: true },
  });
  if (!actor || actor.state === "blocked") throw new Error("actor_blocked");
}

async function closeConnectionIfOpen(
  tx: SafetyTransaction,
  connection: Awaited<ReturnType<typeof findConnectionOrThrow>>,
  reason: "left" | "reported",
  now: Date,
) {
  if (!isCloseableConnectionState(connection.state)) {
    return { connection, didClose: false };
  }

  const update = await tx.connection.updateMany({
    where: {
      id: connection.id,
      state: { in: closeableConnectionStates },
    },
    data: {
      state: "awaiting_echo",
      closeReason: reason,
      closedAt: now,
    },
  });
  const freshConnection = await findConnectionOrThrow(tx, connection.id);

  return { connection: freshConnection, didClose: update.count === 1 };
}

async function enqueueCloseNotifications(
  tx: SafetyTransaction,
  connection: Awaited<ReturnType<typeof findConnectionOrThrow>>,
  actorUserId: string,
  notifications: ConnectionCloseNotificationsInput | undefined,
  now: Date,
) {
  if (!notifications) return;

  await tx.messageOutbox.createMany({
    data: [
      {
        connectionId: connection.id,
        recipientUserId: actorUserId,
        idempotencyKey: notifications.actorIdempotencyKey,
        bodyCiphertextOrBody: notifications.actorBody,
        nextAttemptAt: now,
      },
      {
        connectionId: connection.id,
        recipientUserId: otherUserId(connection, actorUserId),
        idempotencyKey: notifications.peerIdempotencyKey,
        bodyCiphertextOrBody: notifications.peerBody,
        nextAttemptAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

async function upsertPairBlock(
  tx: SafetyTransaction,
  userAId: string,
  userBId: string,
  reason: "left" | "reported",
) {
  const [userLowId, userHighId] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];

  return tx.pairBlock.upsert({
    where: {
      userLowId_userHighId: {
        userLowId,
        userHighId,
      },
    },
    create: {
      userLowId,
      userHighId,
      reason,
    },
    update: reason === "reported" ? { reason } : {},
  });
}

async function moveNonBlockedUsersToCooldown(tx: SafetyTransaction, userIds: string[]) {
  await tx.user.updateMany({
    where: {
      id: { in: userIds },
      state: { not: "blocked" },
    },
    data: {
      state: "cooldown",
    },
  });
}

async function scheduleCooldownReleaseJobs(
  tx: SafetyTransaction,
  reason: "left" | "reported",
  connectionId: string,
  userIds: string[],
  now: Date,
  cooldownSeconds: number,
) {
  await tx.scheduledJob.createMany({
    data: userIds.map((userId) => ({
      connectionId,
      userId,
      type: "cooldown_release" as const,
      runAt: addSeconds(now, cooldownSeconds),
      idempotencyKey: `manual-${reason}:${connectionId}:cooldown-release:${userId}`,
    })),
    skipDuplicates: true,
  });
}

function storedEchoBody(): string {
  return "[redacted]";
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRetryableSafetyRace(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && retryablePrismaCodes.has(code)) return true;

  const meta = getErrorMeta(error);
  const cause = getErrorCause(error);
  return hasRetryableDatabaseCode(meta) || hasRetryableDatabaseCode(cause);
}

function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMeta(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("meta" in error)) return undefined;
  return (error as { meta?: unknown }).meta;
}

function getErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
  return (error as { cause?: unknown }).cause;
}

function hasRetryableDatabaseCode(value: unknown): boolean {
  if (typeof value === "string") return retryableDatabaseCodes.has(value);
  if (typeof value !== "object" || value === null) return false;

  return Object.values(value).some((nestedValue) => hasRetryableDatabaseCode(nestedValue));
}

function isUniqueEchoError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
