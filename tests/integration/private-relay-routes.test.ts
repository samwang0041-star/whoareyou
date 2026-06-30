import { beforeEach, describe, expect, it } from "vitest";
import { GET as fakeScan } from "../../app/api/wechat/callback/route";
import { POST as createRelayInvite } from "../../app/api/relay/invites/route";
import { GET as getRelayInviteStatus } from "../../app/api/relay/invites/[id]/status/route";
import { POST as issueRelayPeerQrRoute } from "../../app/api/relay/invites/[id]/peer-qr/route";
import { prisma } from "../../src/storage/prisma";
import { resetRateLimitsForTest } from "../../src/web/rate-limit";

type RouteContext = {
  params: { id: string };
};

async function cleanDatabase() {
  await prisma.relayConnection.deleteMany();
  await prisma.relayParticipant.deleteMany();
  await prisma.relayInvite.deleteMany();
  await prisma.openClawBotSession.deleteMany();
}

async function withEnv<T>(updates: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("private relay routes", () => {
  beforeEach(async () => {
    resetRateLimitsForTest();
    await cleanDatabase();
  });

  it("does not expose B QR until A has scanned, then returns a handoff image instead of a share link", async () => {
    const createResponse = await createRelayInvite(new Request("http://local.test/api/relay/invites", { method: "POST" }));
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created).toMatchObject({
      state: "a_qr_issued",
      aQr: {
        provider: "openclaw-weixin",
        mode: "fake",
        status: "waiting_to_scan",
      },
    });
    expect(created).not.toHaveProperty("shareUrl");
    expect(created).not.toHaveProperty("bQr");

    const context: RouteContext = { params: { id: created.inviteId } };
    await expect(getRelayInviteStatus(new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`), context).then((response) => response.json())).resolves.toMatchObject({
      state: "a_waiting_to_scan",
    });

    const prematurePeerQr = await issueRelayPeerQrRoute(
      new Request(`http://local.test/api/relay/invites/${created.inviteId}/peer-qr`, { method: "POST" }),
      context,
    );
    expect(prematurePeerQr.status).toBe(409);
    await expect(prematurePeerQr.json()).resolves.toEqual({ error: "a_not_confirmed" });

    await fakeScan(new Request(created.aQr.qr.payloadUrl));

    await expect(getRelayInviteStatus(new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`), context).then((response) => response.json())).resolves.toMatchObject({
      state: "a_bound",
      canIssuePeerQr: true,
    });

    const peerQrResponse = await issueRelayPeerQrRoute(
      new Request(`http://local.test/api/relay/invites/${created.inviteId}/peer-qr`, { method: "POST" }),
      context,
    );
    expect(peerQrResponse.status).toBe(200);
    const peerQr = await peerQrResponse.json();
    expect(peerQr).toMatchObject({
      state: "waiting_for_b_scan",
      bQr: {
        mode: "fake",
        status: "waiting_to_scan",
      },
    });
    expect(peerQr.bQr.qr.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(peerQr).not.toHaveProperty("shareUrl");

    await fakeScan(new Request(peerQr.bQr.qr.payloadUrl));

    await expect(getRelayInviteStatus(new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`), context).then((response) => response.json())).resolves.toMatchObject({
      state: "connected",
    });
    await expect(prisma.relayConnection.count()).resolves.toBe(1);
  });

  it("rate-limits relay status polling without consuming peer QR capacity", async () => {
    await withEnv(
      {
        RATE_LIMIT_RELAY_STATUS_PER_WINDOW: "2",
        RATE_LIMIT_RELAY_STATUS_WINDOW_MS: "10000",
        RATE_LIMIT_RELAY_PEER_QR_PER_WINDOW: "1",
        RATE_LIMIT_RELAY_PEER_QR_WINDOW_MS: "10000",
      },
      async () => {
        const headers = { "x-forwarded-for": "203.0.113.77" };
        const createResponse = await createRelayInvite(
          new Request("http://local.test/api/relay/invites", { method: "POST", headers }),
        );
        const created = await createResponse.json();
        const context: RouteContext = { params: { id: created.inviteId } };

        await fakeScan(new Request(created.aQr.qr.payloadUrl, { headers }));

        const firstStatus = await getRelayInviteStatus(
          new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`, { headers }),
          context,
        );
        const secondStatus = await getRelayInviteStatus(
          new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`, { headers }),
          context,
        );
        const thirdStatus = await getRelayInviteStatus(
          new Request(`http://local.test/api/relay/invites/${created.inviteId}/status`, { headers }),
          context,
        );

        expect(firstStatus.status).toBe(200);
        expect(secondStatus.status).toBe(200);
        expect(thirdStatus.status).toBe(429);
        await expect(thirdStatus.json()).resolves.toEqual({ error: "rate_limited" });

        const peerQrResponse = await issueRelayPeerQrRoute(
          new Request(`http://local.test/api/relay/invites/${created.inviteId}/peer-qr`, { method: "POST", headers }),
          context,
        );

        expect(peerQrResponse.status).toBe(200);
        await expect(peerQrResponse.json()).resolves.toMatchObject({
          state: "waiting_for_b_scan",
          bQr: { mode: "fake" },
        });
      },
    );
  });
});
