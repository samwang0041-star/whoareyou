import { createHash } from "node:crypto";
import type { ConnectionState } from "@prisma/client";
import { matchWaitingUsers } from "../domain/matching";
import { decodeOutboxBody, encryptOutboxBody } from "../domain/outbox-body";
import { isProviderWindowExpired } from "../domain/provider-policy";
import { voice } from "../domain/voice";
import { prisma } from "../storage/prisma";
import { decryptProviderCredential } from "../adapters/openclaw-credentials";
import { openClawWeixinProvider, sendOpenClawWeixinMessage } from "../adapters/openclaw-weixin-runtime";
import { loadOpenClawOutboxConfig, loadProviderModeConfig } from "../config";
import { recordAppError, recordWorkerHeartbeat } from "./admin-metrics";

const activeConnectionStates: ConnectionState[] = ["active", "ending"];
const staleSendingAfterMs = 5 * 60_000;
const outboxWorkerName = "outbox";

export type SendInput = {
  recipientUserId: string;
  body: string;
  idempotencyKey: string;
};

export type ProcessOutboxBatchInput = {
  now: Date;
  limit: number;
  maxRetries?: number;
  send?: (message: SendInput) => Promise<void>;
};

export async function processOutboxBatch(input: ProcessOutboxBatchInput) {
  try {
    const maxRetries = input.maxRetries ?? envInt("OUTBOX_MAX_RETRIES", 3);
    const send = input.send ?? resolveOutboxSend();
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
        send,
      });
      if (outcome === "skipped") continue;

      result.processed += 1;
      if (outcome === "sent") result.sent += 1;
      if (outcome === "retried") result.retried += 1;
      if (outcome === "failed") result.failed += 1;
      if (outcome === "provider_window_expired") result.providerWindowExpired += 1;
    }

    if (result.providerWindowExpired > 0) {
      await triggerWaitingMatching(input.now);
    }

    await recordWorkerHeartbeat({
      workerName: outboxWorkerName,
      status: "ok",
      now: input.now,
      metadata: result,
    });
    return result;
  } catch (error) {
    const fingerprint = await recordAppError({
      source: outboxWorkerName,
      error,
      now: input.now,
    });
    await recordWorkerHeartbeat({
      workerName: outboxWorkerName,
      status: "error",
      now: input.now,
      metadata: { errorFingerprint: fingerprint },
    });
    throw error;
  }
}

async function triggerWaitingMatching(now: Date) {
  try {
    await matchWaitingUsers({ now });
  } catch (error) {
    await recordAppError({
      source: outboxWorkerName,
      error,
      now,
      context: { phase: "waiting_match_trigger" },
    });
  }
}

export function resolveOutboxSend(): (message: SendInput) => Promise<void> {
  return loadProviderModeConfig().PROVIDER_MODE === "openclaw" ? sendOpenClawOutboxMessage : sendFakeOutboxMessage;
}

async function sendFakeOutboxMessage(message: SendInput) {
  console.log(JSON.stringify({ event: "fake-send", count: 1, messageHash: shortHash(message.idempotencyKey) }));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export async function sendOpenClawOutboxMessage(message: SendInput) {
  const config = loadOpenClawOutboxConfig();
  const providerRef = await prisma.userProviderRef.findUnique({
    where: {
      provider_userId: {
        provider: openClawWeixinProvider,
        userId: message.recipientUserId,
      },
    },
    include: {
      botSession: true,
    },
  });

  if (!providerRef) {
    throw new Error("openclaw_provider_ref_missing");
  }
  const session = providerRef.botSession;
  if (!session || session.status !== "confirmed" || !session.botTokenCiphertext) {
    throw new Error("openclaw_bot_session_missing");
  }
  await sendOpenClawWeixinMessage({
    baseUrl: session.baseUrl ?? config.OPENCLAW_WEIXIN_API_BASE_URL,
    botToken: decryptProviderCredential(session.botTokenCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    ilinkUserId: session.ilinkUserId
      ? decryptProviderCredential(session.ilinkUserId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
      : null,
    clientVersion: config.OPENCLAW_WEIXIN_CLIENT_VERSION,
    timeoutMs: config.OPENCLAW_SEND_TIMEOUT_MS,
    toUserId: decryptProviderCredential(providerRef.providerUserIdCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    clientId: message.idempotencyKey,
    text: message.body,
    contextToken: providerRef.latestContextTokenCiphertext
      ? decryptProviderCredential(providerRef.latestContextTokenCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
      : undefined,
  });
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
  | {
      kind: "send";
      messageId: string;
      recipientUserId: string;
      retryCount: number;
      body: string;
      bodyWasEncrypted: boolean;
      idempotencyKey: string;
    };

async function processOneOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<OutboxOutcome> {
  if (await isRelayOutboxMessage(input.messageId)) {
    return processOneRelayOutboxMessage(input);
  }

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
      bodyWasEncrypted: claim.bodyWasEncrypted,
      now: input.now,
    });
  }

  const sent = await prisma.messageOutbox.updateMany({
    where: { id: claim.messageId, status: "sending" },
    data: {
      status: "sent",
      sentAt: input.now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: input.now,
      providerWindowCheckedAt: input.now,
    },
  });
  if (sent.count === 0) return "skipped";
  return "sent";
}

type OutboxTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function claimOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    return claimOutboxMessageInTransaction(tx, input);
  });
}

