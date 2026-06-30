import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { fakeOpenClaw, handleFakeInbound } from "../../../../src/adapters/fake-openclaw";
import { loadProviderModeConfig } from "../../../../src/config";
import { prisma } from "../../../../src/storage/prisma";
import { recordAppError } from "../../../../src/workers/admin-metrics";

export async function GET(request: Request) {
  if (loadProviderModeConfig().PROVIDER_MODE !== "fake") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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

  try {
    const body = await request.json();
    const event = fakeOpenClaw.parseInbound(body);
    const result = await handleFakeInbound(event);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      await recordInvalidPayload(error);
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    throw error;
  }
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
