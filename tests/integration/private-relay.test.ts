import { beforeEach, describe, expect, it } from "vitest";
import {
  bindRelayParticipant,
  createRelayInvite,
  issueRelayPeerQr,
  relayPrivateMessage,
} from "../../src/domain/private-relay-service";
import { prisma } from "../../src/storage/prisma";

const now = new Date("2026-06-30T10:00:00.000Z");
const expiresAt = new Date("2026-06-30T10:10:00.000Z");

async function cleanDatabase() {
  await prisma.messageOutbox.deleteMany();
  await prisma.relayConnection.deleteMany();
  await prisma.relayParticipant.deleteMany();
  await prisma.relayInvite.deleteMany();
  await prisma.openClawBotSession.deleteMany();
}

async function createBotSession(qrcode: string) {
  return prisma.openClawBotSession.create({
    data: {
      qrcode,
      status: "confirmed",
      expiresAt,
      botTokenCiphertext: `token:${qrcode}`,
    },
  });
}

describe("private relay service", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a disposable invite, waits after A scan, then relays after B scans without MessageOutbox", async () => {
    const aSession = await createBotSession("relay-a-session");
    const bSession = await createBotSession("relay-b-session");
    const invite = await createRelayInvite({
      aBotSessionId: aSession.id,
      now,
      expiresAt,
    });

    expect(invite).toMatchObject({
      state: "a_qr_issued",
      aBotSessionId: aSession.id,
      expiresAt,
    });

    await bindRelayParticipant({
      inviteId: invite.id,
      role: "a",
      provider: "openclaw-weixin",
      providerUserHash: "provider-user-a",
      providerUserIdCiphertext: "encrypted-a",
      botSessionId: aSession.id,
      now,
    });
    await expect(
      relayPrivateMessage({
        provider: "openclaw-weixin",
        providerUserHash: "provider-user-a",
        text: "is anyone there?",
        now,
        send: async () => {
          throw new Error("should_not_send_while_waiting_for_b");
        },
      }),
    ).resolves.toEqual({ status: "waiting_for_peer" });
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);

    await expect(
      issueRelayPeerQr({
        inviteId: invite.id,
        bBotSessionId: bSession.id,
        now,
      }),
    ).resolves.toMatchObject({
      state: "b_qr_issued",
      bBotSessionId: bSession.id,
      bQrIssuedAt: now,
    });

    await bindRelayParticipant({
      inviteId: invite.id,
      role: "b",
      provider: "openclaw-weixin",
      providerUserHash: "provider-user-b",
      providerUserIdCiphertext: "encrypted-b",
      botSessionId: bSession.id,
      now,
    });

    await expect(prisma.relayInvite.findUniqueOrThrow({ where: { id: invite.id } })).resolves.toMatchObject({
      state: "connected",
      bBotSessionId: bSession.id,
      connectedAt: now,
    });
    await expect(prisma.relayConnection.count({ where: { inviteId: invite.id, state: "active" } })).resolves.toBe(1);

    const sent: Array<{ recipientParticipantId: string; body: string }> = [];
    const result = await relayPrivateMessage({
      provider: "openclaw-weixin",
      providerUserHash: "provider-user-a",
      text: "hello from a",
      now,
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(result).toEqual({ status: "sent" });
    expect(sent).toEqual([
      {
        recipientParticipantId: expect.any(String),
        body: "hello from a",
      },
    ]);
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);
  });

  it("disconnects from either side and keeps the closed relay terminal", async () => {
    const aSession = await createBotSession("relay-disconnect-a");
    const bSession = await createBotSession("relay-disconnect-b");
    const invite = await createRelayInvite({
      aBotSessionId: aSession.id,
      now,
      expiresAt,
    });
    await bindRelayParticipant({
      inviteId: invite.id,
      role: "a",
      provider: "openclaw-weixin",
      providerUserHash: "disconnect-a",
      providerUserIdCiphertext: "encrypted-a",
      botSessionId: aSession.id,
      now,
    });
    await issueRelayPeerQr({
      inviteId: invite.id,
      bBotSessionId: bSession.id,
      now,
    });
    await bindRelayParticipant({
      inviteId: invite.id,
      role: "b",
      provider: "openclaw-weixin",
      providerUserHash: "disconnect-b",
      providerUserIdCiphertext: "encrypted-b",
      botSessionId: bSession.id,
      now,
    });

    const disconnect = await relayPrivateMessage({
      provider: "openclaw-weixin",
      providerUserHash: "disconnect-b",
      text: "/断开",
      now,
      send: async () => {},
    });

    expect(disconnect).toEqual({ status: "disconnected" });
    await expect(prisma.relayInvite.findUniqueOrThrow({ where: { id: invite.id } })).resolves.toMatchObject({
      state: "closed",
      closeReason: "disconnected",
      closedAt: now,
    });
    await expect(prisma.relayConnection.findFirstOrThrow({ where: { inviteId: invite.id } })).resolves.toMatchObject({
      state: "closed",
      closeReason: "disconnected",
      closedAt: now,
    });

    const sent: unknown[] = [];
    await expect(
      relayPrivateMessage({
        provider: "openclaw-weixin",
        providerUserHash: "disconnect-a",
        text: "still there?",
        now,
        send: async (message) => {
          sent.push(message);
        },
      }),
    ).resolves.toEqual({ status: "not_connected" });
    expect(sent).toEqual([]);
    await expect(prisma.messageOutbox.count()).resolves.toBe(0);
  });
});