async function processOneRelayOutboxMessage(input: ProcessOneOutboxMessageInput): Promise<OutboxOutcome> {
  return prisma.$transaction(async (tx) => {
    const claim = await claimOutboxMessageInTransaction(tx, input);
    if (claim.kind !== "send") return claim.kind;

    try {
      await input.send({
        recipientUserId: claim.recipientUserId,
        body: claim.body,
        idempotencyKey: claim.idempotencyKey,
      });
    } catch {
      return markSendFailureInTransaction(tx, {
        messageId: claim.messageId,
        recipientUserId: claim.recipientUserId,
        retryCount: claim.retryCount + 1,
        maxRetries: input.maxRetries,
        body: claim.body,
        bodyWasEncrypted: claim.bodyWasEncrypted,
        now: input.now,
      });
    }

    const sent = await tx.messageOutbox.updateMany({
      where: { id: claim.messageId, status: "sending" },
      data: {
        status: "sent",
        sentAt: input.now,
        bodyCiphertextOrBody: null,
        bodyClearedAt: input.now,
        providerWindowCheckedAt: input.now,
      },
    });
    if (sent.count === 0) return "skipped";
    return "sent";
  }, { timeout: envInt("OUTBOX_RELAY_SEND_TRANSACTION_TIMEOUT_MS", 30_000) });
}

async function isRelayOutboxMessage(messageId: string): Promise<boolean> {
  const message = await prisma.messageOutbox.findUnique({
    where: { id: messageId },
    select: { idempotencyKey: true },
  });
  return Boolean(message?.idempotencyKey.endsWith(":relay"));
}

