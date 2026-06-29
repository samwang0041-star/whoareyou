import { Prisma } from "@prisma/client";
import { z } from "zod";
import { parseCommand } from "../domain/commands";
import { findOrCreateUserFromInbound } from "../domain/identity";
import { tryMatchUser } from "../domain/matching";
import { closeForLeave, reportConnection } from "../domain/safety";
import type { NormalizedInboundEvent, OutboundMessage } from "../domain/types";
import { voice } from "../domain/voice";
import { prisma } from "../storage/prisma";
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
    console.log(JSON.stringify({ fakeOutbound: message }));
  },
  async getEntryQr() {
    return { url: "/api/wechat/callback?fake=1" };
  },
};

export type FakeInboundResult = { status: "processed" } | { status: "duplicate" };

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
    if (isUniqueConstraintError(error)) return reclaimExistingInbound(event, claimedAt);
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

  if (command.kind === "help") {
    await enqueueToUser({
      recipientUserId: user.id,
      idempotencyKey: `${event.providerMessageKey}:help`,
      body: voice.help(),
      now: event.receivedAt,
    });
    return;
  }

  if (command.kind === "open" || command.kind === "continue") {
    const activeConnection = await findActiveConnection(user.id);
    if (activeConnection) {
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { state: "available", matchingEnabled: true },
    });
    const match = await tryMatchUser({
      userId: user.id,
      now: event.receivedAt,
      minReachableMinutesToMatch: envInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70),
    });
    if (match.status === "waiting") {
      await enqueueToUser({
        recipientUserId: user.id,
        idempotencyKey: `${event.providerMessageKey}:waiting`,
        body: voice.waitingFull(),
        now: event.receivedAt,
      });
    }
    return;
  }

  if (command.kind === "pause") {
    await prisma.user.update({
      where: { id: user.id },
      data: { state: "paused", matchingEnabled: false },
    });
    return;
  }

  const activeConnection = await findActiveConnection(user.id);

  if (command.kind === "leave") {
    if (!activeConnection) {
      await enqueueNoActiveMatch({ recipientUserId: user.id, event });
      return;
    }
    await closeForLeave({
      connectionId: activeConnection.id,
      actorUserId: user.id,
      now: event.receivedAt,
    });
    return;
  }

  if (command.kind === "report") {
    if (!activeConnection) {
      await enqueueNoActiveMatch({ recipientUserId: user.id, event });
      return;
    }
    await reportConnection({
      connectionId: activeConnection.id,
      reporterUserId: user.id,
      reason: command.reason,
      now: event.receivedAt,
    });
    return;
  }

  if (activeConnection) {
    await enqueueToUser({
      connectionId: activeConnection.id,
      recipientUserId: otherParticipantId(activeConnection, user.id),
      idempotencyKey: `${event.providerMessageKey}:relay`,
      body: command.text,
      now: event.receivedAt,
    });
    return;
  }

  await enqueueNoActiveMatch({ recipientUserId: user.id, event });
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

async function enqueueNoActiveMatch(input: { recipientUserId: string; event: NormalizedInboundEvent }) {
  await enqueueToUser({
    recipientUserId: input.recipientUserId,
    idempotencyKey: `${input.event.providerMessageKey}:no-match`,
    body: voice.unknown(),
    now: input.event.receivedAt,
  });
}

async function enqueueToUser(input: {
  connectionId?: string;
  recipientUserId: string;
  idempotencyKey: string;
  body: string;
  now: Date;
}) {
  await prisma.messageOutbox.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      connectionId: input.connectionId,
      recipientUserId: input.recipientUserId,
      idempotencyKey: input.idempotencyKey,
      bodyCiphertextOrBody: input.body,
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
