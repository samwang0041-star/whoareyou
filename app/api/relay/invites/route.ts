import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../../src/adapters/fake-openclaw";
import { getOpenClawWeixinEntryQr } from "../../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../../src/config";
import { createRelayInvite } from "../../../../src/domain/private-relay-service";
import { enforceRateLimit } from "../../../../src/web/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const decision = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_RELAY_INVITE_PER_WINDOW,
    process.env.RATE_LIMIT_RELAY_INVITE_WINDOW_MS,
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

  const origin = new URL(request.url).origin;
  const config = loadQrProviderConfig();
  const aQr =
    config.PROVIDER_MODE === "openclaw"
      ? await getOpenClawWeixinEntryQr(origin, config)
      : await fakeOpenClaw.getEntryQr(origin);
  const invite = await createRelayInvite({
    aBotSessionId: aQr.sessionId,
    now: new Date(),
    expiresAt: new Date(aQr.expiresAt),
  });

  return NextResponse.json(
    {
      inviteId: invite.id,
      state: invite.state,
      aQr,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
