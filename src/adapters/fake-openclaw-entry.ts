import { randomUUID } from "crypto";
import QRCode from "qrcode";
import { prisma } from "../storage/prisma";
import type { EntryQrResponse } from "./openclaw";

const QR_EXPIRES_IN_MS = 5 * 60_000;

export async function getFakeEntryQr(origin: string): Promise<EntryQrResponse> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + QR_EXPIRES_IN_MS).toISOString();
  const payloadUrl = new URL("/api/wechat/callback", origin);
  payloadUrl.searchParams.set("fake", "1");
  payloadUrl.searchParams.set("qr_session", sessionId);

  const statusUrl = new URL("/api/qr/status", origin);
  statusUrl.searchParams.set("sessionId", sessionId);
  statusUrl.searchParams.set("expiresAt", expiresAt);

  await prisma.openClawBotSession.create({
    data: {
      qrcode: sessionId,
      providerQrcodeHash: fakeQrSessionMarker(sessionId),
      status: "waiting_to_scan",
      expiresAt: new Date(expiresAt),
    },
  });

  return {
    provider: "openclaw-weixin",
    mode: "fake",
    sessionId,
    status: "waiting_to_scan",
    expiresAt,
    qr: {
      imageSrc: await QRCode.toDataURL(payloadUrl.toString(), {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 288,
        color: {
          dark: "#0b0b0f",
          light: "#ffffff",
        },
      }),
      payloadUrl: payloadUrl.toString(),
    },
    statusUrl: `${statusUrl.pathname}${statusUrl.search}`,
  };
}

export function fakeQrSessionMarker(sessionId: string): string {
  return `fake:${sessionId}`;
}
