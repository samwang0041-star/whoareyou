import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../../../../src/adapters/fake-openclaw";
import { getOpenClawWeixinEntryQr } from "../../../../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../../../../src/config";
import { issueRelayPeerQr } from "../../../../../../src/domain/private-relay-service";
import { prisma } from "../../../../../../src/storage/prisma";
import { enforceRateLimit } from "../../../../../../src/web/rate-limit";

type RouteContext = {
  params: { id: string } | Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext) {
  const decision = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_RELAY_PEER_QR_PER_WINDOW,
    process.env.RATE_LIMIT_RELAY_PEER_QR_WINDOW_MS,
    5,
    10_000,
  );
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
      },
    );
  }

  const { id } = await context.params;
  const invite = await prisma.relayInvite.findUnique({
    where: { id },
    select: { state: true, expiresAt: true },
  });
  if (!invite) return NextResponse.json({ error: "relay_invite_not_found" }, { status: 404 });
  if (invite.state !== "a_bound") return NextResponse.json({ error: "a_not_confirmed" }, { status: 409 });
  if (invite.expiresAt <= new Date()) return NextResponse.json({ error: "relay_invite_expired" }, { status: 410 });

  const origin = new URL(request.url).origin;
  const config = loadQrProviderConfig();
  const bQr =
    config.PROVIDER_MODE === "openclaw"
      ? await getOpenClawWeixinEntryQr(origin, config)
      : await fakeOpenClaw.getEntryQr(origin);
  const bBotSession = await prisma.openClawBotSession.findUniqueOrThrow({
    where: { qrcode: bQr.sessionId },
    select: { id: true },
  });
  await issueRelayPeerQr({
    inviteId: id,
    bBotSessionId: bBotSession.id,
    now: new Date(),
  });

  return NextResponse.json(
    {
      state: "waiting_for_b_scan",
      bQr,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
