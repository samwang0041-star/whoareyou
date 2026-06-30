import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../src/adapters/fake-openclaw";
import { getOpenClawWeixinEntryQr } from "../../../src/adapters/openclaw-weixin-entry";
import { loadQrProviderConfig } from "../../../src/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
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
