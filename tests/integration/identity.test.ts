import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserFromInbound, hashProviderUserId } from "../../src/domain/identity";
import { prisma } from "../../src/storage/prisma";

describe("identity", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it("stores only a hash of provider identity and refreshes reachability", async () => {
    const user = await findOrCreateUserFromInbound({
      providerUserId: "wechat-openclaw-user-1",
      receivedAt: new Date("2026-06-29T10:00:00.000Z"),
      replyWindowHours: 24,
      sendQuota: 999,
    });

    expect(user.providerUserHash).toBe(hashProviderUserId("wechat-openclaw-user-1"));
    expect(user.providerUserHash).not.toContain("wechat-openclaw-user-1");
    expect(user.reachableUntil?.toISOString()).toBe("2026-06-30T10:00:00.000Z");
    expect(user.matchingEnabled).toBe(true);
    expect(user.state).toBe("available");
  });
});
