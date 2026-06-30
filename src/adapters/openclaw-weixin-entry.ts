import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import QRCode from "qrcode";
import { Prisma } from "@prisma/client";
import type { QrProviderConfig } from "../config";
import { prisma } from "../storage/prisma";
import { recordAppError } from "../workers/admin-metrics";
import { decryptProviderCredential, encryptProviderCredential, hashProviderCredential } from "./openclaw-credentials";
import type { EntryQrResponse, EntryQrStatus } from "./openclaw";
import { normalizeOpenClawProviderBaseUrl } from "./openclaw-url-policy";
import { openClawClientVersionHeader, openClawUrl, randomWechatUinHeader } from "./openclaw-weixin-runtime";

const OptionalStringSchema = z.union([z.string(), z.number()]).transform(String).optional();
const QrResponseSchema = z.object({
  qrcode: z.string().min(1),
  qrcode_img_content: z.string().min(1),
  ret: z.number().optional(),
  errmsg: z.string().optional(),
});

const QrStatusResponseSchema = z.object({
  status: z.string().min(1),
  bot_token: OptionalStringSchema,
  ilink_bot_id: OptionalStringSchema,
  baseurl: OptionalStringSchema,
  ilink_user_id: OptionalStringSchema,
  get_updates_buf: OptionalStringSchema,
  redirect_host: OptionalStringSchema,
});

export type EntryQrStatusResponse = {
  sessionId: string;
  status: EntryQrStatus;
  expiresAt: string;
  sourceStatus?: string;
};

export async function getOpenClawWeixinEntryQr(origin: string, config: QrProviderConfig): Promise<EntryQrResponse> {
  const apiUrl = openClawUrl(config.OPENCLAW_WEIXIN_API_BASE_URL, "/ilink/bot/get_bot_qrcode");
  apiUrl.searchParams.set("bot_type", config.OPENCLAW_WEIXIN_BOT_TYPE);

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: openClawEntryHeaders(config),
    body: JSON.stringify({ local_token_list: [] }),
    signal: AbortSignal.timeout(config.OPENCLAW_QR_REQUEST_TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`openclaw_qr_failed:${response.status}`);
  }

  const qr = parseQrResponseBody(body);
  if (qr.ret !== undefined && qr.ret !== 0) {
    throw new Error(`openclaw_qr_failed:${qr.ret}`);
  }

  const expiresAt = new Date(Date.now() + config.OPENCLAW_QR_TTL_SECONDS * 1000).toISOString();
  const sessionId = randomUUID();
  await prisma.openClawBotSession.create({
    data: {
      qrcode: sessionId,
      providerQrcodeCiphertext: encryptProviderCredential(qr.qrcode, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      providerQrcodeHash: hashProviderCredential(qr.qrcode, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      status: "waiting_to_scan",
      expiresAt: new Date(expiresAt),
    },
  });
  await prisma.openClawBotSession.updateMany({
    where: {
      qrcode: { not: sessionId },
      providerQrcodeHash: hashProviderCredential(qr.qrcode, config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
      status: { in: ["waiting_to_scan", "scan_confirming", "verification_required", "provider_error"] },
    },
    data: {
      status: "superseded",
      providerError: null,
    },
  });
  const statusUrl = new URL("/api/qr/status", origin);
  statusUrl.searchParams.set("mode", "openclaw");
  statusUrl.searchParams.set("sessionId", sessionId);
  statusUrl.searchParams.set("expiresAt", expiresAt);

  return {
    provider: "openclaw-weixin",
    mode: "openclaw",
    sessionId,
    status: "waiting_to_scan",
    expiresAt,
    qr: {
      imageSrc: await QRCode.toDataURL(qr.qrcode_img_content, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 288,
        color: {
          dark: "#0b0b0f",
          light: "#ffffff",
        },
      }),
      payloadUrl: qr.qrcode_img_content,
    },
    statusUrl: `${statusUrl.pathname}${statusUrl.search}`,
  };
}

export async function getOpenClawWeixinQrStatus(input: {
  sessionId: string;
  expiresAt: string;
  config: QrProviderConfig;
}): Promise<EntryQrStatusResponse> {
  const existingSession = await prisma.openClawBotSession.findUnique({
    where: { qrcode: input.sessionId },
    select: {
      qrcode: true,
      providerQrcodeCiphertext: true,
      status: true,
      providerError: true,
      expiresAt: true,
      updatedAt: true,
      redirectHost: true,
    },
  });
  if (!existingSession) {
    throw new Error("openclaw_qr_session_not_found");
  }

  const expiresAt = existingSession.expiresAt.toISOString();
  if (secondsUntilExpiry(expiresAt) === 0) {
    await persistQrStatus({
      sessionId: input.sessionId,
      expiresAt,
      status: "expired",
    });
    return {
      sessionId: input.sessionId,
      status: "expired",
      expiresAt,
    };
  }
  if (isInProviderErrorBackoff(existingSession)) {
    throw new Error("openclaw_qr_status_backoff");
  }
  if (!existingSession.providerQrcodeCiphertext) {
    await recordQrStatusProviderError({
      sessionId: input.sessionId,
      expiresAt,
      error: new Error("openclaw_qr_legacy_session_requires_rescan"),
    });
    throw new Error("openclaw_qr_legacy_session_requires_rescan");
  }

  try {
    const providerQrcode = decryptProviderCredential(existingSession.providerQrcodeCiphertext, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET);
    const apiUrl = new URL(
      "/ilink/bot/get_qrcode_status",
      openClawUrl(existingSession?.redirectHost ?? input.config.OPENCLAW_WEIXIN_API_BASE_URL, "/"),
    );
    apiUrl.searchParams.set("qrcode", providerQrcode);

    const response = await fetch(apiUrl, {
      headers: openClawEntryHeaders(input.config),
      signal: AbortSignal.timeout(input.config.OPENCLAW_QR_STATUS_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`openclaw_qr_status_failed:${response.status}`);
    }

    const data = parseQrStatusResponseBody(raw);
    const statusResolution = await resolveQrStatus({
      sessionId: input.sessionId,
      status: mapIlinkStatus(data.status),
      source: data,
      credentialSecret: input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET,
    });
    await persistQrStatus({
      sessionId: input.sessionId,
      expiresAt,
      status: statusResolution.status,
      source: data,
      credentialSecret: input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET,
      credentialCiphertext: statusResolution.credentialCiphertext,
    });

    return {
      sessionId: input.sessionId,
      status: statusResolution.status,
      expiresAt,
      sourceStatus: data.status,
    };
  } catch (error) {
    if (isProviderStatusTimeout(error)) {
      const status = persistedEntryStatus(existingSession.status);
      await persistQrStatus({
        sessionId: input.sessionId,
        expiresAt,
        status,
      });
      return {
        sessionId: input.sessionId,
        status,
        expiresAt,
        sourceStatus: "timeout_no_change",
      };
    }
    await recordQrStatusProviderError({
      sessionId: input.sessionId,
      expiresAt,
      error,
    });
    throw error;
  }
}

type QrStatusSource = z.infer<typeof QrStatusResponseSchema>;

function parseQrResponseBody(raw: string): z.infer<typeof QrResponseSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("openclaw_qr_invalid_json");
  }

  const result = QrResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error("openclaw_qr_invalid");
  return result.data;
}

