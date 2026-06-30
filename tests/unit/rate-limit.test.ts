import { afterEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimitsForTest } from "../../src/web/rate-limit";
import { getClientIp } from "../../src/web/client-ip";

describe("rate-limit sliding window", () => {
  afterEach(() => {
    resetRateLimitsForTest();
  });

  it("allows requests up to the limit within the window", () => {
    expect(checkRateLimit("ip:1.2.3.4", 3, 10_000, 1_000)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(checkRateLimit("ip:1.2.3.4", 3, 10_000, 2_000)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(checkRateLimit("ip:1.2.3.4", 3, 10_000, 3_000)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("rejects requests beyond the limit and reports retry-after", () => {
    checkRateLimit("ip:1.2.3.4", 2, 10_000, 1_000);
    checkRateLimit("ip:1.2.3.4", 2, 10_000, 2_000);
    const decision = checkRateLimit("ip:1.2.3.4", 2, 10_000, 3_000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(1_000 + 10_000 - 3_000);
  });

  it("allows again after the window slides past the oldest request", () => {
    checkRateLimit("ip:1.2.3.4", 2, 10_000, 1_000);
    checkRateLimit("ip:1.2.3.4", 2, 10_000, 2_000);
    expect(checkRateLimit("ip:1.2.3.4", 2, 10_000, 11_500).allowed).toBe(true);
  });

  it("tracks different keys independently", () => {
    checkRateLimit("ip:1.2.3.4", 1, 10_000, 1_000);
    expect(checkRateLimit("ip:1.2.3.4", 1, 10_000, 2_000).allowed).toBe(false);
    expect(checkRateLimit("ip:5.6.7.8", 1, 10_000, 2_000).allowed).toBe(true);
  });
});

describe("client-ip extraction", () => {
  it("prefers x-real-ip over spoofable x-forwarded-for entries", () => {
    const request = new Request("https://example.com/", {
      headers: {
        "x-real-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.1, 198.51.100.10",
      },
    });
    expect(getClientIp(request)).toBe("198.51.100.10");
  });

  it("uses the rightmost valid x-forwarded-for entry when x-real-ip is absent", () => {
    const request = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" },
    });
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com/", {
      headers: { "x-real-ip": "203.0.113.2" },
    });
    expect(getClientIp(request)).toBe("203.0.113.2");
  });

  it("returns empty string when no proxy headers are present", () => {
    const request = new Request("https://example.com/");
    expect(getClientIp(request)).toBe("");
  });

  it("ignores invalid proxy header values", () => {
    const request = new Request("https://example.com/", {
      headers: {
        "x-real-ip": "not-an-ip",
        "x-forwarded-for": "also-not-an-ip",
      },
    });
    expect(getClientIp(request)).toBe("");
  });
});
