import { Prisma } from "@prisma/client";
import type { ConnectionState } from "@prisma/client";
import { prisma } from "../storage/prisma";

const closeableConnectionStates: ConnectionState[] = ["active", "ending"];
const maxSafetyAttempts = 3;
const retryablePrismaCodes = new Set(["P2034"]);
const retryableDatabaseCodes = new Set(["40001", "40P01"]);

export type CloseForLeaveInput = {
  connectionId: string;
  actorUserId: string;
  now?: Date;
};

export type ReportConnectionInput = {
  connectionId: string;
  reporterUserId: string;
  reason: string;
  now?: Date;
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

  return prisma.$transaction(async (tx) => {
    const connection = await findConnectionOrThrow(tx, input.connectionId);
    if (!isConnectionUser(connection, input.actorUserId)) throw new Error("user_not_in_connection");

    await upsertPairBlock(tx, connection.userAId, connection.userBId, "left");
    const closedConnection = isCloseableConnectionState(connection.state)
      ? await tx.connection.update({
          where: { id: connection.id },
          data: {
            state: "awaiting_echo",
            closeReason: "left",
            closedAt: now,
          },
        })
      : connection;

    if (isCloseableConnectionState(connection.state)) {
      await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);
    }

    return closedConnection;
  });
}

export async function reportConnection(input: ReportConnectionInput) {
  const now = input.now ?? new Date();

  for (let attempt = 1; attempt <= maxSafetyAttempts; attempt += 1) {
    try {
      return await reportConnectionOnce(input, now);
    } catch (error) {
      if (!isRetryableSafetyRace(error) || attempt === maxSafetyAttempts) throw error;
    }
  }

  throw new Error("report_retry_exhausted");
}

async function reportConnectionOnce(input: ReportConnectionInput, now: Date) {
  return prisma.$transaction(
    async (tx) => {
      const connection = await findConnectionOrThrow(tx, input.connectionId);
      if (!isConnectionUser(connection, input.reporterUserId)) throw new Error("user_not_in_connection");

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
      const closedConnection = isCloseableConnectionState(connection.state)
        ? await tx.connection.update({
            where: { id: connection.id },
            data: {
              state: "awaiting_echo",
              closeReason: "reported",
              closedAt: now,
            },
          })
        : connection;

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
      }

      if (isCloseableConnectionState(connection.state)) {
        await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);
      }

      return closedConnection;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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
      if (!isConnectionUser(connection, input.fromUserId)) throw new Error("user_not_in_connection");

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
    update: {
      reason,
    },
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
      matchingEnabled: true,
    },
  });
}

function storedEchoBody(): string {
  return "[redacted]";
}

function isRetryableSafetyRace(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && retryablePrismaCodes.has(code)) return true;

  const meta = getErrorMeta(error);
  return hasRetryableDatabaseCode(meta);
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

function hasRetryableDatabaseCode(value: unknown): boolean {
  if (typeof value === "string") return retryableDatabaseCodes.has(value);
  if (typeof value !== "object" || value === null) return false;

  return Object.values(value).some((nestedValue) => hasRetryableDatabaseCode(nestedValue));
}

function isUniqueEchoError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
