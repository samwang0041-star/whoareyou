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
    include: { recipient: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.limit,
  });

  const result = { processed: 0, sent: 0, retried: 0, failed: 0, providerWindowExpired: 0 };

  for (const message of messages) {
    result.processed += 1;

    if (isProviderWindowExpired(input.now, message.recipient.reachableUntil) || message.recipient.providerSendQuota <= 0) {
      await markProviderWindowExpired(message.id, message.recipientUserId, input.now);
      result.providerWindowExpired += 1;
      continue;
    }

    const body = message.bodyCiphertextOrBody;
    if (!body) {
      await prisma.messageOutbox.update({
        where: { id: message.id },
        data: { status: "failed", failedAt: input.now },
      });
      result.failed += 1;
      continue;
    }

    try {
      await input.send({
        recipientUserId: message.recipientUserId,
        body,
        idempotencyKey: message.idempotencyKey,
      });
    } catch {
      const retryCount = message.retryCount + 1;
      const exhausted = retryCount >= maxRetries;
      await prisma.messageOutbox.update({
        where: { id: message.id },
        data: {
          status: exhausted ? "failed" : "retrying",
          retryCount,
          nextAttemptAt: input.now,
          failedAt: exhausted ? input.now : null,
        },
      });
      if (exhausted) result.failed += 1;
      else result.retried += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
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
    });
    result.sent += 1;
  }

  return result;
}

async function markProviderWindowExpired(messageId: string, recipientUserId: string, now: Date) {
  await prisma.$transaction(async (tx) => {
    await tx.messageOutbox.update({
      where: { id: messageId },
      data: {
        status: "provider_window_expired",
        providerWindowCheckedAt: now,
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
  });
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
