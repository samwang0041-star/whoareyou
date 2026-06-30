import { z } from "zod";
import { randomBytes } from "crypto";
import type { NormalizedInboundEvent } from "../domain/types";
import { openClawProviderBaseUrlOrDefault } from "./openclaw-url-policy";

export const openClawWeixinProvider = "openclaw-weixin";
export const openClawStaleTokenErrcode = -14;

export class OpenClawProviderError extends Error {
  constructor(
    public readonly errorPrefix: string,
    public readonly providerCode: number,
  ) {
    super(`${errorPrefix}:${providerCode}`);
    this.name = "OpenClawProviderError";
  }
}

const defaultClientVersion = "2.4.6";
const UpdatesResponseSchema = z.object({
  get_updates_buf: z.union([z.string(), z.number()]).transform(String).optional(),
}).catchall(z.unknown());

export type OpenClawWeixinRuntimeInput = {
  baseUrl?: string | null;
  botToken: string;
  ilinkUserId?: string | null;
  clientVersion?: string;
  timeoutMs?: number;
};

export type FetchOpenClawWeixinUpdatesInput = OpenClawWeixinRuntimeInput & {
  sessionId: string;
  getUpdatesBuf?: string | null;
};

export type SendOpenClawWeixinMessageInput = OpenClawWeixinRuntimeInput & {
  toUserId: string;
  clientId: string;
  text: string;
  contextToken?: string | null;
};

export type OpenClawWeixinUpdateMessage = {
  event: NormalizedInboundEvent;
  contextToken?: string;
};

export type OpenClawWeixinUpdates = {
  nextGetUpdatesBuf: string;
  messages: OpenClawWeixinUpdateMessage[];
};

export async function fetchOpenClawWeixinUpdates(input: FetchOpenClawWeixinUpdatesInput): Promise<OpenClawWeixinUpdates> {
  try {
    const response = await fetch(openClawUrl(input.baseUrl, "/ilink/bot/getupdates"), {
      method: "POST",
      headers: openClawHeaders(input),
      body: JSON.stringify({
        get_updates_buf: input.getUpdatesBuf ?? "",
        base_info: baseInfo(input.clientVersion),
      }),
      signal: AbortSignal.timeout(getUpdatesTimeoutMs(input.timeoutMs)),
    });
    const body = await parseProviderJson(response, "openclaw_getupdates_failed");

    return normalizeOpenClawWeixinUpdates({
      sessionId: input.sessionId,
      body,
    });
  } catch (error) {
    if (isProviderTimeout(error)) {
      return {
        nextGetUpdatesBuf: input.getUpdatesBuf ?? "",
        messages: [],
      };
    }
    throw error;
  }
}

export function normalizeOpenClawWeixinUpdates(input: {
  sessionId: string;
  body: unknown;
}): OpenClawWeixinUpdates {
  const data = UpdatesResponseSchema.parse(extractProviderPayload(input.body, "openclaw_getupdates_failed", "openclaw_getupdates_invalid"));
  const messages = rawMessages(data).flatMap((message) => {
    const normalized = normalizeOpenClawMessage(input.sessionId, message);
    return normalized ? [normalized] : [];
  });
  if (data.get_updates_buf === undefined && messages.length === 0 && rawMessages(data).length === 0) {
    throw new Error("openclaw_getupdates_invalid");
  }

  return {
    nextGetUpdatesBuf: data.get_updates_buf ?? "",
    messages,
  };
}

export async function sendOpenClawWeixinMessage(input: SendOpenClawWeixinMessageInput): Promise<void> {
  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: input.toUserId,
    client_id: input.clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: input.text } }],
  };
  if (input.contextToken) {
    msg.context_token = input.contextToken;
  }

  const response = await fetch(openClawUrl(input.baseUrl, "/ilink/bot/sendmessage"), {
    method: "POST",
    headers: openClawHeaders(input),
    body: JSON.stringify({
      msg,
      base_info: baseInfo(input.clientVersion),
    }),
    signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
  });
  extractProviderPayload(await parseProviderJson(response, "openclaw_sendmessage_failed"), "openclaw_sendmessage_failed", "openclaw_sendmessage_invalid");
}

