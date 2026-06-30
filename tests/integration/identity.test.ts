import { createHash, createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findOrCreateUserFromInbound, hashProviderUserId } from "../../src/domain/identity";
import { prisma } from "../../src/storage/prisma";

describe("identity", () => {
  beforeEach(async () => {
    vi.stubEnv("PROVIDER_USER_HASH_SECRET", "identity-test-provider-hash-secret");
    await prisma.echo.deleteMany();
    await prisma.report.deleteMany();
    await prisma.messageOutbox.deleteMany();
    await prisma.connection.deleteMany();
    await prisma.scheduledJob.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hashes provider user ids with the dedicated HMAC secret", () => {
    const providerUserId = "wechat-openclaw-user-secret-check";
    const expectedHmac = createHmac("sha256", "identity-test-provider-hash-secret").update(providerUserId).digest("hex");
    const bareSha = createHash("sha256").update(providerUserId).digest("hex");

    expect(hashProviderUserId(providerUserId)).toBe(expectedHmac);
    expect(hashProviderUserId(providerUserId)).not.toBe(bareSha);

    vi.stubEnv("ADMIN_TOKEN", "different-admin-token");
    expect(hashProviderUserId(providerUserId)).toBe(expectedHmac);
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
    expect(user.matchingEnabled).toBe(false);
    expect(user.state).toBe("new");
    const jobs = await prisma.scheduledJob.findMany({ orderBy: { idempotencyKey: "asc" } });
    expect(
      jobs.map((job) => ({
        userId: job.userId,
        type: job.type,
        runAt: job.runAt,
        idempotencyKey: job.idempotencyKey,
        status: job.status,
      })),
    ).toEqual([
      {
        userId: user.id,
        type: "reachability_renewal_prompt",
        runAt: new Date("2026-06-30T10:00:00.000Z"),
        idempotencyKey: `reachability-expiry:${user.id}`,
        status: "pending",
      },
      {
        userId: user.id,
        type: "reachability_renewal_prompt",
        runAt: new Date("2026-06-30T09:00:00.000Z"),
        idempotencyKey: `reachability-renewal:${user.id}`,
        status: "pending",
      },
    ]);
  });

  it("refreshes the renewal prompt when the user speaks again", async () => {
    const firstUser = await findOrCreateUserFromInbound({
      providerUserId: "wechat-openclaw-user-2",
      receivedAt: new Date("2026-06-29T10:00:00.000Z"),
      replyWindowHours: 24,
      sendQuota: 999,
    });
    await prisma.scheduledJob.updateMany({
      where: { userId: firstUser.id },
      data: {
        status: "completed",
        completedAt: new Date("2026-06-30T09:00:00.000Z"),
        attempts: 2,
      },
    });

    await findOrCreateUserFromInbound({
      providerUserId: "wechat-openclaw-user-2",
      receivedAt: new Date("2026-06-29T12:00:00.000Z"),
      replyWindowHours: 24,
      sendQuota: 999,
    });

    await expect(prisma.scheduledJob.findMany()).resolves.toHaveLength(2);
    await expect(
      prisma.scheduledJob.findUniqueOrThrow({
        where: { idempotencyKey: `reachability-renewal:${firstUser.id}` },
      }),
    ).resolves.toMatchObject({
      runAt: new Date("2026-06-30T11:00:00.000Z"),
      status: "pending",
      attempts: 0,
      completedAt: null,
    });
    await expect(
      prisma.scheduledJob.findUniqueOrThrow({
        where: { idempotencyKey: `reachability-expiry:${firstUser.id}` },
      }),
    ).resolves.toMatchObject({
      runAt: new Date("2026-06-30T12:00:00.000Z"),
      status: "pending",
      attempts: 0,
      completedAt: null,
    });
  });
});
