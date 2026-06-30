import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { fakeOpenClaw, handleFakeInbound } from "../../../../src/adapters/fake-openclaw";
import { loadProviderModeConfig } from "../../../../src/config";
import { prisma } from "../../../../src/storage/prisma";
import { recordAppError } from "../../../../src/workers/admin-metrics";
import { enforceRateLimit } from "../../../../src/web/rate-limit";

export async function GET(request: Request) {
  if (loadProviderModeConfig().PROVIDER_MODE !== "fake") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rateLimited = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_FAKE_CALLBACK_PER_WINDOW,
    process.env.RATE_LIMIT_FAKE_CALLBACK_WINDOW_MS,
    10,
    60_000,
    { scope: "fake-callback" },
  );
  if (!rateLimited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rateLimited.retryAfterMs / 1000)) },
    });
  }

  const { searchParams } = new URL(request.url);
  if (searchParams.get("fake") !== "1") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const sessionId = searchParams.get("qr_session");
  if (!sessionId) {
    return NextResponse.json({ error: "invalid_qr_session" }, { status: 400 });
  }

  const now = new Date();
  const update = await prisma.openClawBotSession.updateMany({
    where: {
      qrcode: sessionId,
      expiresAt: { gt: now },
      status: { in: ["waiting_to_scan", "scan_confirming"] },
    },
    data: {
      status: "confirmed",
      confirmedAt: now,
      providerError: null,
    },
  });
  const session = await prisma.openClawBotSession.findUnique({
    where: { qrcode: sessionId },
    select: { status: true, expiresAt: true },
  });

  if (!session) {
    return NextResponse.json({ error: "qr_session_not_found" }, { status: 404 });
  }
  if (session.expiresAt <= now) {
    await prisma.openClawBotSession.updateMany({
      where: { qrcode: sessionId, status: { not: "expired" } },
      data: { status: "expired" },
    });
    return NextResponse.json({ error: "qr_session_expired" }, { status: 410 });
  }

  return new Response("扫码已确认。回到原来的页面后，发「打开」。", {
    status: update.count === 1 || session.status === "confirmed" ? 200 : 409,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  if (loadProviderModeConfig().PROVIDER_MODE !== "fake") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rateLimited = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_FAKE_CALLBACK_PER_WINDOW,
    process.env.RATE_LIMIT_FAKE_CALLBACK_WINDOW_MS,
    10,
    60_000,
    { scope: "fake-callback" },
  );
  if (!rateLimited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rateLimited.retryAfterMs / 1000)) },
    });
  }

  try {
    const body = await readBoundedJson(request, envInt("FAKE_CALLBACK_MAX_BODY_BYTES", 16 * 1024));
    const event = fakeOpenClaw.parseInbound(body);
    const result = await handleFakeInbound(event);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (error instanceof SyntaxError || error instanceof ZodError) {
      await recordInvalidPayload(error);
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    throw error;
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new PayloadTooLargeError();
    }
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new PayloadTooLargeError();
  }

  return JSON.parse(raw);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
  }
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function recordInvalidPayload(error: SyntaxError | ZodError) {
  try {
    await recordAppError({
      source: "callback",
      severity: "warn",
      error: new Error("invalid_payload"),
      now: new Date(),
      context: { reason: error instanceof SyntaxError ? "malformed_json" : "schema_validation" },
    });
  } catch {
    console.warn(JSON.stringify({ event: "callback-invalid-payload-record-failed" }));
  }
}