export function openClawUrl(baseUrl: string | null | undefined, path: string): URL {
  return new URL(path, openClawProviderBaseUrlOrDefault(baseUrl));
}

function openClawHeaders(input: OpenClawWeixinRuntimeInput): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${input.botToken}`,
    "X-WECHAT-UIN": randomWechatUinHeader(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": openClawClientVersionHeader(input.clientVersion),
  };
}

export function openClawClientVersionHeader(clientVersion = defaultClientVersion): string {
  const [major, minor, patch] = clientVersion.split(".").map((part) => Number(part));
  if (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    major >= 0 &&
    minor >= 0 &&
    patch >= 0
  ) {
    return String((major << 16) | (minor << 8) | patch);
  }
  return clientVersion;
}

export function randomWechatUinHeader(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function baseInfo(clientVersion = defaultClientVersion) {
  return {
    channel_version: clientVersion,
    bot_agent: "OpenClaw",
  };
}

async function parseProviderJson(response: Response, errorPrefix: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${errorPrefix}:${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${errorPrefix}:invalid_json`);
  }
}

function rawMessages(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [data.msgs, data.msg_list, data.message_list, data.msg];
  const firstList = candidates.find(Array.isArray);
  if (!firstList) return [];
  return firstList.filter(isRecord);
}

function extractProviderPayload(body: unknown, errorPrefix: string, invalidMessage: string): Record<string, unknown> {
  const envelope = asRecord(body, invalidMessage);
  const topLevelCode = providerCode(envelope);
  if (topLevelCode !== undefined) {
    assertProviderSuccess(envelope, topLevelCode, errorPrefix);
    return wrappedPayload(envelope) ?? envelope;
  }

  const wrapped = wrappedPayload(envelope);
  if (!wrapped) {
    return envelope;
  }

  const nestedCode = providerCode(wrapped);
  if (nestedCode !== undefined) {
    assertProviderSuccess(wrapped, nestedCode, errorPrefix);
  }
  return wrapped;
}

function getUpdatesTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(timeoutMs ?? 35_000, 35_000);
}

function isProviderTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("aborted due to timeout")
  );
}

function wrappedPayload(envelope: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(envelope.msg)) return envelope.msg;
  if (isRecord(envelope.data)) return envelope.data;
  return undefined;
}

function providerCode(value: Record<string, unknown>): number | undefined {
  return getNumber(value, "ret") ?? getNumber(value, "errcode");
}

function assertProviderSuccess(value: Record<string, unknown>, code: number, errorPrefix: string) {
  if (code !== 0) {
    throw new OpenClawProviderError(errorPrefix, code);
  }
}

export function isOpenClawStaleTokenError(error: unknown): boolean {
  return (
    (error instanceof OpenClawProviderError && error.providerCode === openClawStaleTokenErrcode) ||
    (error instanceof Error && error.message === `openclaw_getupdates_failed:${openClawStaleTokenErrcode}`)
  );
}

function normalizeOpenClawMessage(sessionId: string, message: Record<string, unknown>): OpenClawWeixinUpdateMessage | null {
  const messageId = getString(message, "message_id");
  const providerUserId = getString(message, "from_user_id");
  const createdAtMs = getNumber(message, "create_time_ms");
  const text = firstTextItem(message.item_list);
  if (!messageId || !providerUserId || createdAtMs === undefined || text === undefined) {
    return null;
  }

  const receivedAt = new Date(createdAtMs);
  if (Number.isNaN(receivedAt.getTime())) return null;

  return {
    event: {
      providerMessageKey: `${openClawWeixinProvider}:${sessionId}:${messageId}`,
      providerUserId,
      text,
      receivedAt,
    },
    contextToken: getString(message, "context_token"),
  };
}

function firstTextItem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  for (const item of value) {
    if (!isRecord(item)) continue;
    const textItem = item.text_item;
    if (!isRecord(textItem)) continue;
    const text = getString(textItem, "text");
    if (text !== undefined) return text;
  }

  return undefined;
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

function getNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, message = "openclaw_response_invalid"): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(message);
}
