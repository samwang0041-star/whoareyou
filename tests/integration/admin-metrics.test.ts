import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdminPage from "../../app/admin/page";
import { GET as getOverviewRoute } from "../../app/api/admin/overview/route";
import { prisma } from "../../src/storage/prisma";
import { getAdminOverview } from "../../src/workers/admin-metrics";

const now = new Date("2026-06-30T10:00:00.000Z");
const oldCreatedAt = new Date("2026-06-30T08:00:00.000Z");

async function cleanDatabase() {
  await prisma.inboundDedupe.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
}

describe("admin overview metrics", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reports aggregate overview metrics without provider identity or chat bodies", async () => {
    await prisma.user.create({
      data: {
        providerUserHash: "raw-provider-hash-should-not-appear",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: new Date("2026-06-30T09:55:00.000Z"),
      },
    });
    const waitingUser = await prisma.user.create({
      data: {
        providerUserHash: "waiting-provider-hash-should-not-appear",
        state: "waiting",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T11:30:00.000Z"),
        createdAt: oldCreatedAt,
        lastSeenAt: new Date("2026-06-30T09:58:00.000Z"),
      },
    });
    const expiringUser = await prisma.user.create({
      data: {
        providerUserHash: "expiring-provider-hash-should-not-appear",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T10:45:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const activeUserA = await prisma.user.create({
      data: {
        providerUserHash: "active-a-provider-hash-should-not-appear",
        state: "matched",
        matchingEnabled: false,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const activeUserB = await prisma.user.create({
      data: {
        providerUserHash: "active-b-provider-hash-should-not-appear",
        state: "matched",
        matchingEnabled: false,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const endingUserA = await prisma.user.create({
      data: {
        providerUserHash: "ending-a-provider-hash-should-not-appear",
        state: "matched",
        matchingEnabled: false,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const endingUserB = await prisma.user.create({
      data: {
        providerUserHash: "ending-b-provider-hash-should-not-appear",
        state: "matched",
        matchingEnabled: false,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const closedUserA = await prisma.user.create({
      data: {
        providerUserHash: "closed-a-provider-hash-should-not-appear",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const closedUserB = await prisma.user.create({
      data: {
        providerUserHash: "closed-b-provider-hash-should-not-appear",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const leftUserA = await prisma.user.create({
      data: {
        providerUserHash: "left-a-provider-hash-should-not-appear",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const leftUserB = await prisma.user.create({
      data: {
        providerUserHash: "left-b-provider-hash-should-not-appear",
        state: "cooldown",
        matchingEnabled: true,
        reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
        createdAt: oldCreatedAt,
      },
    });
    const blockedUser = await prisma.user.create({
      data: {
        providerUserHash: "blocked-provider-hash-should-not-appear",
        state: "blocked",
        matchingEnabled: false,
        blockedAt: now,
        createdAt: oldCreatedAt,
      },
    });

    const activeConnection = await prisma.connection.create({
      data: {
        userAId: activeUserA.id,
        userBId: activeUserB.id,
        state: "active",
        startedAt: new Date("2026-06-30T09:30:00.000Z"),
      },
    });
    await prisma.connection.create({
      data: {
        userAId: endingUserA.id,
        userBId: endingUserB.id,
        state: "ending",
        startedAt: new Date("2026-06-30T09:05:00.000Z"),
        endingAt: new Date("2026-06-30T09:55:00.000Z"),
      },
    });
    const timeoutConnection = await prisma.connection.create({
      data: {
        userAId: closedUserA.id,
        userBId: closedUserB.id,
        state: "awaiting_echo",
        startedAt: new Date("2026-06-30T08:00:00.000Z"),
        closedAt: new Date("2026-06-30T09:00:00.000Z"),
        closeReason: "timeout",
      },
    });
    await prisma.connection.create({
      data: {
        userAId: leftUserA.id,
        userBId: leftUserB.id,
        state: "closed",
        startedAt: new Date("2026-06-30T08:30:00.000Z"),
        closedAt: new Date("2026-06-30T08:40:00.000Z"),
        closeReason: "left",
      },
    });

    await prisma.echo.create({
      data: {
        connectionId: timeoutConnection.id,
        fromUserId: closedUserA.id,
        toUserId: closedUserB.id,
        body: "echo body should not appear",
      },
    });
    await prisma.messageOutbox.createMany({
      data: [
        {
          connectionId: activeConnection.id,
          recipientUserId: activeUserA.id,
          idempotencyKey: "admin-pending-outbox",
          status: "pending",
          bodyCiphertextOrBody: "pending body should not appear",
          nextAttemptAt: now,
          createdAt: new Date("2026-06-30T09:57:00.000Z"),
        },
        {
          connectionId: activeConnection.id,
          recipientUserId: activeUserB.id,
          idempotencyKey: "admin-sending-outbox",
          status: "sending",
          bodyCiphertextOrBody: "sending body should not appear",
          nextAttemptAt: now,
        },
        {
          recipientUserId: waitingUser.id,
          idempotencyKey: "admin-retrying-outbox",
          status: "retrying",
          bodyCiphertextOrBody: "retrying body should not appear",
          nextAttemptAt: now,
        },
        {
          recipientUserId: expiringUser.id,
          idempotencyKey: "admin-window-expired-outbox",
          status: "provider_window_expired",
          bodyCiphertextOrBody: null,
          nextAttemptAt: now,
        },
      ],
    });
    await prisma.scheduledJob.create({
      data: {
        userId: waitingUser.id,
        type: "reachability_renewal_prompt",
        runAt: new Date("2026-06-30T09:57:30.000Z"),
        idempotencyKey: "admin-lagging-job",
      },
    });
    await prisma.report.create({
      data: {
        reporterUserId: closedUserA.id,
        reportedUserId: blockedUser.id,
        connectionId: timeoutConnection.id,
        reason: "unsafe",
        createdAt: new Date("2026-06-30T09:30:00.000Z"),
      },
    });

    const overview = await getAdminOverview({
      now,
      minReachableMinutesToMatch: 70,
      renewalPromptBeforeMinutes: 60,
    });

    expect(overview).toMatchObject({
      scannedUsers: 1,
      recentUsers: 2,
      matchingEnabledUsers: 7,
      openUsers: 3,
      reachableUsers: 2,
      waitingUsers: 3,
      activeConnections: 1,
      endingConnections: 1,
      currentMatchedUsers: 4,
      expiringReachabilityUsers: 1,
      outboxPending: 1,
      outboxSending: 1,
      outboxRetrying: 1,
      providerWindowExpiredCount: 1,
      reportCount: 1,
      blockedUsers: 1,
      closedConnections: 2,
      timeoutClosedConnections: 1,
      oneHourCompletionRate: 0.5,
      echoedClosedConnections: 1,
      echoRate: 0.5,
      scheduledJobLagSeconds: 150,
    });
    expect(JSON.stringify(overview)).not.toContain("provider-hash-should-not-appear");
    expect(JSON.stringify(overview)).not.toContain("body should not appear");
  });

  it("protects the overview API with a bearer admin token", async () => {
    process.env.ADMIN_TOKEN = "test-admin-token";
    process.env.MIN_REACHABLE_MINUTES_TO_MATCH = "70";
    process.env.REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES = "60";

    await prisma.user.create({
      data: {
        providerUserHash: "api-provider-hash-should-not-appear",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date(Date.now() + 90 * 60_000),
      },
    });
    const unauthorized = await getOverviewRoute(new Request("http://local.test/api/admin/overview"));
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "unauthorized" });

    const authorized = await getOverviewRoute(
      new Request("http://local.test/api/admin/overview", {
        headers: { authorization: "Bearer test-admin-token" },
      }),
    );

    expect(authorized.status).toBe(200);
    const body = await authorized.json();
    expect(body.reachableUsers).toBe(1);
    expect(JSON.stringify(body)).not.toContain("api-provider-hash-should-not-appear");
  });

  it("renders a quiet aggregate admin dashboard", async () => {
    process.env.MIN_REACHABLE_MINUTES_TO_MATCH = "70";
    process.env.REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES = "60";

    await prisma.user.create({
      data: {
        providerUserHash: "page-provider-hash-should-not-appear",
        state: "available",
        matchingEnabled: true,
        reachableUntil: new Date(Date.now() + 90 * 60_000),
      },
    });

    const markup = renderToStaticMarkup(createElement(AdminPage));

    expect(markup).toContain("运营监控");
    expect(markup).toContain("Admin token");
    expect(markup).toContain("不要把它优化成另一个让人停不下来的机器。");
    expect(markup).toContain("完整一小时完成率");
    expect(markup).toContain("入口可达率");
    expect(markup).toContain("当前匹配中");
    expect(markup).toContain("服务健康");
    expect(markup).toContain("安全");
    expect(markup).not.toContain("page-provider-hash-should-not-appear");
  });
});
