import { describe, expect, it } from "vitest";
import {
  canStartMatch,
  computeReachability,
  shouldSendRenewalPrompt,
} from "../../src/domain/provider-policy";

describe("provider policy", () => {
  it("refreshes a 24-hour reachability window from inbound user message", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    const result = computeReachability(now, { replyWindowHours: 24, sendQuota: 999 });
    expect(result.reachableUntil.toISOString()).toBe("2026-06-30T10:00:00.000Z");
    expect(result.providerSendQuota).toBe(999);
  });

  it("requires enough remaining reachability to start a one-hour match", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    expect(canStartMatch(now, new Date("2026-06-29T11:20:00.000Z"), 70)).toBe(true);
    expect(canStartMatch(now, new Date("2026-06-29T11:00:00.000Z"), 70)).toBe(false);
  });

  it("prompts renewal when the window is inside the prompt threshold", () => {
    const now = new Date("2026-06-29T10:00:00.000Z");
    expect(shouldSendRenewalPrompt(now, new Date("2026-06-29T10:59:00.000Z"), 60)).toBe(true);
    expect(shouldSendRenewalPrompt(now, new Date("2026-06-29T12:00:00.000Z"), 60)).toBe(false);
  });
});
