import type { ConnectionState } from "@prisma/client";
import { NextResponse } from "next/server";
import { listConnections } from "../../../../src/workers/admin-details";

const connectionStates: ConnectionState[] = ["active", "ending", "awaiting_echo", "closed"];

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const stateParam = new URL(request.url).searchParams.get("state");
  if (stateParam && !isConnectionState(stateParam)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const state = stateParam && isConnectionState(stateParam) ? stateParam : undefined;

  return NextResponse.json(await listConnections(state));
}

function isAuthorized(request: Request): boolean {
  const expectedToken = process.env.ADMIN_TOKEN;
  if (!expectedToken) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}

function isConnectionState(value: string): value is ConnectionState {
  return connectionStates.includes(value as ConnectionState);
}
