import type { RelayParticipantRole } from "@prisma/client";
import { prisma } from "../storage/prisma";
import { parseRelayCommand } from "./private-relay";

export type CreateRelayInviteInput = {
  aBotSessionId: string;
  now: Date;
  expiresAt: Date;
};

export type IssueRelayPeerQrInput = {
  inviteId: string;
  bBotSessionId: string;
  now: Date;
};

export type MarkRelayQrConfirmedInput = {
  inviteId: string;
  now: Date;
};

export type BindRelayParticipantInput = {
  inviteId: string;
  role: RelayParticipantRole;
  provider: string;
  providerUserHash: string;
  providerUserIdCiphertext: string;
  latestContextTokenCiphertext?: string;
  botSessionId: string;
  now: Date;
};

export type RelaySendMessage = {
  recipientParticipantId: string;
  body: string;
};

export type RelayPrivateMessageInput = {
  provider: string;
  providerUserHash: string;
  text: string;
  now: Date;
  send: (message: RelaySendMessage) => Promise<void>;
};

export type RelayPrivateMessageResult =
  | { status: "sent" }
  | { status: "disconnected" }
  | { status: "waiting_for_peer" }
  | { status: "not_connected" };

export async function createRelayInvite(input: CreateRelayInviteInput) {
  return prisma.relayInvite.create({
    data: {
      state: "a_qr_issued",
      aBotSessionId: input.aBotSessionId,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
}

export async function issueRelayPeerQr(input: IssueRelayPeerQrInput) {
  return prisma.relayInvite.updateMany({
    where: {
      id: input.inviteId,
      state: "a_bound",
      expiresAt: { gt: input.now },
    },
    data: {
      state: "b_qr_issued",
      bBotSessionId: input.bBotSessionId,
      bQrIssuedAt: input.now,
    },
  }).then(async (updated) => {
    if (updated.count !== 1) throw new Error("relay_peer_qr_not_issuable");
    return prisma.relayInvite.findUniqueOrThrow({ where: { id: input.inviteId } });
  });
}

export async function markRelayAConfirmed(input: MarkRelayQrConfirmedInput) {
  const updated = await prisma.relayInvite.updateMany({
    where: {
      id: input.inviteId,
      state: "a_qr_issued",
      expiresAt: { gt: input.now },
    },
    data: {
      state: "a_bound",
    },
  });
  if (updated.count !== 1) throw new Error("relay_a_not_confirmable");
  return prisma.relayInvite.findUniqueOrThrow({ where: { id: input.inviteId } });
}

export async function markRelayBConfirmed(input: MarkRelayQrConfirmedInput) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.relayInvite.updateMany({
      where: {
        id: input.inviteId,
        state: "b_qr_issued",
        expiresAt: { gt: input.now },
      },
      data: {
        state: "connected",
        connectedAt: input.now,
      },
    });
    if (updated.count !== 1) throw new Error("relay_b_not_confirmable");
    await tx.relayConnection.upsert({
      where: { inviteId: input.inviteId },
      create: {
        inviteId: input.inviteId,
        state: "active",
        startedAt: input.now,
      },
      update: {
        state: "active",
        closedAt: null,
        closeReason: null,
      },
    });
    return tx.relayInvite.findUniqueOrThrow({ where: { id: input.inviteId } });
  });
}

