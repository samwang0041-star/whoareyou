import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getConnectionDetailRoute } from "../../app/api/admin/connections/[id]/route";
import { GET as getHealthRoute } from "../../app/api/admin/health/route";
import { prisma } from "../../src/storage/prisma";
import {
  getConnectionDetail,
  getHealthMetrics,
  getSafetyMetrics,
  listConnections,
} from "../../src/workers/admin-details";

const now = new Date("2026-06-30T10:00:00.000Z");
const anonymousIdPattern = /^u_[a-f0-9]{12}$/;

async function cleanDatabase() {
  await prisma.metricSnapshot.deleteMany();
  await prisma.workerHeartbeat.deleteMany();
  await prisma.appError.deleteMany();
  await prisma.rateLimitEvent.deleteMany();
  await prisma.inboundDedupe.deleteMany();
  await prisma.echo.deleteMany();
  await prisma.report.deleteMany();
  await prisma.scheduledJob.deleteMany();
  await prisma.messageOutbox.deleteMany();
  await prisma.pairBlock.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser(providerUserHash: string, data: Omit<Prisma.UserCreateInput, "providerUserHash"> = {}) {
  return prisma.user.create({
    data: {
      providerUserHash,
      ...data,
    },
  });
}

async function createConnection(
  userAId: string,
  userBId: string,
  data: Omit<Prisma.ConnectionUncheckedCreateInput, "userAId" | "userBId"> = {},
) {
  return prisma.connection.create({
    data: {
      userAId,
      userBId,
      startedAt: now,
      ...data,
    },
  });
}

describe("admin detail metrics", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await cleanDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns anonymous connection detail without provider hashes, bodies, or idempotency keys", async () => {
    const userA = await createUser("abc123-provider-hash-should-not-appear", {
      state: "matched",
      matchingEnabled: false,
      reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
    });
    const userB = await createUser("def456-provider-hash-should-not-appear", {
      state: "matched",
      matchingEnabled: false,
      reachableUntil: new Date("2026-06-30T12:00:00.000Z"),
    });
    const connection = await createConnection(userA.id, userB.id, { state: "active" });

    await prisma.messageOutbox.createMany({
      data: [
        {
          connectionId: connection.id,
          recipientUserId: userA.id,
          idempotencyKey: "pending-idempotency-key-should-not-appear",
          status: "pending",
          bodyCiphertextOrBody: "pending body should not appear",
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: userB.id,
          idempotencyKey: "retrying-idempotency-key-should-not-appear",
          status: "retrying",
          bodyCiphertextOrBody: "retrying body should not appear",
          retryCount: 1,
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: userA.id,
          idempotencyKey: "sending-idempotency-key-should-not-appear",
          status: "sending",
          bodyCiphertextOrBody: "sending body should not appear",
          nextAttemptAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: userB.id,
          idempotencyKey: "sent-idempotency-key-should-not-appear",
          status: "sent",
          bodyCiphertextOrBody: "sent body should not appear",
          nextAttemptAt: now,
          sentAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: userA.id,
          idempotencyKey: "failed-idempotency-key-should-not-appear",
          status: "failed",
          bodyCiphertextOrBody: "failed body should not appear",
          nextAttemptAt: now,
          failedAt: now,
        },
        {
          connectionId: connection.id,
          recipientUserId: userB.id,
          idempotencyKey: "expired-idempotency-key-should-not-appear",
          status: "provider_window_expired",
          bodyCiphertextOrBody: null,
          nextAttemptAt: now,
          providerWindowCheckedAt: now,
        },
      ],
    });
    await prisma.echo.create({
      data: {
        connectionId: connection.id,
        fromUserId: userA.id,
        toUserId: userB.id,
        body: "echo body should not appear",
        createdAt: now,
      },
    });
    await prisma.scheduledJob.create({
      data: {
        connectionId: connection.id,
        type: "close_connection",
        runAt: new Date("2026-06-30T11:00:00.000Z"),
        idempotencyKey: "scheduled-job-idempotency-key-should-not-appear",
      },
    });
    await prisma.report.create({
      data: {
        reporterUserId: userA.id,
        reportedUserId: userB.id,
        connectionId: connection.id,
        reason: "user_requested",
        createdAt: now,
      },
    });

    const detail = await getConnectionDetail(connection.id);

    expect(detail).not.toBeNull();
    if (!detail) throw new Error("expected connection detail");

    const [anonymousA, anonymousB] = detail.participants.map((participant) => participant.anonymousId);
    expect(anonymousA).toMatch(anonymousIdPattern);
    expect(anonymousB).toMatch(anonymousIdPattern);
    expect(anonymousA).not.toBe(anonymousB);

    expect(detail).toMatchObject({
      id: connection.id,
      state: "active",
      participants: [
        { role: "A", anonymousId: anonymousA, state: "matched", matchingEnabled: false },
        { role: "B", anonymousId: anonymousB, state: "matched", matchingEnabled: false },
      ],
      outboxSummary: {
        total: 6,
        pending: 1,
        retrying: 1,
        sending: 1,
        sent: 1,
        failed: 1,
        providerWindowExpired: 1,
        backlog: 3,
      },
      reportCount: 1,
      echoCount: 1,
    });
    expect(detail?.echoes).toEqual([
      {
        id: expect.any(String),
        fromAnonymousId: anonymousA,
        toAnonymousId: anonymousB,
        createdAt: now.toISOString(),
      },
    ]);
    expect(detail?.reports).toEqual([
      {
        id: expect.any(String),
        reporterAnonymousId: anonymousA,
        reportedAnonymousId: anonymousB,
        reason: "user_requested",
        createdAt: now.toISOString(),
      },
    ]);
    expect(detail?.scheduledJobs).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: "close_connection",
        status: "pending",
        runAt: "2026-06-30T11:00:00.000Z",
      }),
    ]);

    const serialized = JSON.stringify(detail);
    expect(serialized).toContain(anonymousA);
    expect(serialized).toContain(anonymousB);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("def456");
    expect(serialized).not.toContain("provider-hash-should-not-appear");
    expect(serialized).not.toContain("body should not appear");
    expect(serialized).not.toContain("idempotency-key-should-not-appear");
  });

  it("lists newest connections with an optional state filter and a sensible limit", async () => {
    const activeConnections = [];

    for (let index = 0; index < 52; index += 1) {
      const userA = await createUser(`list-active-${index}-a`);
      const userB = await createUser(`list-active-${index}-b`);
      activeConnections.push(
        await createConnection(userA.id, userB.id, {
          state: "active",
          startedAt: new Date(now.getTime() + index * 60_000),
        }),
      );
    }
    const closedUserA = await createUser("list-closed-a");
    const closedUserB = await createUser("list-closed-b");
    const closedConnection = await createConnection(closedUserA.id, closedUserB.id, {
      state: "closed",
      startedAt: new Date(now.getTime() + 60 * 60_000),
      closedAt: new Date(now.getTime() + 61 * 60_000),
      closeReason: "timeout",
    });

    const allConnections = await listConnections();
    const activeOnly = await listConnections("active");
    const closedOnly = await listConnections("closed");

    expect(allConnections).toHaveLength(50);
    expect(allConnections[0]).toMatchObject({ id: closedConnection.id, state: "closed" });
    expect(allConnections.map((connection) => connection.id)).not.toContain(activeConnections[0].id);
    expect(allConnections.map((connection) => connection.id)).not.toContain(activeConnections[1].id);
    expect(activeOnly).toHaveLength(50);
    expect(activeOnly.every((connection) => connection.state === "active")).toBe(true);
    expect(activeOnly[0].id).toBe(activeConnections[51].id);
    expect(closedOnly).toHaveLength(1);
    expect(closedOnly[0]).toMatchObject({ id: closedConnection.id, state: "closed" });
    expect(closedOnly[0].participantAnonymousIds[0]).toMatch(anonymousIdPattern);
    expect(closedOnly[0].participantAnonymousIds[1]).toMatch(anonymousIdPattern);
    expect(JSON.stringify(closedOnly)).not.toContain("list-closed");
  });

  it("counts health signals for callbacks, outbox backlog, active errors, and worker heartbeats", async () => {
    const user = await createUser("health-user");
    await prisma.inboundDedupe.createMany({
      data: [
        { providerMessageKey: "callback-processed", status: "processed", receivedAt: now, processedAt: now, duplicateCount: 2 },
        { providerMessageKey: "callback-duplicate", status: "duplicate", receivedAt: now, processedAt: now },
        { providerMessageKey: "callback-failed", status: "failed", receivedAt: now, processedAt: now },
      ],
    });
    await prisma.messageOutbox.createMany({
      data: [
        { recipientUserId: user.id, idempotencyKey: "health-pending", status: "pending", nextAttemptAt: now },
        { recipientUserId: user.id, idempotencyKey: "health-retrying-1", status: "retrying", nextAttemptAt: now },
        { recipientUserId: user.id, idempotencyKey: "health-retrying-2", status: "retrying", nextAttemptAt: now },
        { recipientUserId: user.id, idempotencyKey: "health-sending", status: "sending", nextAttemptAt: now },
        { recipientUserId: user.id, idempotencyKey: "health-sent", status: "sent", nextAttemptAt: now },
        { recipientUserId: user.id, idempotencyKey: "health-failed", status: "failed", nextAttemptAt: now },
        {
          recipientUserId: user.id,
          idempotencyKey: "health-provider-window-expired",
          status: "provider_window_expired",
          nextAttemptAt: now,
        },
      ],
    });
    await prisma.appError.createMany({
      data: [
        { source: "callback", severity: "error", fingerprint: "active-1", message: "active" },
        { source: "outbox", severity: "critical", fingerprint: "active-2", message: "active" },
        { source: "worker", severity: "warn", fingerprint: "resolved", message: "resolved", resolvedAt: now },
      ],
    });
    await prisma.workerHeartbeat.createMany({
      data: [
        {
          workerName: "outbox",
          status: "ok",
          lastSeenAt: now,
          metadataJson: {
            processed: 3,
            providerUserHash: "worker-provider-hash-should-not-appear",
            bodyCiphertextOrBody: "worker body should not appear",
            idempotencyKey: "worker-idempotency-key-should-not-appear",
          },
        },
        {
          workerName: "scheduled-jobs",
          status: "lagging",
          lastSeenAt: new Date("2026-06-30T09:55:00.000Z"),
        },
      ],
    });

    const health = await getHealthMetrics();

    expect(health).toMatchObject({
      callbacksTotal: 3,
      callbackDuplicates: 3,
      callbackFailed: 1,
      outbox: {
        total: 7,
        pending: 1,
        retrying: 2,
        sending: 1,
        sent: 1,
        failed: 1,
        providerWindowExpired: 1,
        backlog: 4,
      },
      providerWindowExpiredCount: 1,
      activeAppErrors: 2,
      workerHeartbeatCount: 2,
    });
    expect(health.workerHeartbeats).toEqual([
      {
        workerName: "outbox",
        status: "ok",
        lastSeenAt: now.toISOString(),
        metadataPresent: true,
      },
      {
        workerName: "scheduled-jobs",
        status: "lagging",
        lastSeenAt: "2026-06-30T09:55:00.000Z",
        metadataPresent: false,
      },
    ]);
    expect(JSON.stringify(health)).not.toContain("worker-provider-hash-should-not-appear");
    expect(JSON.stringify(health)).not.toContain("worker body should not appear");
    expect(JSON.stringify(health)).not.toContain("worker-idempotency-key-should-not-appear");
  });

  it("counts safety reports, blocked users, close reasons, and near-block reported users", async () => {
    const reporters = await Promise.all([
      createUser("reporter-1"),
      createUser("reporter-2"),
      createUser("reporter-3"),
      createUser("reporter-4"),
      createUser("reporter-5"),
    ]);
    const nearBlockUser = await createUser("nearb1-provider-hash-should-not-appear");
    const blockedUser = await createUser("block1-provider-hash-should-not-appear", {
      state: "blocked",
      matchingEnabled: false,
      blockedAt: now,
    });

    const nearConnections = await Promise.all([
      createConnection(reporters[0].id, nearBlockUser.id, { state: "awaiting_echo", closeReason: "reported", closedAt: now }),
      createConnection(reporters[1].id, nearBlockUser.id, { state: "closed", closeReason: "left", closedAt: now }),
    ]);
    const blockedConnections = await Promise.all([
      createConnection(reporters[2].id, blockedUser.id, { state: "closed", closeReason: "timeout", closedAt: now }),
      createConnection(reporters[3].id, blockedUser.id, { state: "closed", closeReason: "provider_expired", closedAt: now }),
      createConnection(reporters[4].id, blockedUser.id, { state: "closed", closeReason: "reported", closedAt: now }),
    ]);
    await prisma.report.createMany({
      data: [
        {
          reporterUserId: reporters[0].id,
          reportedUserId: nearBlockUser.id,
          connectionId: nearConnections[0].id,
          reason: "user_requested",
          createdAt: now,
        },
        {
          reporterUserId: reporters[1].id,
          reportedUserId: nearBlockUser.id,
          connectionId: nearConnections[1].id,
          reason: "unsafe",
          createdAt: now,
        },
        {
          reporterUserId: reporters[2].id,
          reportedUserId: blockedUser.id,
          connectionId: blockedConnections[0].id,
          reason: "user_requested",
          createdAt: now,
        },
        {
          reporterUserId: reporters[3].id,
          reportedUserId: blockedUser.id,
          connectionId: blockedConnections[1].id,
          reason: "unsafe",
          createdAt: now,
        },
        {
          reporterUserId: reporters[4].id,
          reportedUserId: blockedUser.id,
          connectionId: blockedConnections[2].id,
          reason: "unsafe",
          createdAt: now,
        },
      ],
    });

    const safety = await getSafetyMetrics();

    expect(safety).toMatchObject({
      totalReports: 5,
      blockedUsers: 1,
      nearBlockThreshold: 3,
      nearBlockReportedUserCount: 1,
      reportsByReason: [
        { reason: "unsafe", count: 3 },
        { reason: "user_requested", count: 2 },
      ],
      connectionCloseReasons: {
        timeout: 1,
        left: 1,
        reported: 2,
        providerExpired: 1,
      },
    });
    expect(safety.nearBlockReportedUsers).toHaveLength(1);
    expect(safety.nearBlockReportedUsers[0]).toMatchObject({ reportCount: 2 });
    expect(safety.nearBlockReportedUsers[0].anonymousId).toMatch(anonymousIdPattern);
    expect(JSON.stringify(safety)).not.toContain("nearb1");
    expect(JSON.stringify(safety)).not.toContain("block1");
    expect(JSON.stringify(safety)).not.toContain("provider-hash-should-not-appear");
  });

  it("protects admin detail APIs and returns 404 for a missing connection detail", async () => {
    vi.stubEnv("ADMIN_TOKEN", "test-admin-token");

    const unauthorized = await getHealthRoute(new Request("http://local.test/api/admin/health"));
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "unauthorized" });

    const authorized = await getHealthRoute(
      new Request("http://local.test/api/admin/health", {
        headers: { authorization: "Bearer test-admin-token" },
      }),
    );
    expect(authorized.status).toBe(200);

    const missing = await getConnectionDetailRoute(
      new Request("http://local.test/api/admin/connections/missing-connection", {
        headers: { authorization: "Bearer test-admin-token" },
      }),
      { params: { id: "missing-connection" } },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "connection_not_found" });
  });
});
