import { NextResponse } from "next/server";
import { fakeOpenClaw } from "../../../src/adapters/fake-openclaw";

export async function GET() {
  const qr = await fakeOpenClaw.getEntryQr();
  return NextResponse.json(qr);
}
