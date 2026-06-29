import { NextResponse } from "next/server";
import { getFakeEntryQr } from "../../../src/adapters/fake-openclaw-entry";

export async function GET() {
  return NextResponse.json(await getFakeEntryQr());
}
