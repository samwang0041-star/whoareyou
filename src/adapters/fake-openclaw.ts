import { createHash } from "node:crypto";
import { Prisma, type UserState } from "@prisma/client";
import { z } from "zod";
import { parseCommand } from "../domain/commands";
import { findOrCreateUserFromInbound } from "../domain/identity";
import { matchWaitingUsers, tryMatchUser } from "../domain/matching";
import { encryptOutboxBody } from "../domain/outbox-body";
import { closeForLeave, reportConnection } from "../domain/safety";
import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";
import { voice } from "../domain/voice";
import { prisma } from "../storage/prisma";
import { getFakeEntryQr } from "./fake-openclaw-entry";
import type { OpenClawAdapter } from "./openclaw";

const NonEmptyStringSchema = z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1));
const TextSchema = z.union([z.string(), z.number()]).transform(String);
const ReceivedAtSchema = z
  .union([z.string(), z.date()])
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), "receivedAt must be a valid date");

const FakeInboundSchema = z.object({
  providerMessageKey: NonEmptyStringSchema,
  providerUserId: NonEmptyStringSchema,
  text: TextSchema,
  receivedAt: ReceivedAtSchema,
});

export const fakeOpenClaw: OpenClawAdapter = {
  parseInbound(body: unknown): NormalizedInboundEvent {
    return FakeInboundSchema.parse(body);
  },
  async sendOutbound(message: OutboundMessage) {
    console.log(JSON.stringify({ event: "fakeOutbound", count: 1, messageHash: shortHash(message.idempotencyKey) }));
  },
  async getEntryQr(origin: string) {
    return getFakeEntryQr(origin);
  },
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export type FakeInboundResult = { status: "processed" } | { status: "duplicate" };
type AfterInboundUserLoadHook = (input: { userId: string; event: NormalizedInboundEvent }) => Promise<void>;

let afterInboundUserLoadHook: AfterInboundUserLoadHook | null = null;

export function setAfterInboundUserLoadHookForTest(hook: AfterInboundUserLoadHook | null) {
  afterInboundUserLoadHook = hook;
}

export async function handleFakeInbound(event: NormalizedInboundEvent): Promise<FakeInboundResult> {
  const claimedAt = new Date();
  const didClaim = await claimInbound(event, claimedAt);
  if (!didClaim) return { status: "duplicate" };

  try {
    await processClaimedInbound(event);
    await prisma.inboundDedupe.update({
      where: { providerMessageKey: event.providerMessageKey },
      data: { status: "processed", processedAt: event.receivedAt },
    });
    return { status: "processed" };
  } catch (error) {
    await prisma.inboundDedupe.update({
      where: { providerMessageKey: event.providerMessageKey },
      data: { status: "failed", processedAt: event.receivedAt },
    });
    throw error;
  }
}

async function claimInbound(event: NormalizedInboundEvent, claimedAt: Date): Promise<boolean> {
  try {
    await prisma.inboundDedupe.create({
      data: {
        providerMessageKey: event.providerMessageKey,
        receivedAt: event.receivedAt,
        status: "processing",
        processedAt: claimedAt,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const reclaimed = await reclaimExistingInbound(event, claimedAt);
      if (!reclaimed) await recordDuplicateInbound(event.providerMessageKey);
      return reclaimed;
    }
    throw error;
  }
}

async function reclaimExistingInbound(event: NormalizedInboundEvent, claimedAt: Date): Promise<boolean> {
  const staleProcessingBefore = new Date(claimedAt.getTime() - 5 * 60_000);
  const claimed = await prisma.inboundDedupe.updateMany({
    where: {
      providerMessageKey: event.providerMessageKey,
      OR: [
        { status: "failed" },
        { status: "processing", processedAt: { lte: staleProcessingBefore } },
        { status: "processing", processedAt: null, receivedAt: { lte: staleProcessingBefore } },
      ],
    },
    data: {
      status: "processing",
      receivedAt: event.receivedAt,
      processedAt: claimedAt,
    },
  });
  return claimed.count === 1;
}

async function processClaimedInbound(event: NormalizedInboundEvent) {
  const command = parseCommand(event.text);
  const user = await findOrCreateUserFromInbound({
    providerUserId: event.providerUserId,
    receivedAt: event.receivedAt,
    replyWindowHours: envInt("PROVIDER_REPLY_WINDOW_HOURS", 24),
    sendQuota: envInt("PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE", 999),
    preserveExistingState: true,
  });

  if (user.state === "blocked") {
    return;
  }
  if (afterInboundUserLoadHook) {
    await afterInboundUserLoadHook({ userId: user.id, event });
  }
  if (!(await canUserContinue(user.id))) {
    return;
  }

  if (command.kind === "help") {
    if (!(await canUserContinue(user.id))) return;
    await enqueueToUser({
      recipientUserId: user.id,
      idempotencyKey: `${event.providerMessageKey}:help`,
      body: await helpBodyForUser(user.id),
      now: event.receivedAt,
    });
    return;
  }

  if (command.kind === "open" || command.kind === "continue") {
    if (user.state === "cooldown") {
      await enqueueToUser({
        recipientUserId: user.id,
        idempotencyKey: `${event.providerMessageKey}:cooldown`,
        body: voice.cooldownActive(),
        now: event.receivedAt,
      });
      return;
    }

    const activeConnection = await findActiveConnection(user.id);
    if (activeConnection) {
      return;
    }

    const opened = await prisma.user.updateMany({
      where: { id: user.id, state: { not: "blocked" } },
      data: { state: "available", matchingEnabled: true },
    });
    if (opened.count === 0) return;

    const match = await tryMatchUser({
      userId: user.id,
      now: event.receivedAt,
      minReachableMinutesToMatch: envInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70),
      maxActiveConnections: envInt("MAX_ACTIVE_CONNECTIONS", 5),
      maxWaitingUsers: envInt("MAX_WAITING_USERS", 20),
    });
    if (match.status === "waiting") {
      await enqueueToUser({
        recipientUserId: user.id,
        idempotencyKey: `${event.providerMessageKey}:waiting`,
        body: voice.waitingFull(),
        now: event.receivedAt,
      });
    }
    if (match.status === "capacity_full") {
      await enqueueToUser({
        recipientUserId: user.id,
        idempotencyKey: `${event.providerMessageKey}:capacity-full`,
        body: voice.capacityFull(),
        now: event.receivedAt,
      });
    }
    return;
  }

  const activeConnection = await findActiveConnection(user.id);

  if (command.kind === "pause") {
    if (activeConnection) {
      await prisma.user.updateMany({
        where: { id: user.id, state: { not: "blocked" } },
        data: { matchingEnabled: false },
      });
      await enqueueToUser({
        recipientUserId: user.id,
        idempotencyKey: `${event.providerMessageKey}:pause-after-match`,
        body: voice.pauseAfterMatch(),
        now: event.receivedAt,
      });
      return;
    }

    await prisma.user.updateMany({
      where: { id: user.id, state: { not: "blocked" } },
      data: { state: "paused", matchingEnabled: false },
    });
    await enqueueToUser({
      recipientUserId: user.id,
      idempotencyKey: `${event.providerMessageKey}:pause-confirmed`,
      body: voice.pauseConfirmed(),
      now: event.receivedAt,
    });
    return;
  }

  if (command.kind === "leave") {
    if (!(await canUserContinue(user.id))) return;
    if (!activeConnection) {
      await enqueueNoActiveMatch({ recipientUserId: user.id, event });
      return;
    }
    await enqueueToUser({
      connectionId: activeConnection.id,
      recipientUserId: user.id,
      idempotencyKey: `${event.providerMessageKey}:leave-prompt`,
      body: voice.leaveConfirmPrompt(),
      now: event.receivedAt,
    });
    return;
  }

  if (command.kind === "confirm_leave") {
    if (!(await canUserContinue(user.id))) return;
    if (!activeConnection) {
      await enqueueNoActiveMatch({ recipientUserId: user.id, event });
      return;
    }
    try {
      await closeForLeave({
        connectionId: activeConnection.id,
        actorUserId: user.id,
        now: event.receivedAt,
        notifications: {
          actorIdempotencyKey: `${event.providerMessageKey}:leave-confirmed`,
          actorBody: user.matchingEnabled ? voice.leaveConfirmed() : voice.leaveConfirmedPaused(),
          peerIdempotencyKey: `${event.providerMessageKey}:peer-left`,
          peerBody: voice.partnerLeft(),
        },
      });
      await matchWaitingUsers({ now: event.receivedAt });
    } catch (error) {
      if (!isBlockedActorRejection(error)) throw error;
    }
    return;
  }

  if (command.kind === "report") {
    if (!(await canUserContinue(user.id))) return;
    const reportableConnection = activeConnection ?? await findLatestAwaitingEchoConnection(user.id);
    if (!reportableConnection) {
      await enqueueNoActiveMatch({ recipientUserId: user.id, event });
      return;
    }
    try {
      await reportConnection({
        connectionId: reportableConnection.id,
        reporterUserId: user.id,
        reason: command.reason,
        now: event.receivedAt,
        notifications: {
          actorIdempotencyKey: `${event.providerMessageKey}:report-confirmed`,
          actorBody: voice.reportConfirmed(),
          peerIdempotencyKey: `${event.providerMessageKey}:peer-ended`,
          peerBody: voice.peerEnded(),
        },
      });
      await matchWaitingUsers({ now: event.receivedAt });
    } catch (error) {
      if (!isBlockedActorRejection(error)) throw error;
    }
    return;
  }

  if (activeConnection) {
    if (!(await canUserContinue(user.id))) return;
    await enqueueToUser({
      connectionId: activeConnection.id,
      recipientUserId: otherParticipantId(activeConnection, user.id),
      idempotencyKey: `${event.providerMessageKey}:relay`,
      body: command.text,
      now: event.receivedAt,
      encryptBody: true,
    });
    return;
  }

  if (!(await canUserContinue(user.id))) return;
  await enqueueNoActiveMatch({ recipientUserId: user.id, event });
}

async function canUserContinue(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { state: true },
  });
  return user?.state !== "blocked";
}

