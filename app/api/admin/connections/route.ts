import type { ConnectionState } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../src/web/admin-auth";
import { listConnections } from "../../../../src/workers/admin-details";

const connectionStates: ConnectionState[] = ["active", "ending", "awaiting_echo", "closed"];

export async function GET(request: Request) {
  const auth = requireAdmin(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 429 ? "rate_limited" : "unauthorized" },
      {
        status: auth.status,
        headers: auth.status === 429 ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
      },
    );
  }

  const stateParam = new URL(request.url).searchParams.get("state");
  if (stateParam && !isConnectionState(stateParam)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const state = stateParam && isConnectionState(stateParam) ? stateParam : undefined;

  return NextResponse.json(await listConnections(state));
}

function isConnectionState(value: string): value is ConnectionState {
  return connectionStates.includes(value as ConnectionState);
}
