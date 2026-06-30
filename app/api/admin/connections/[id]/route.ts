import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../src/web/admin-auth";
import { getConnectionDetail } from "../../../../../src/workers/admin-details";

type RouteContext = {
  params: { id: string } | Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
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

  const { id } = await context.params;
  const detail = await getConnectionDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