async function findActiveConnection(userId: string) {
  return prisma.connection.findFirst({
    where: {
      state: { in: ["active", "ending"] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { startedAt: "desc" },
  });
}

async function findLatestAwaitingEchoConnection(userId: string) {
  return prisma.connection.findFirst({
    where: {
      state: "awaiting_echo",
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { closedAt: "desc" },
  });
}

async function recordDuplicateInbound(providerMessageKey: string) {
  await prisma.inboundDedupe.updateMany({
    where: { providerMessageKey },
    data: { duplicateCount: { increment: 1 } },
  });
}

async function enqueueNoActiveMatch(input: { recipientUserId: string; event: NormalizedInboundEvent }) {
  const user = await prisma.user.findUnique({
    where: { id: input.recipientUserId },
    select: { state: true },
  });
  const closedConnection = await findLatestClosedConnection(input.recipientUserId);
  await enqueueToUser({
    recipientUserId: input.recipientUserId,
    idempotencyKey: `${input.event.providerMessageKey}:no-match`,
    body: noActiveMatchBody(user?.state, closedConnection?.closeReason),
    now: input.event.receivedAt,
  });
}

async function helpBodyForUser(userId: string): Promise<string> {
  const activeConnection = await findActiveConnection(userId);
  if (activeConnection) return voice.helpMatched();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { state: true },
  });
  if (user?.state === "waiting" || user?.state === "available") return voice.helpWaiting();
  if (user?.state === "cooldown") return voice.helpCooldown();
  if (user?.state === "paused") return voice.helpPaused();

  return voice.help();
}

async function findLatestClosedConnection(userId: string) {
  return prisma.connection.findFirst({
    where: {
      state: "awaiting_echo",
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { closedAt: "desc" },
    select: { closeReason: true },
  });
}

function noActiveMatchBody(userState: UserState | undefined, closeReason: string | null | undefined): string {
  if (userState === "waiting" || userState === "available") return voice.waitingStill();
  if (userState === "cooldown" || closeReason === "left" || closeReason === "reported" || closeReason === "provider_expired") {
    return voice.closedNoRelay();
  }

  return voice.unknown();
}

async function enqueueToUser(input: {
  connectionId?: string;
  recipientUserId: string;
  idempotencyKey: string;
  body: string;
  now: Date;
  encryptBody?: boolean;
}) {
  await prisma.messageOutbox.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      connectionId: input.connectionId,
      recipientUserId: input.recipientUserId,
      idempotencyKey: input.idempotencyKey,
      bodyCiphertextOrBody: input.encryptBody ? encryptOutboxBody(input.body) : input.body,
      nextAttemptAt: input.now,
    },
    update: {},
  });
}

function otherParticipantId(connection: { userAId: string; userBId: string }, userId: string): string {
  if (connection.userAId === userId) return connection.userBId;
  if (connection.userBId === userId) return connection.userAId;
  throw new Error("user_not_in_connection");
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isBlockedActorRejection(error: unknown): boolean {
  return error instanceof Error && error.message === "actor_blocked";
}
