import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../src/web/admin-auth";
import { getSafetyMetrics } from "../../../../src/workers/admin-details";

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

  return NextResponse.json(await getSafetyMetrics());
}