function parseQrStatusResponseBody(raw: string): QrStatusSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("openclaw_qr_status_invalid_json");
  }

  const result = QrStatusResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error("openclaw_qr_status_invalid");
  return result.data;
}

async function persistQrStatus(input: {
  sessionId: string;
  expiresAt: string;
  status: EntryQrStatus;
  source?: QrStatusSource;
  credentialSecret?: string;
  credentialCiphertext?: string;
}) {
  const expiresAt = new Date(input.expiresAt);
  const encryptedToken = input.source?.bot_token
    ? encryptProviderCredential(input.source.bot_token, input.credentialSecret)
    : undefined;
  const botTokenCiphertext = input.credentialCiphertext ?? encryptedToken;
  const encryptedIlinkBotId = input.source?.ilink_bot_id
    ? encryptProviderCredential(input.source.ilink_bot_id, input.credentialSecret)
    : undefined;
  const ilinkBotHash = input.source?.ilink_bot_id
    ? hashProviderCredential(input.source.ilink_bot_id, input.credentialSecret)
    : undefined;
  const encryptedIlinkUserId = input.source?.ilink_user_id
    ? encryptProviderCredential(input.source.ilink_user_id, input.credentialSecret)
    : undefined;
  const ilinkUserHash = input.source?.ilink_user_id
    ? hashProviderCredential(input.source.ilink_user_id, input.credentialSecret)
    : undefined;
  const encryptedGetUpdatesBuf = input.source?.get_updates_buf
    ? encryptProviderCredential(input.source.get_updates_buf, input.credentialSecret)
    : undefined;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.openClawBotSession.upsert({
      where: { qrcode: input.sessionId },
      create: {
        qrcode: input.sessionId,
        status: input.status,
        botTokenCiphertext,
        ilinkBotId: encryptedIlinkBotId,
        ilinkBotHash,
        baseUrl: normalizeOpenClawProviderBaseUrl(input.source?.baseurl),
        ilinkUserId: encryptedIlinkUserId,
        ilinkUserHash,
        getUpdatesBuf: encryptedGetUpdatesBuf,
        redirectHost: normalizeOpenClawProviderBaseUrl(input.source?.redirect_host),
        expiresAt,
        confirmedAt: input.status === "confirmed" ? now : undefined,
      },
      update: {
        status: input.status,
        botTokenCiphertext,
        ilinkBotId: encryptedIlinkBotId,
        ilinkBotHash,
        baseUrl: normalizeOpenClawProviderBaseUrl(input.source?.baseurl),
        ilinkUserId: encryptedIlinkUserId,
        ilinkUserHash,
        getUpdatesBuf: encryptedGetUpdatesBuf,
        redirectHost: normalizeOpenClawProviderBaseUrl(input.source?.redirect_host),
        expiresAt,
        confirmedAt: input.status === "confirmed" ? now : undefined,
        providerError: null,
      },
    });

    if (input.status === "confirmed" && ilinkUserHash && ilinkBotHash) {
      await tx.openClawBotSession.updateMany({
        where: {
          qrcode: { not: input.sessionId },
          status: "confirmed",
          ilinkUserHash,
          ilinkBotHash,
        },
        data: {
          status: "superseded",
          providerError: null,
        },
      });
    }
  });
}

