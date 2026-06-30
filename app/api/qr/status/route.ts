import { NextResponse } from "next/server";
import type { EntryQrStatus } from "../../../../src/adapters/openclaw";
import { fakeQrSessionMarker } from "../../../../src/adapters/fake-openclaw-entry";
import { getOpenClawWeixinQrStatus } from "../../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../../src/config";
import { prisma } from "../../../../src/storage/prisma";
import { enforceRateLimit } from "../../../../src/web/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const decision = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_QR_STATUS_PER_WINDOW,
    process.env.RATE_LIMIT_QR_STATUS_WINDOW_MS,
    30,
    10_000,
    { scope: "qr-status" },
  );
  if (!decision.allowed) {
    return NextResponse.json({ error: "rate_limited" }, {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)),
      },
    });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") ?? "fake";
  const sessionId = searchParams.get("sessionId");
  const expiresAt = searchParams.get("expiresAt");

  if (!sessionId) {
    return NextResponse.json({ error: "invalid_qr_session" }, { status: 400 });
  }

  if (mode === "openclaw") {
    const persistedSession = await prisma.openClawBotSession.findUnique({
      where: { qrcode: sessionId },
      select: { providerQrcodeHash: true },
    });
    if (persistedSession?.providerQrcodeHash === fakeQrSessionMarker(sessionId)) {
      return NextResponse.json(
        { error: "qr_mode_mismatch" },
        {
          status: 400,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    try {
      return NextResponse.json(
        await getOpenClawWeixinQrStatus({
          sessionId,
          expiresAt: expiresAt ?? "",
          config: loadQrProviderConfig(),
        }),
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "openclaw_qr_session_not_found") {
        return NextResponse.json(
          { error: "qr_session_not_found" },
          {
            status: 404,
            headers: {
              "Cache-Control": "no-store",
            },
          },
        );
      }
      return NextResponse.json(
        {
          sessionId,
          status: "provider_error",
          expiresAt: expiresAt ?? "",
          retryable: true,
        },
        {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }
  }

  if (!expiresAt) {
    return NextResponse.json({ error: "invalid_qr_session" }, { status: 400 });
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return NextResponse.json({ error: "invalid_qr_session" }, { status: 400 });
  }

  const now = new Date();
  const persistedSession = await prisma.openClawBotSession.findUnique({
    where: { qrcode: sessionId },
    select: { status: true, expiresAt: true, providerQrcodeCiphertext: true },
  });
  if (!persistedSession) {
    return NextResponse.json(
      { error: "qr_session_not_found" },
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (persistedSession.providerQrcodeCiphertext) {
    return NextResponse.json(
      { error: "qr_mode_mismatch" },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (persistedSession && persistedSession.expiresAt <= now && persistedSession.status !== "expired") {
    await prisma.openClawBotSession.update({
      where: { qrcode: sessionId },
      data: { status: "expired" },
    });
  }

  const isExpired =
    expiresAtMs <= now.getTime() ||
    persistedSession.expiresAt <= now;
  const status: EntryQrStatus = isExpired ? "expired" : fakeEntryStatus(persistedSession?.status);
  return NextResponse.json(
    {
      sessionId,
      status,
      expiresAt,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function fakeEntryStatus(status: string | null | undefined): EntryQrStatus {
  if (status === "confirmed") return "confirmed";
  if (status === "scan_confirming") return "scan_confirming";
  if (status === "expired") return "expired";
  if (status === "provider_error") return "provider_error";
  return "waiting_to_scan";
}
