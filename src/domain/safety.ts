import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../storage/prisma";

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
    const closedConnection = await tx.connection.update({
      where: { id: connection.id },
      data: {
        state: "awaiting_echo",
        closeReason: "left",
        closedAt: now,
      },
    });
    await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);

    return closedConnection;
  });
}

export async function reportConnection(input: ReportConnectionInput) {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
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
    const closedConnection = await tx.connection.update({
      where: { id: connection.id },
      data: {
        state: "awaiting_echo",
        closeReason: "reported",
        closedAt: now,
      },
    });

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

    await moveNonBlockedUsersToCooldown(tx, [connection.userAId, connection.userBId]);

    return closedConnection;
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
          body: storedEchoBody(input.body),
          createdAt: now,
        },
      });
    });
  } catch (error) {
    if (isUniqueEchoError(error)) throw new Error("echo_already_submitted");
    throw error;
  }
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

function storedEchoBody(body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `sha256:${digest}:length:${body.length}`;
}

function isUniqueEchoError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
