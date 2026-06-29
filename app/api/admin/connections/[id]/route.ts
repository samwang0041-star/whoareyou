import { NextResponse } from "next/server";
import { getConnectionDetail } from "../../../../../src/workers/admin-details";

type RouteContext = {
  params: { id: string } | Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const detail = await getConnectionDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}

function isAuthorized(request: Request): boolean {
  const expectedToken = process.env.ADMIN_TOKEN;
  if (!expectedToken) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}