async function claimOutboxMessageInTransaction(
  tx: OutboxTransaction,
  input: ProcessOneOutboxMessageInput,
): Promise<ClaimResult> {
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
        connectionId: true,
        recipientUserId: true,
        idempotencyKey: true,
        bodyCiphertextOrBody: true,
        retryCount: true,
        createdAt: true,
      },
    });
    if (!message) return { kind: "skipped" };

    const storedBody = message.bodyCiphertextOrBody;
    if (!storedBody) {
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
    let decodedBody: ReturnType<typeof decodeOutboxBody>;
    try {
      decodedBody = decodeOutboxBody(storedBody);
    } catch {
      await failClaimedMessage(tx, message.id, input.now);
      return { kind: "failed" };
    }
    if (!(await canSendDecodedMessage(tx, {
      messageId: message.id,
      connectionId: message.connectionId,
      recipientUserId: message.recipientUserId,
      idempotencyKey: message.idempotencyKey,
      bodyWasEncrypted: decodedBody.encrypted,
      now: input.now,
    }))) {
      return { kind: "failed" };
    }

    const maxPendingSeconds = envOptionalPositiveInt("OUTBOX_BODY_MAX_PENDING_SECONDS");
    if (maxPendingSeconds && message.createdAt <= addSeconds(input.now, -maxPendingSeconds)) {
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
    if (!recipient) {
      await failClaimedMessage(tx, message.id, input.now);
      return { kind: "failed" };
    }
    if (recipient.state === "blocked") {
      await failClaimedMessage(tx, message.id, input.now);
      return { kind: "failed" };
    }
    if (isProviderWindowExpired(input.now, recipient.reachableUntil) || recipient.providerSendQuota <= 0) {
      await markProviderWindowExpired(tx, {
        messageId: message.id,
        recipientUserId: message.recipientUserId,
        now: input.now,
      });
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
      body: decodedBody.body,
      bodyWasEncrypted: decodedBody.encrypted,
      idempotencyKey: message.idempotencyKey,
    };
}

async function canSendDecodedMessage(
  tx: OutboxTransaction,
  input: {
    messageId: string;
    connectionId: string | null;
    recipientUserId: string;
    idempotencyKey: string;
    bodyWasEncrypted: boolean;
    now: Date;
  },
): Promise<boolean> {
  if (!input.idempotencyKey.endsWith(":relay")) return true;
  if (!input.connectionId) {
    await failClaimedMessage(tx, input.messageId, input.now);
    return false;
  }

  await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Connection" WHERE "id" = ${input.connectionId} FOR UPDATE`;
  const connection = await tx.connection.findUnique({
    where: { id: input.connectionId },
    select: { state: true, userAId: true, userBId: true },
  });
  const canRelay =
    connection !== null &&
    activeConnectionStates.includes(connection.state) &&
    (connection.userAId === input.recipientUserId || connection.userBId === input.recipientUserId);

  if (!canRelay) {
    await failClaimedMessage(tx, input.messageId, input.now);
  }
  return canRelay;
}

async function markSendFailure(input: {
  messageId: string;
  recipientUserId: string;
  retryCount: number;
  maxRetries: number;
  body: string;
  bodyWasEncrypted: boolean;
  now: Date;
}): Promise<OutboxOutcome> {
  const updated = await prisma.$transaction(async (tx) => {
    return markSendFailureInTransaction(tx, input);
  });
  return updated;
}

async function markSendFailureInTransaction(
  tx: OutboxTransaction,
  input: {
    messageId: string;
    recipientUserId: string;
    retryCount: number;
    maxRetries: number;
    body: string;
    bodyWasEncrypted: boolean;
    now: Date;
  },
): Promise<OutboxOutcome> {
  const exhausted = input.retryCount >= input.maxRetries;
  const marked = await tx.messageOutbox.updateMany({
    where: { id: input.messageId, status: "sending" },
    data: {
      status: exhausted ? "failed" : "retrying",
      retryCount: input.retryCount,
      nextAttemptAt: exhausted ? input.now : addSeconds(input.now, input.retryCount * 30),
      failedAt: exhausted ? input.now : null,
      bodyCiphertextOrBody: exhausted ? null : input.bodyWasEncrypted ? encryptOutboxBody(input.body) : input.body,
      bodyClearedAt: exhausted ? input.now : null,
      providerWindowCheckedAt: null,
    },
  });
  if (marked.count === 0) return "skipped";

  await tx.user.update({
    where: { id: input.recipientUserId },
    data: { providerSendQuota: { increment: 1 } },
  });
  return exhausted ? "failed" : "retried";
}

async function failClaimedMessage(tx: OutboxTransaction, messageId: string, now: Date) {
  await tx.messageOutbox.updateMany({
    where: { id: messageId, status: "sending" },
    data: {
      status: "failed",
      failedAt: now,
      bodyCiphertextOrBody: null,
      bodyClearedAt: now,
    },
  });
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
    take: envInt("OUTBOX_STALE_RECOVERY_BATCH_SIZE", 50),
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
  input: {
    messageId: string;
    recipientUserId: string;
    now: Date;
  },
) {
  const connections = await tx.connection.findMany({
    where: {
      state: { in: activeConnectionStates },
      OR: [{ userAId: input.recipientUserId }, { userBId: input.recipientUserId }],
    },
    select: { id: true, userAId: true, userBId: true },
  });

  if (connections.length > 0) {
    const connectionIds = connections.map((connection) => connection.id);
    await tx.connection.updateMany({
      where: {
        id: { in: connectionIds },
        state: { in: activeConnectionStates },
      },
      data: {
        state: "awaiting_echo",
        closeReason: "provider_expired",
        closedAt: input.now,
      },
    });
    await expireConnectionOutboxMessages(tx, connectionIds, input.now);
    await moveReachablePeersToCooldown(tx, connections, input.recipientUserId, input.now);
  }

  await tx.messageOutbox.updateMany({
    where: {
      id: input.messageId,
      status: { in: ["pending", "retrying", "sending"] },
    },
    data: providerWindowExpiredMessageUpdate(input.now),
  });
  await tx.user.updateMany({
    where: {
      id: input.recipientUserId,
      state: { not: "blocked" },
    },
    data: {
      state: "unreachable",
      matchingEnabled: false,
    },
  });
}

async function expireConnectionOutboxMessages(tx: OutboxTransaction, connectionIds: string[], now: Date) {
  await tx.messageOutbox.updateMany({
    where: {
      connectionId: { in: connectionIds },
      status: { in: ["pending", "retrying", "sending"] },
    },
    data: providerWindowExpiredMessageUpdate(now),
  });
}

async function moveReachablePeersToCooldown(
  tx: OutboxTransaction,
  connections: { id: string; userAId: string; userBId: string }[],
  unreachableUserId: string,
  now: Date,
) {
  const peerIds = [
    ...new Set(
      connections.map((connection) => connection.userAId === unreachableUserId ? connection.userBId : connection.userAId),
    ),
  ];
  if (peerIds.length === 0) return;

  const peers = await tx.user.findMany({
    where: {
      id: { in: peerIds },
      state: { not: "blocked" },
    },
    select: { id: true, reachableUntil: true, providerSendQuota: true },
  });
  const cooldownPeerIds = peers
    .filter((peer) => !isProviderWindowExpired(now, peer.reachableUntil) && peer.providerSendQuota > 0)
    .map((peer) => peer.id);
  const unreachablePeerIds = peers
    .filter((peer) => isProviderWindowExpired(now, peer.reachableUntil) || peer.providerSendQuota <= 0)
    .map((peer) => peer.id);

  if (unreachablePeerIds.length > 0) {
    await tx.user.updateMany({
      where: {
        id: { in: unreachablePeerIds },
        state: { not: "blocked" },
        OR: [
          { reachableUntil: { lte: now } },
          { providerSendQuota: { lte: 0 } },
        ],
      },
      data: { state: "unreachable", matchingEnabled: false },
    });
  }
  if (cooldownPeerIds.length === 0) return;

  await tx.user.updateMany({
    where: {
      id: { in: cooldownPeerIds },
      state: { not: "blocked" },
      reachableUntil: { gte: now },
      providerSendQuota: { gt: 0 },
    },
    data: { state: "cooldown" },
  });
  const scheduledCooldownPeers = await tx.user.findMany({
    where: {
      id: { in: cooldownPeerIds },
      state: "cooldown",
      reachableUntil: { gte: now },
      providerSendQuota: { gt: 0 },
    },
    select: { id: true },
  });
  const scheduledCooldownPeerIds = scheduledCooldownPeers.map((peer) => peer.id);
  if (scheduledCooldownPeerIds.length === 0) return;

  await tx.scheduledJob.createMany({
    data: connections.flatMap((connection) => {
      const peerId = connection.userAId === unreachableUserId ? connection.userBId : connection.userAId;
      if (!scheduledCooldownPeerIds.includes(peerId)) return [];

      return [{
        connectionId: connection.id,
        userId: peerId,
        type: "cooldown_release" as const,
        runAt: addSeconds(now, envInt("COOLDOWN_SECONDS", 60)),
        idempotencyKey: `provider-expired:${connection.id}:cooldown-release:${peerId}`,
      }];
    }),
    skipDuplicates: true,
  });
  await tx.messageOutbox.createMany({
    data: connections.flatMap((connection) => {
      const peerId = connection.userAId === unreachableUserId ? connection.userBId : connection.userAId;
      if (!scheduledCooldownPeerIds.includes(peerId)) return [];

      return [{
        connectionId: connection.id,
        recipientUserId: peerId,
        idempotencyKey: `provider-expired:${connection.id}:peer-notice:${peerId}`,
        bodyCiphertextOrBody: voice.closedNoRelay(),
        nextAttemptAt: now,
      }];
    }),
    skipDuplicates: true,
  });
}

function providerWindowExpiredMessageUpdate(now: Date) {
  return {
    status: "provider_window_expired" as const,
    providerWindowCheckedAt: now,
    bodyCiphertextOrBody: null,
    bodyClearedAt: now,
  };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envOptionalPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function runOutboxWorkerLoop() {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      await processOutboxBatch({
        now: new Date(),
        limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
      });
    } catch (error) {
      console.error(error);
    }
    await sleep(envInt("WORKER_POLL_INTERVAL_MS", 5000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const run = process.env.WORKER_LOOP === "1"
    ? runOutboxWorkerLoop()
    : processOutboxBatch({
        now: new Date(),
        limit: envInt("SCHEDULED_JOB_BATCH_SIZE", 50),
      });
  run.finally(() => prisma.$disconnect());
}
