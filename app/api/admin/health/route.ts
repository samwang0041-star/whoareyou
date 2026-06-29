import { NextResponse } from "next/server";
import { getHealthMetrics } from "../../../../src/workers/admin-details";

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await getHealthMetrics());
}

function isAuthorized(request: Request): boolean {
  const expectedToken = process.env.ADMIN_TOKEN;
  if (!expectedToken) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}