export async function bindRelayParticipant(input: BindRelayParticipantInput) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.relayInvite.findUnique({
      where: { id: input.inviteId },
      select: { id: true, state: true, expiresAt: true, bBotSessionId: true },
    });
    if (!invite || invite.expiresAt <= input.now || invite.state === "closed" || invite.state === "expired") {
      throw new Error("relay_invite_not_bindable");
    }
    if (input.role === "a" && invite.state !== "a_qr_issued") {
      throw new Error("relay_invite_not_bindable");
    }
    if (input.role === "b" && (invite.state !== "b_qr_issued" || invite.bBotSessionId !== input.botSessionId)) {
      throw new Error("relay_invite_not_bindable");
    }

    await tx.relayParticipant.create({
      data: {
        inviteId: input.inviteId,
        role: input.role,
        provider: input.provider,
        providerUserHash: input.providerUserHash,
        providerUserIdCiphertext: input.providerUserIdCiphertext,
        latestContextTokenCiphertext: input.latestContextTokenCiphertext,
        botSessionId: input.botSessionId,
        joinedAt: input.now,
        lastInboundAt: input.now,
      },
    });

    if (input.role === "a") {
      return tx.relayInvite.update({
        where: { id: input.inviteId },
        data: {
          state: "a_bound",
          aBotSessionId: input.botSessionId,
        },
      });
    }

    const updatedInvite = await tx.relayInvite.update({
      where: { id: input.inviteId },
      data: {
        state: "connected",
        bBotSessionId: input.botSessionId,
        connectedAt: input.now,
      },
    });
    await tx.relayConnection.upsert({
      where: { inviteId: input.inviteId },
      create: {
        inviteId: input.inviteId,
        state: "active",
        startedAt: input.now,
      },
      update: {
        state: "active",
        closedAt: null,
        closeReason: null,
      },
    });
    return updatedInvite;
  });
}

export async function relayPrivateMessage(input: RelayPrivateMessageInput): Promise<RelayPrivateMessageResult> {
  const participant = await findActiveParticipant(input.provider, input.providerUserHash);
  if (!participant) {
    return { status: "not_connected" };
  }

  const command = parseRelayCommand(input.text);
  if (command.kind === "disconnect") {
    await closeRelay({
      inviteId: participant.inviteId,
      now: input.now,
      send: input.send,
      peerParticipantId: peerParticipant(participant)?.id,
    });
    return { status: "disconnected" };
  }

  if (participant.invite.state === "a_bound" || participant.invite.state === "b_qr_issued") {
    return { status: "waiting_for_peer" };
  }
  if (participant.invite.state !== "connected" || participant.invite.connection?.state !== "active") {
    return { status: "not_connected" };
  }

  const peer = peerParticipant(participant);
  if (!peer) return { status: "not_connected" };

  await prisma.relayParticipant.update({
    where: { id: participant.id },
    data: { lastInboundAt: input.now },
  });
  await input.send({
    recipientParticipantId: peer.id,
    body: command.text,
  });
  return { status: "sent" };
}

async function closeRelay(input: {
  inviteId: string;
  now: Date;
  send: (message: RelaySendMessage) => Promise<void>;
  peerParticipantId?: string;
}) {
  if (input.peerParticipantId) {
    await input.send({
      recipientParticipantId: input.peerParticipantId,
      body: "对方断开了。这段关系已经消失。",
    });
  }

  await prisma.$transaction([
    prisma.relayInvite.update({
      where: { id: input.inviteId },
      data: {
        state: "closed",
        closeReason: "disconnected",
        closedAt: input.now,
      },
    }),
    prisma.relayConnection.updateMany({
      where: { inviteId: input.inviteId, state: { not: "closed" } },
      data: {
        state: "closed",
        closeReason: "disconnected",
        closedAt: input.now,
      },
    }),
    prisma.relayParticipant.updateMany({
      where: { inviteId: input.inviteId, deletedAt: null },
      data: { deletedAt: input.now },
    }),
  ]);
}

async function findActiveParticipant(provider: string, providerUserHash: string) {
  return prisma.relayParticipant.findFirst({
    where: {
      provider,
      providerUserHash,
      deletedAt: null,
    },
    include: {
      invite: {
        include: {
          connection: true,
          participants: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });
}

type ParticipantWithPeers = {
  id: string;
  role: RelayParticipantRole;
  invite: {
    participants: Array<{
      id: string;
      role: RelayParticipantRole;
    }>;
  };
};

function peerParticipant(participant: ParticipantWithPeers) {
  return participant.invite.participants.find((candidate) => candidate.role !== participant.role);
}
