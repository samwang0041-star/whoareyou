import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAdminAuthForTest, requireAdmin } from "../../src/web/admin-auth";

const validToken = "a".repeat(40);

function requestWith(authHeader?: string, ip?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  if (ip) headers.set("x-forwarded-for", ip);
  return new Request("https://example.com/admin", { headers });
}

describe("admin-auth", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = validToken;
    delete process.env.ADMIN_ALLOWED_IPS;
    delete process.env.ADMIN_LOGIN_MAX_FAILS;
    delete process.env.ADMIN_LOGIN_LOCK_MS;
    resetAdminAuthForTest();
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
    resetAdminAuthForTest();
  });

  it("accepts the correct bearer token", () => {
    const result = requireAdmin(requestWith(`Bearer ${validToken}`), 1_000);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a wrong token with 401", () => {
    const result = requireAdmin(requestWith("Bearer wrong-token-value-here-xxxx"), 1_000);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("rejects a token of different length without leaking via timing", () => {
    const result = requireAdmin(requestWith("Bearer short"), 1_000);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("rejects missing authorization header", () => {
    const result = requireAdmin(requestWith(undefined), 1_000);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("rejects non-bearer scheme", () => {
    const result = requireAdmin(requestWith(`Basic ${validToken}`), 1_000);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("locks out after repeated failures from the same IP", () => {
    process.env.ADMIN_LOGIN_MAX_FAILS = "3";
    process.env.ADMIN_LOGIN_LOCK_MS = "60000";
    const ip = "203.0.113.9";
    const bad = requestWith("Bearer wrong-token-value-here-xxxx", ip);

    expect(requireAdmin(bad, 1_000).ok).toBe(false);
    expect(requireAdmin(bad, 2_000).ok).toBe(false);
    expect(requireAdmin(bad, 3_000).ok).toBe(false);

    const locked = requireAdmin(requestWith(`Bearer ${validToken}`, ip), 4_000);
    expect(locked).toEqual({ ok: false, status: 429, retryAfterSeconds: 59 });
  });

  it("unlocks after the lock window passes", () => {
    process.env.ADMIN_LOGIN_MAX_FAILS = "2";
    process.env.ADMIN_LOGIN_LOCK_MS = "10000";
    const ip = "203.0.113.10";
    const bad = requestWith("Bearer wrong", ip);

    requireAdmin(bad, 1_000);
    requireAdmin(bad, 2_000);

    const result = requireAdmin(requestWith(`Bearer ${validToken}`, ip), 12_500);
    expect(result).toEqual({ ok: true });
  });

  it("tracks lockouts per IP", () => {
    process.env.ADMIN_LOGIN_MAX_FAILS = "2";
    process.env.ADMIN_LOGIN_LOCK_MS = "60000";
    const ipA = "203.0.113.11";
    const ipB = "203.0.113.12";

    requireAdmin(requestWith("Bearer wrong", ipA), 1_000);
    requireAdmin(requestWith("Bearer wrong", ipA), 2_000);

    expect(requireAdmin(requestWith(`Bearer ${validToken}`, ipA), 3_000)).toEqual({ ok: false, status: 429, retryAfterSeconds: 59 });
    expect(requireAdmin(requestWith(`Bearer ${validToken}`, ipB), 3_000)).toEqual({ ok: true });
  });

  it("blocks IPs outside the allow-list even with a valid token", () => {
    process.env.ADMIN_ALLOWED_IPS = "10.0.0.1,10.0.0.2";
    const result = requireAdmin(requestWith(`Bearer ${validToken}`, "203.0.113.50"), 1_000);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("allows allow-listed IPs with a valid token", () => {
    process.env.ADMIN_ALLOWED_IPS = "10.0.0.1,10.0.0.2";
    const result = requireAdmin(requestWith(`Bearer ${validToken}`, "10.0.0.2"), 1_000);
    expect(result).toEqual({ ok: true });
  });

  it("does not register a failure for an allow-list-blocked IP", () => {
    process.env.ADMIN_ALLOWED_IPS = "10.0.0.1";
    process.env.ADMIN_LOGIN_MAX_FAILS = "2";
    process.env.ADMIN_LOGIN_LOCK_MS = "60000";
    const blocked = requestWith(`Bearer ${validToken}`, "203.0.113.99");

    requireAdmin(blocked, 1_000);
    requireAdmin(blocked, 2_000);

    // After switching the allow-list off, the prior IP-blocked 401s must not have counted as token failures.
    delete process.env.ADMIN_ALLOWED_IPS;
    const result = requireAdmin(requestWith(`Bearer ${validToken}`, "203.0.113.99"), 3_000);
    expect(result).toEqual({ ok: true });
  });
});
