import { timingSafeEqual } from "crypto";
import { getClientIp } from "./client-ip";

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 }
  | { ok: false; status: 429; retryAfterSeconds: number };

type FailureRecord = {
  fails: number;
  lockedUntil: number;
};

const failures = new Map<string, FailureRecord>();
const adminTokenDevelopmentSecret = "dev-admin-token";

/**
 * Authorize an admin API request. Combines a constant-time token comparison,
 * a per-IP failure lockout, and an optional IP allow-list.
 *
 * Token comparison uses `timingSafeEqual` so response timing leaks nothing
 * about the expected token. Length mismatches are handled without throwing.
 */
export function requireAdmin(request: Request, now: number = Date.now()): AdminAuthResult {
  const ip = getClientIp(request) || "unknown";

  const allowedIps = parseAllowedIps(process.env.ADMIN_ALLOWED_IPS);
  if (allowedIps.length > 0 && !allowedIps.includes(ip)) {
    return { ok: false, status: 401 };
  }

  const record = failures.get(ip);
  if (record && record.lockedUntil > now) {
    return { ok: false, status: 429, retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }

  const expectedToken = process.env.ADMIN_TOKEN;
  if (!isAcceptableAdminToken(expectedToken) || !tokenMatches(request, expectedToken)) {
    registerFailure(ip, now);
    return { ok: false, status: 401 };
  }

  failures.delete(ip);
  return { ok: true };
}

/**
 * The configured admin token must be present and, in production, must not be a
 * known development value. A missing or development token is treated as if no
 * valid token exists, so every request is rejected with 401 rather than the app
 * silently running with a weak token.
 */
function isAcceptableAdminToken(token: string | undefined): token is string {
  if (!token) return false;
  if (process.env.NODE_ENV === "production" && token === adminTokenDevelopmentSecret) return false;
  return true;
}

/** Test-only: clear failure records between cases. */
export function resetAdminAuthForTest() {
  failures.clear();
}

function tokenMatches(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || !token) return false;

  const presented = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  if (presented.length !== expected.length) {
    // Compare against itself to keep the work constant-ish before returning.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(presented, expected);
}

function registerFailure(ip: string, now: number) {
  const maxFails = positiveInt(process.env.ADMIN_LOGIN_MAX_FAILS, 5);
  const lockMs = positiveInt(process.env.ADMIN_LOGIN_LOCK_MS, 15 * 60 * 1000);

  const previous = failures.get(ip);
  const fails = (previous?.fails ?? 0) + 1;
  const lockedUntil = fails >= maxFails ? now + lockMs : 0;
  failures.set(ip, { fails, lockedUntil });
}

function parseAllowedIps(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function positiveInt(envValue: string | undefined, fallback: number): number {
  const value = Number(envValue);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
