import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../src/web/admin-auth";
import { getAdminOverview } from "../../../../src/workers/admin-metrics";

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

  const overview = await getAdminOverview({
    now: new Date(),
    minReachableMinutesToMatch: envPositiveInt("MIN_REACHABLE_MINUTES_TO_MATCH", 70),
    renewalPromptBeforeMinutes: envPositiveInt("REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES", 60),
  });

  return NextResponse.json(overview);
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
