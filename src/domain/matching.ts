import { Prisma } from "@prisma/client";
import type { ConnectionState, UserState } from "@prisma/client";
import { prisma } from "../storage/prisma";
import { decideCapacityState } from "./capacity";
import { voice } from "./voice";

const activeConnectionStates: ConnectionState[] = ["active", "ending"];
const candidateStates: UserState[] = ["available", "waiting"];
const maxMatchAttempts = 3;
const retryablePrismaCodes = new Set(["P2034", "P2002"]);
const retryableDatabaseCodes = new Set(["40001", "40P01", "23505"]);

export type TryMatchUserInput = {
  userId: string;
  now?: Date;
  minReachableMinutesToMatch: number;
  maxActiveConnections?: number;
  maxWaitingUsers?: number;
  random?: () => number;
};

export type TryMatchUserResult =
  | { status: "matched"; connectionId: string }
  | { status: "waiting" }
  | { status: "capacity_full" }
  | { status: "not_eligible" };

export async function tryMatchUser(input: TryMatchUserInput): Promise<TryMatchUserResult> {
  const now = input.now ?? new Date();
  const minimumReachableUntil = addMinutes(now, input.minReachableMinutesToMatch);
  const maxActiveConnections = input.maxActiveConnections ?? envInt("MAX_ACTIVE_CONNECTIONS", 5);
  const maxWaitingUsers = input.maxWaitingUsers ?? envInt("MAX_WAITING_USERS", 20);

  for (let attempt = 1; attempt <= maxMatchAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const currentUser = await tx.user.findUnique({
            where: { id: input.userId },
            select: {
              id: true,
              state: true,
              matchingEnabled: true,
              reachableUntil: true,
            },
          });

          if (!currentUser) return { status: "not_eligible" };
          if (currentUser.state === "blocked") return { status: "not_eligible" };
          if (!candidateStates.includes(currentUser.state)) return { status: "not_eligible" };
          if (!currentUser.matchingEnabled) return { status: "not_eligible" };
          if (!currentUser.reachableUntil || currentUser.reachableUntil < minimumReachableUntil) {
            await tx.user.update({
              where: { id: currentUser.id },
              data: { state: "unreachable", matchingEnabled: false },
            });
            return { status: "not_eligible" };
          }
          if (await hasActiveStateConnection(tx, currentUser.id)) {
            return { status: "not_eligible" };
          }

          const activeConnections = await tx.connection.count({
            where: { state: { in: activeConnectionStates } },
          });
          const waitingUsers = await countWaitingUsers(tx, currentUser.id);
          const capacityState = decideCapacityState({
            activeConnections,
            waitingUsers,
            maxActiveConnections,
            maxWaitingUsers,
          });

          if (capacityState === "waiting") {
            await moveUserToWaiting(tx, currentUser.id);
            await recordCapacityEvent(tx, currentUser.id, "capacity_active_full", now);
            return { status: "waiting" };
          }
          if (capacityState === "paused") {
            return pauseForCapacity(tx, currentUser.id, now);
          }

          const candidates = shuffleCandidates(await tx.user.findMany({
            where: {
              id: { not: currentUser.id },
              state: { in: candidateStates },
              matchingEnabled: true,
              reachableUntil: { gte: minimumReachableUntil },
            },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true },
          }), input.random ?? Math.random);

          for (const candidate of candidates) {
            if (await isPairBlocked(tx, currentUser.id, candidate.id)) continue;
            if (await hasActiveStateConnection(tx, candidate.id)) continue;

            const connection = await tx.connection.create({
              data: {
                userAId: currentUser.id,
                userBId: candidate.id,
                state: "active",
                startedAt: now,
              },
              select: { id: true },
            });

            await tx.user.updateMany({
              where: { id: { in: [currentUser.id, candidate.id] } },
              data: { state: "matched" },
            });

            await removeUnsentWaitingPrompts(tx, [currentUser.id, candidate.id]);

            await tx.scheduledJob.createMany({
              data: scheduledConnectionJobs(connection.id, now),
            });

            await tx.messageOutbox.createMany({
              data: [currentUser.id, candidate.id].map((recipientUserId) => ({
                connectionId: connection.id,
                recipientUserId,
                idempotencyKey: `match-start:${connection.id}:${recipientUserId}`,
                bodyCiphertextOrBody: voice.matchStarted(),
                nextAttemptAt: now,
              })),
            });

            return { status: "matched", connectionId: connection.id };
          }

          if ((await countWaitingUsers(tx, currentUser.id)) >= maxWaitingUsers) {
            return pauseForCapacity(tx, currentUser.id, now);
          }

          await moveUserToWaiting(tx, currentUser.id);
          return { status: "waiting" };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isRetryableMatchRace(error)) throw error;
      if (attempt === maxMatchAttempts) return readPostRaceResult(input.userId);
    }
  }

  return readPostRaceResult(input.userId);
}

