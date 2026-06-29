import { NextResponse } from "next/server";
import { fakeOpenClaw, handleFakeInbound } from "../../../../src/adapters/fake-openclaw";

export async function POST(request: Request) {
  const body = await request.json();
  const event = fakeOpenClaw.parseInbound(body);
  const result = await handleFakeInbound(event);
  return NextResponse.json(result);
}