async function resolveQrStatus(input: {
  sessionId: string;
  status: EntryQrStatus;
  source: QrStatusSource;
  credentialSecret?: string;
}): Promise<{ status: EntryQrStatus; credentialCiphertext?: string }> {
  if (input.status !== "confirmed" || input.source.bot_token) {
    return { status: input.status };
  }

  if (input.source.status === "binded_redirect") {
    const credentialCiphertext = await findReusableCredential(input.sessionId, input.source, input.credentialSecret);
    if (credentialCiphertext) {
      return { status: "confirmed", credentialCiphertext };
    }
    return { status: "scan_confirming" };
  }

  throw new Error("openclaw_qr_confirmed_missing_credentials");
}

async function findReusableCredential(sessionId: string, source: QrStatusSource, credentialSecret?: string): Promise<string | undefined> {
  if (!source.ilink_user_id || !source.ilink_bot_id) return undefined;
  const ilinkUserHash = hashProviderCredential(source.ilink_user_id, credentialSecret);
  const ilinkBotHash = hashProviderCredential(source.ilink_bot_id, credentialSecret);

  const reusableSession = await prisma.openClawBotSession.findFirst({
    where: {
      qrcode: { not: sessionId },
      status: "confirmed",
      botTokenCiphertext: { not: null },
      ilinkUserHash,
      ilinkBotHash,
    },
    orderBy: [{ confirmedAt: "desc" }, { updatedAt: "desc" }],
    select: { botTokenCiphertext: true },
  });

  return reusableSession?.botTokenCiphertext ?? undefined;
}

async function recordQrStatusProviderError(input: { sessionId: string; expiresAt: string; error: unknown }) {
  const message = errorMessage(input.error);
  const now = new Date();
  await prisma.openClawBotSession.upsert({
    where: { qrcode: input.sessionId },
    create: {
      qrcode: input.sessionId,
      status: "provider_error",
      expiresAt: new Date(input.expiresAt),
      providerError: message,
    },
    update: {
      status: "provider_error",
      providerError: message,
    },
  });
  await recordAppError({
    source: "openclaw-qr-status",
    severity: "error",
    error: new Error(message),
    now,
    context: {
      sessionHash: hashDiagnostic(input.sessionId),
    },
  });
}

function isInProviderErrorBackoff(session: { status: string; providerError: string | null; updatedAt: Date }): boolean {
  if (session.status !== "provider_error" || !session.providerError) return false;
  return Date.now() - session.updatedAt.getTime() < envInt("OPENCLAW_QR_STATUS_ERROR_BACKOFF_MS", 10_000);
}

function mapIlinkStatus(status: string): EntryQrStatus {
  if (status === "expired") return "expired";
  if (status === "scaned" || status === "scaned_but_redirect") return "scan_confirming";
  if (status === "confirmed" || status === "binded_redirect") return "confirmed";
  if (status === "need_verifycode" || status === "verify_code_blocked") return "verification_required";
  return "waiting_to_scan";
}

function persistedEntryStatus(status: string): EntryQrStatus {
  if (
    status === "waiting_to_scan" ||
    status === "scan_confirming" ||
    status === "confirmed" ||
    status === "verification_required" ||
    status === "expired"
  ) {
    return status;
  }

  return "waiting_to_scan";
}

function isProviderStatusTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("aborted due to timeout")
  );
}

function secondsUntilExpiry(expiresAt: string) {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function openClawEntryHeaders(config: QrProviderConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomWechatUinHeader(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": openClawClientVersionHeader(config.OPENCLAW_WEIXIN_CLIENT_VERSION),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function hashDiagnostic(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
