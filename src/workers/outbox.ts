import { isProviderWindowExpired } from "../domain/provider-policy";
import { prisma } from "../storage/prisma";

const staleSendingAfterMs = 5 * 60_000;

export type SendInput = {
  recipientUserId: string;
  body: string;
  idempotencyKey: string;
};

export type ProcessOutboxBatchInput = {
  now: Date;
  limit: number;
  maxRetries?: number;
  send: (message: SendInput) => Promise<void>;
};

export async function processOutboxBatch(input: ProcessOutboxBatchInput) {
  const maxRetries = input.maxRetries ?? envInt("OUTBOX_MAX_RETRIES", 3);
  await recoverStaleSendingMessages(input.now);

  const messages = await prisma.messageOutbox.findMany({
    where: {
      status: { in: ["pending", "retrying"] },
      nextAttemptAt: { lte: input.now },
    },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.limit,
  });

  const result = { processed: 0, sent: 0, retried: 0, failed: 0, providerWindowExpired: 0 };

  for (const message of messages) {
    const outcome = await processOneOutboxMessage({
      messageId: message.id,
      now: input.now,
      maxRetries,
      send: input.send,
    });
    if (outcome === "skipped") continue;

    result.processed += 1;
    if (outcome === "sent") result.sent += 1;
    if (outcome === "retried") result.retried += 1;
    if (outcome === "failed") result.failed += 1;
    if (outcome === "provider_window_expired") result.providerWindowExpired += 1;
  }

  return result;
}

type ProcessOneOutboxMessageInput = {
  messageId: string;
  now: Date;
  maxRetries: number;
  send: (message: SendInput) => Promise<void>;
};

type OutboxOutcome = "skipped" | "sent" | "retried" | "failed" | "provider_window_expired";
type ClaimResult =
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "provider_window_expired" }
  | { kind: "send"; messageId: string; recipientUserId: string; retryCount: number; body: string; idempotencyKey: string };

async function processOneOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<OutboxOutcome> {
  const claim = await claimOutboxMessage(input);
  if (claim.kind !== "send") return claim.kind;

  try {
    await input.send({
      recipientUserId: claim.recipientUserId,
      body: claim.body,
      idempotencyKey: claim.idempotencyKey,
    });
  } catch {
    return markSendFailure({
      messageId: claim.messageId,
      recipientUserId: claim.recipientUserId,
      retryCount: claim.retryCount + 1,
      maxRetries: input.maxRetries,
      body: claim.body,
      now: input.now,
    });
  }

  await prisma.messageOutbox.update({
    where: { id: claim.messageId },
    data: {
      status: "sent",
      sentAt: input.now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: input.now,
      providerWindowCheckedAt: input.now,
    },
  });
  return "sent";
}

type OutboxTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function claimOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.messageOutbox.updateMany({
      where: {
        id: input.messageId,
        status: { in: ["pending", "retrying"] },
        nextAttemptAt: { lte: input.now },
      },
      data: {
        status: "sending",
        nextAttemptAt: input.now,
      },
    });
    if (claimed.count === 0) return { kind: "skipped" };

    const message = await tx.messageOutbox.findUnique({
      where: { id: input.messageId },
      select: {
        id: true,
        recipientUserId: true,
        idempotencyKey: true,
        bodyCiphertextOrBody: true,
        retryCount: true,
      },
    });
    if (!message) return { kind: "skipped" };

    const body = message.bodyCiphertextOrBody;
    if (!body) {
      await tx.messageOutbox.update({
        where: { id: message.id },
        data: {
          status: "failed",
          failedAt: input.now,
          bodyCiphertextOrBody: null,
          bodyClearedAt: input.now,
        },
      });
      return { kind: "failed" };
    }

    await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${message.recipientUserId} FOR UPDATE`;
    const recipient = await tx.user.findUnique({
      where: { id: message.recipientUserId },
      select: {
        id: true,
        state: true,
        reachableUntil: true,
        providerSendQuota: true,
      },
    });
    if (!recipient || isProviderWindowExpired(input.now, recipient.reachableUntil) || recipient.providerSendQuota <= 0) {
      await markProviderWindowExpired(tx, message.id, message.recipientUserId, input.now);
      return { kind: "provider_window_expired" };
    }

    await tx.user.update({
      where: { id: message.recipientUserId },
      data: { providerSendQuota: { decrement: 1 } },
    });
    await tx.messageOutbox.update({
      where: { id: message.id },
      data: { providerWindowCheckedAt: input.now },
    });

    return {
      kind: "send",
      messageId: message.id,
      recipientUserId: message.recipientUserId,
      retryCount: message.retryCount,
      body,
      idempotencyKey: message.idempotencyKey,
    };
  });
}

async function markSendFailure(input: {
  messageId: string;
  recipientUserId: string;
  retryCount: number;
  maxRetries: number;
  body: string;
  now: Date;
}): Promise<OutboxOutcome> {
  const exhausted = input.retryCount >= input.maxRetries;
  await prisma.$transaction([
    prisma.messageOutbox.update({
      where: { id: input.messageId },
      data: {
        status: exhausted ? "failed" : "retrying",
        retryCount: input.retryCount,
        nextAttemptAt: exhausted ? input.now : addSeconds(input.now, input.retryCount * 30),
        failedAt: exhausted ? input.now : null,
        bodyCiphertextOrBody: exhausted ? null : input.body,
        bodyClearedAt: exhausted ? input.now : null,
        providerWindowCheckedAt: null,
      },
    }),
    prisma.user.update({
      where: { id: input.recipientUserId },
      data: { providerSendQuota: { increment: 1 } },
    }),
  ]);
  return exhausted ? "failed" : "retried";
}

async function recoverStaleSendingMessages(now: Date) {
  const staleBefore = new Date(now.getTime() - staleSendingAfterMs);
  const staleMessages = await prisma.messageOutbox.findMany({
    where: {
      status: "sending",
      nextAttemptAt: { lte: staleBefore },
    },
    select: {
      id: true,
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
  });

  for (const message of staleMessages) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MessageOutbox" WHERE "id" = ${message.id} FOR UPDATE`;
      const locked = await tx.messageOutbox.findUnique({
        where: { id: message.id },
        select: {
          id: true,
          recipientUserId: true,
          status: true,
          providerWindowCheckedAt: true,
        },
      });
      if (!locked || locked.status !== "sending") return;

      if (locked.providerWindowCheckedAt) {
        await tx.user.update({
          where: { id: locked.recipientUserId },
          data: { providerSendQuota: { increment: 1 } },
        });
      }
      await tx.messageOutbox.update({
        where: { id: locked.id },
        data: {
          status: "retrying",
          nextAttemptAt: now,
          providerWindowCheckedAt: null,
        },
      });
    });
  }
}

async function markProviderWindowExpired(
  tx: OutboxTransaction,
  messageId: string,
  recipientUserId: string,
  now: Date,
) {
  await tx.messageOutbox.update({
    where: { id: messageId },
    data: {
      status: "provider_window_expired",
      providerWindowCheckedAt: now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });
  await tx.user.updateMany({
    where: {
      id: recipientUserId,
      state: { not: "blocked" },
    },
    data: {
      state: "unreachable",
      matchingEnabled: false,
    },
  });
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

if (require.main === module) {
  processOutboxBatch({
    now: new Date(),
    limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
    send: async (message) => {
      console.log(`fake-send:${message.recipientUserId}:${message.idempotencyKey}`);
    },
  }).finally(() => prisma.$disconnect());
}
