import { NextResponse } from "next/server";
import type { EntryQrStatus } from "../../../../src/adapters/openclaw";
import { getOpenClawWeixinQrStatus } from "../../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../../src/config";
import { prisma } from "../../../../src/storage/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") ?? "fake";
  const sessionId = searchParams.get("sessionId");
  const expiresAt = searchParams.get("expiresAt");

  if (!sessionId) {
    return NextResponse.json({ error: "invalid_qr_session" }, { status: 400 });
  }

  if (mode === "openclaw") {
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
    select: { status: true, expiresAt: true },
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
