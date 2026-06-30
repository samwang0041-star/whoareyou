import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../src/adapters/fake-openclaw";
import { getOpenClawWeixinEntryQr } from "../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../src/config";
import { enforceRateLimit } from "../../../src/web/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const decision = enforceRateLimit(
    request,
    process.env.RATE_LIMIT_QR_PER_WINDOW,
    process.env.RATE_LIMIT_QR_WINDOW_MS,
    1,
    10_000,
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

  const origin = new URL(request.url).origin;
  const config = loadQrProviderConfig();
  const qr =
    config.PROVIDER_MODE === "openclaw"
      ? await getOpenClawWeixinEntryQr(origin, config)
      : await fakeOpenClaw.getEntryQr(origin);

  return NextResponse.json(qr, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
