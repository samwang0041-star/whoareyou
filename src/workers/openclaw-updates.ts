import { createHash } from "crypto";
import { handleFakeInbound } from "../adapters/fake-openclaw";
import { decryptProviderCredential, encryptProviderCredential } from "../adapters/openclaw-credentials";
import {
  fetchOpenClawWeixinUpdates,
  isOpenClawStaleTokenError,
  openClawWeixinProvider,
  type FetchOpenClawWeixinUpdatesInput,
  type OpenClawWeixinUpdates,
} from "../adapters/openclaw-weixin-runtime";
import { loadOpenClawUpdatesWorkerConfig } from "../config";
import { findOrCreateUserFromInbound, hashProviderUserId } from "../domain/identity";
import type { NormalizedInboundEvent } from "../domain/types";
import { prisma } from "../storage/prisma";
import { recordAppError, recordWorkerHeartbeat } from "./admin-metrics";

const workerName = "openclaw-updates";

type FetchUpdates = (input: FetchOpenClawWeixinUpdatesInput) => Promise<OpenClawWeixinUpdates>;
type HandleInbound = (event: NormalizedInboundEvent) => Promise<unknown>;

export type ProcessOpenClawUpdatesBatchInput = {
  now: Date;
  limit: number;
  fetchUpdates?: FetchUpdates;
  handleInbound?: HandleInbound;
};

export async function processOpenClawUpdatesBatch(input: ProcessOpenClawUpdatesBatchInput) {
  try {
    const config = loadOpenClawUpdatesWorkerConfig();
    const fetchUpdates = input.fetchUpdates ?? fetchOpenClawWeixinUpdates;
    const handleInbound = input.handleInbound ?? handleFakeInbound;
    const sessions = await prisma.openClawBotSession.findMany({
      where: {
        status: "confirmed",
        botTokenCiphertext: { not: null },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: input.limit,
    });
    const result = { sessions: sessions.length, messages: 0, failedSessions: 0 };
    await recordWorkerHeartbeat({
      workerName,
      status: "running",
      now: new Date(),
      metadata: { ...result, phase: "polling", processedSessions: 0 },
    });

    for (const [index, session] of sessions.entries()) {
      try {
        const token = decryptProviderCredential(session.botTokenCiphertext, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET);
        const ilinkUserId = session.ilinkUserId
          ? decryptProviderCredential(session.ilinkUserId, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
          : null;
        const getUpdatesBuf = session.getUpdatesBuf
          ? decryptProviderCredential(session.getUpdatesBuf, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
          : null;
        const updates = await fetchUpdates({
          sessionId: session.qrcode,
          baseUrl: session.baseUrl,
          botToken: token,
          ilinkUserId,
          clientVersion: config.OPENCLAW_WEIXIN_CLIENT_VERSION,
          timeoutMs: config.OPENCLAW_GETUPDATES_TIMEOUT_MS,
          getUpdatesBuf,
        });

        for (const message of updates.messages) {
          await ensureProviderRef({
            event: message.event,
            contextToken: message.contextToken,
            botSessionId: session.id,
            config,
          });
          await handleInbound(message.event);
          result.messages += 1;
        }

        await prisma.openClawBotSession.update({
          where: { id: session.id },
          data: {
            getUpdatesBuf: updates.nextGetUpdatesBuf
              ? encryptProviderCredential(updates.nextGetUpdatesBuf, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
              : null,
            providerError: null,
          },
        });
      } catch (error) {
        result.failedSessions += 1;
        await recordSessionError({
          sessionId: session.id,
          qrcode: session.qrcode,
          now: input.now,
          error,
        });
      }
      await recordWorkerHeartbeat({
        workerName,
        status: "running",
        now: new Date(),
        metadata: { ...result, phase: "polling", processedSessions: index + 1 },
      });
    }

    await recordWorkerHeartbeat({
      workerName,
      status: result.failedSessions === 0 ? "ok" : "error",
      now: new Date(),
      metadata: result,
    });
    return result;
  } catch (error) {
    const fingerprint = await recordAppError({
      source: workerName,
      error,
      now: input.now,
    });
    await recordWorkerHeartbeat({
      workerName,
      status: "error",
      now: input.now,
      metadata: { errorFingerprint: fingerprint },
    });
    throw error;
  }
}

async function ensureProviderRef(input: {
  event: NormalizedInboundEvent;
  contextToken?: string;
  botSessionId: string;
  config: ReturnType<typeof loadOpenClawUpdatesWorkerConfig>;
}) {
  const providerUserHash = hashProviderUserId(input.event.providerUserId);
  const user = await findOrCreateUserFromInbound({
    providerUserId: input.event.providerUserId,
    receivedAt: input.event.receivedAt,
    replyWindowHours: input.config.PROVIDER_REPLY_WINDOW_HOURS,
    sendQuota: input.config.PROVIDER_SEND_QUOTA_AFTER_USER_MESSAGE,
    preserveExistingState: true,
  });

  const encryptedProviderUserId = encryptProviderCredential(input.event.providerUserId, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET);
  const encryptedContextToken = input.contextToken
    ? encryptProviderCredential(input.contextToken, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
    : undefined;

  await prisma.userProviderRef.upsert({
    where: {
      provider_providerUserHash: {
        provider: openClawWeixinProvider,
        providerUserHash,
      },
    },
    create: {
      provider: openClawWeixinProvider,
      providerUserHash,
      providerUserIdCiphertext: encryptedProviderUserId,
      userId: user.id,
      latestContextTokenCiphertext: encryptedContextToken,
      botSessionId: input.botSessionId,
    },
    update: {
      userId: user.id,
      providerUserIdCiphertext: encryptedProviderUserId,
      latestContextTokenCiphertext: encryptedContextToken,
      botSessionId: input.botSessionId,
    },
  });
}

async function recordSessionError(input: { sessionId: string; qrcode: string; now: Date; error: unknown }) {
  if (isOpenClawStaleTokenError(input.error)) {
    const message = errorMessage(input.error);
    await prisma.openClawBotSession.update({
      where: { id: input.sessionId },
      data: { status: "expired", providerError: message },
    });
    await prisma.appError.updateMany({
      where: {
        source: workerName,
        fingerprint: `${workerName}:${message}`,
        resolvedAt: null,
      },
      data: { resolvedAt: input.now },
    });
    return;
  }

  await prisma.openClawBotSession.update({
    where: { id: input.sessionId },
    data: { providerError: errorMessage(input.error) },
  });
  await recordAppError({
    source: workerName,
    error: input.error,
    now: input.now,
    context: {
      sessionHash: hashDiagnostic(input.qrcode),
    },
  });
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashDiagnostic(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function runOpenClawUpdatesWorkerLoop() {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      await processOpenClawUpdatesBatch({
        now: new Date(),
        limit: envInt("OPENCLAW_UPDATES_BATCH_SIZE", 1),
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
    ? runOpenClawUpdatesWorkerLoop()
    : processOpenClawUpdatesBatch({
        now: new Date(),
        limit: envInt("OPENCLAW_UPDATES_BATCH_SIZE", 1),
      });
  run.finally(() => prisma.$disconnect());
}
