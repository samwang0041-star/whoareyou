import { isProviderWindowExpired } from "../domain/provider-policy";
import { prisma } from "../storage/prisma";

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

async function processOneOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<OutboxOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${input.messageId}, 7101))`;

      const message = await tx.messageOutbox.findUnique({
        where: { id: input.messageId },
        include: { recipient: true },
      });
      if (!message) return "skipped";
      if (!["pending", "retrying"].includes(message.status)) return "skipped";
      if (message.nextAttemptAt > input.now) return "skipped";

      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${message.recipientUserId}, 7102))`;

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
        return "provider_window_expired";
      }

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
        return "failed";
      }

      try {
        await input.send({
          recipientUserId: message.recipientUserId,
          body,
          idempotencyKey: message.idempotencyKey,
        });
      } catch {
        const retryCount = message.retryCount + 1;
        const exhausted = retryCount >= input.maxRetries;
        await tx.messageOutbox.update({
          where: { id: message.id },
          data: {
            status: exhausted ? "failed" : "retrying",
            retryCount,
            nextAttemptAt: exhausted ? input.now : addSeconds(input.now, retryCount * 30),
            failedAt: exhausted ? input.now : null,
            bodyCiphertextOrBody: exhausted ? null : body,
            bodyClearedAt: exhausted ? input.now : null,
          },
        });
        return exhausted ? "failed" : "retried";
      }

      await tx.messageOutbox.update({
        where: { id: message.id },
        data: {
          status: "sent",
          sentAt: input.now,
          bodyCiphertextOrBody: null,
          bodyClearedAt: input.now,
          providerWindowCheckedAt: input.now,
        },
      });
      await tx.user.update({
        where: { id: message.recipientUserId },
        data: { providerSendQuota: { decrement: 1 } },
      });
      return "sent";
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

type OutboxTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
