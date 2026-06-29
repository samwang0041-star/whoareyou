import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { fakeOpenClaw, handleFakeInbound } from "../../../../src/adapters/fake-openclaw";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const event = fakeOpenClaw.parseInbound(body);
    const result = await handleFakeInbound(event);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    throw error;
  }
}