export async function matchWaitingUsers(input: {
  now?: Date;
  limit?: number;
  minReachableMinutesToMatch?: number;
  maxActiveConnections?: number;
  maxWaitingUsers?: number;
} = {}): Promise<{ attempted: number; matched: number }> {
  const now = input.now ?? new Date();
  const minReachableMinutesToMatch = input.minReachableMinutesToMatch ?? envInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70);
  const maxActiveConnections = input.maxActiveConnections ?? envInt("MAX_ACTIVE_CONNECTIONS", 5);
  const maxWaitingUsers = input.maxWaitingUsers ?? envInt("MAX_WAITING_USERS", 20);
  const minimumReachableUntil = addMinutes(now, minReachableMinutesToMatch);
  const users = await prisma.user.findMany({
    where: {
      state: "waiting",
      matchingEnabled: true,
      reachableUntil: { gte: minimumReachableUntil },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: input.limit ?? maxWaitingUsers,
  });

  let attempted = 0;
  let matched = 0;
  for (const user of users) {
    const result = await tryMatchUser({
      userId: user.id,
      now,
      minReachableMinutesToMatch,
      maxActiveConnections,
      maxWaitingUsers,
    });
    attempted += 1;
    if (result.status === "matched") matched += 1;
  }

  return { attempted, matched };
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

type MatchingTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type MatchingCandidate = { id: string };

function shuffleCandidates<T extends MatchingCandidate>(candidates: T[], random: () => number): T[] {
  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

async function hasActiveStateConnection(tx: MatchingTransaction, userId: string): Promise<boolean> {
  const activeConnection = await tx.connection.findFirst({
    where: {
      state: { in: activeConnectionStates },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true },
  });
  return activeConnection !== null;
}

async function countWaitingUsers(tx: MatchingTransaction, currentUserId: string): Promise<number> {
  return tx.user.count({
    where: {
      id: { not: currentUserId },
      state: "waiting",
      matchingEnabled: true,
    },
  });
}

async function moveUserToWaiting(tx: MatchingTransaction, userId: string) {
  await tx.user.update({
    where: { id: userId },
    data: { state: "waiting" },
  });
}

async function removeUnsentWaitingPrompts(tx: MatchingTransaction, userIds: string[]) {
  await tx.messageOutbox.deleteMany({
    where: {
      recipientUserId: { in: userIds },
      connectionId: null,
      status: { in: ["pending", "retrying"] },
      idempotencyKey: { endsWith: ":waiting" },
    },
  });
}

async function pauseForCapacity(tx: MatchingTransaction, userId: string, now: Date): Promise<TryMatchUserResult> {
  await tx.user.update({
    where: { id: userId },
    data: {
      state: "paused",
      matchingEnabled: false,
    },
  });
  await recordCapacityEvent(tx, userId, "capacity_waiting_full", now);
  return { status: "capacity_full" };
}

async function recordCapacityEvent(tx: MatchingTransaction, userId: string, eventType: string, createdAt: Date) {
  await tx.rateLimitEvent.create({
    data: {
      userId,
      eventType,
      createdAt,
    },
  });
}

async function isPairBlocked(tx: MatchingTransaction, userAId: string, userBId: string): Promise<boolean> {
  const [userLowId, userHighId] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const pairBlock = await tx.pairBlock.findUnique({
    where: {
      userLowId_userHighId: {
        userLowId,
        userHighId,
      },
    },
    select: { id: true },
  });
  return pairBlock !== null;
}

async function readPostRaceResult(userId: string): Promise<TryMatchUserResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      state: true,
      matchingEnabled: true,
      reachableUntil: true,
    },
  });

  if (!user) return { status: "not_eligible" };
  if (user.state === "waiting") return { status: "waiting" };
  if (user.state === "paused" && await hasCapacityPauseEvent(user.id)) return { status: "capacity_full" };
  if (!candidateStates.includes(user.state)) return { status: "not_eligible" };
  if (!user.matchingEnabled) return { status: "not_eligible" };
  if (await hasActiveStateConnection(prisma, user.id)) return { status: "not_eligible" };

  return { status: "not_eligible" };
}

async function hasCapacityPauseEvent(userId: string): Promise<boolean> {
  const capacityEvent = await prisma.rateLimitEvent.findFirst({
    where: {
      userId,
      eventType: "capacity_waiting_full",
    },
    select: { id: true },
  });
  return capacityEvent !== null;
}

function isRetryableMatchRace(error: unknown): boolean {
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

function scheduledConnectionJobs(connectionId: string, now: Date) {
  return [
    { type: "reminder_10" as const, minutes: 10 },
    { type: "reminder_20" as const, minutes: 20 },
    { type: "reminder_30" as const, minutes: 30 },
    { type: "reminder_40" as const, minutes: 40 },
    { type: "reminder_50" as const, minutes: 50 },
    { type: "close_connection" as const, minutes: 60 },
  ].map((job) => ({
    connectionId,
    type: job.type,
    runAt: addMinutes(now, job.minutes),
    idempotencyKey: `${job.type}:${connectionId}`,
  }));
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
