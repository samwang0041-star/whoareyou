import { NextResponse } from "next/server";
import { getAdminOverview } from "../../../../src/workers/admin-metrics";

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const overview = await getAdminOverview({
    now: new Date(),
    minReachableMinutesToMatch: envPositiveInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70),
    renewalPromptBeforeMinutes: envPositiveInt("REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES", 60),
  });

  return NextResponse.json(overview);
}

function isAuthorized(request: Request): boolean {
  const expectedToken = process.env.ADMIN_TOKEN;
  if (!expectedToken) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
