import { randomUUID } from "crypto";
import { decryptProviderCredential, encryptProviderCredential } from "../adapters/openclaw-credentials";
import {
  openClawWeixinProvider,
  sendOpenClawWeixinMessage,
} from "../adapters/openclaw-weixin-runtime";
import type { OpenClawUpdatesWorkerConfig } from "../config";
import { prisma } from "../storage/prisma";
import { hashProviderUserId } from "./identity";
import { markRelayAConfirmed, markRelayBConfirmed, relayPrivateMessage } from "./private-relay-service";
import type { NormalizedInboundEvent } from "./types";

export type HandleRelayInboundInput = {
  event: NormalizedInboundEvent;
  botSessionId: string;
  contextToken?: string;
  config: OpenClawUpdatesWorkerConfig;
};

export async function handleRelayInbound(input: HandleRelayInboundInput) {
  const providerUserHash = hashProviderUserId(input.event.providerUserId);
  await ensureRelayParticipantFromInbound({
    event: input.event,
    botSessionId: input.botSessionId,
    contextToken: input.contextToken,
    providerUserHash,
    config: input.config,
  });

  return relayPrivateMessage({
    provider: openClawWeixinProvider,
    providerUserHash,
    text: input.event.text,
    now: input.event.receivedAt,
    send: (message) =>
      sendRelayMessageToParticipant({
        participantId: message.recipientParticipantId,
        body: message.body,
        config: input.config,
      }),
  });
}

async function ensureRelayParticipantFromInbound(input: {
  event: NormalizedInboundEvent;
  botSessionId: string;
  contextToken?: string;
  providerUserHash: string;
  config: OpenClawUpdatesWorkerConfig;
}) {
  const encryptedProviderUserId = encryptProviderCredential(
    input.event.providerUserId,
    input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET,
  );
  const encryptedContextToken = input.contextToken
    ? encryptProviderCredential(input.contextToken, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
    : undefined;

  const existing = await prisma.relayParticipant.findFirst({
    where: {
      provider: openClawWeixinProvider,
      providerUserHash: input.providerUserHash,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.relayParticipant.update({
      where: { id: existing.id },
      data: {
        providerUserIdCiphertext: encryptedProviderUserId,
        latestContextTokenCiphertext: encryptedContextToken,
        lastInboundAt: input.event.receivedAt,
      },
    });
    return;
  }

  const invite = await prisma.relayInvite.findFirst({
    where: {
      OR: [{ aBotSessionId: input.botSessionId }, { bBotSessionId: input.botSessionId }],
      state: { in: ["a_qr_issued", "a_bound", "b_qr_issued", "connected"] },
      closedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!invite) return;

  const role = invite.aBotSessionId === input.botSessionId ? "a" : "b";
  if (role === "a" && invite.state === "a_qr_issued") {
    await markRelayAConfirmed({ inviteId: invite.id, now: input.event.receivedAt });
  }
  if (role === "b" && invite.state === "b_qr_issued") {
    await markRelayBConfirmed({ inviteId: invite.id, now: input.event.receivedAt });
  }

  await prisma.relayParticipant.create({
    data: {
      inviteId: invite.id,
      role,
      provider: openClawWeixinProvider,
      providerUserHash: input.providerUserHash,
      providerUserIdCiphertext: encryptedProviderUserId,
      latestContextTokenCiphertext: encryptedContextToken,
      botSessionId: input.botSessionId,
      joinedAt: input.event.receivedAt,
      lastInboundAt: input.event.receivedAt,
    },
  });
}

async function sendRelayMessageToParticipant(input: {
  participantId: string;
  body: string;
  config: OpenClawUpdatesWorkerConfig;
}) {
  const participant = await prisma.relayParticipant.findUnique({
    where: { id: input.participantId },
    select: {
      providerUserIdCiphertext: true,
      latestContextTokenCiphertext: true,
      botSessionId: true,
    },
  });
  if (!participant) throw new Error("relay_participant_missing");
  const session = await prisma.openClawBotSession.findUnique({
    where: { id: participant.botSessionId },
    select: {
      botTokenCiphertext: true,
      baseUrl: true,
      ilinkUserId: true,
    },
  });
  if (!session?.botTokenCiphertext) throw new Error("relay_bot_session_missing");

  await sendOpenClawWeixinMessage({
    baseUrl: session.baseUrl,
    botToken: decryptProviderCredential(session.botTokenCiphertext, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    ilinkUserId: session.ilinkUserId
      ? decryptProviderCredential(session.ilinkUserId, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
      : null,
    clientVersion: input.config.OPENCLAW_WEIXIN_CLIENT_VERSION,
    timeoutMs: input.config.OPENCLAW_SEND_TIMEOUT_MS,
    toUserId: decryptProviderCredential(participant.providerUserIdCiphertext, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET),
    clientId: `relay:${randomUUID()}`,
    text: input.body,
    contextToken: participant.latestContextTokenCiphertext
      ? decryptProviderCredential(participant.latestContextTokenCiphertext, input.config.PROVIDER_CREDENTIAL_ENCRYPTION_SECRET)
      : undefined,
  });
}
