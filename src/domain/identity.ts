import { createHash } from "crypto";
import { prisma } from "../storage/prisma";
import { computeReachability } from "./provider-policy";

export function hashProviderUserId(providerUserId: string): string {
  return createHash("sha256").update(providerUserId).digest("hex");
}

export async function findOrCreateUserFromInbound(input: {
  providerUserId: string;
  receivedAt: Date;
  replyWindowHours: number;
  sendQuota: number;
}) {
  const providerUserHash = hashProviderUserId(input.providerUserId);
  const reachability = computeReachability(input.receivedAt, {
    replyWindowHours: input.replyWindowHours,
    sendQuota: input.sendQuota,
  });

  return prisma.user.upsert({
    where: { providerUserHash },
    create: {
      providerUserHash,
      state: "available",
      matchingEnabled: true,
      lastSeenAt: input.receivedAt,
      lastUserMessageAt: reachability.lastUserMessageAt,
      reachableUntil: reachability.reachableUntil,
      providerSendQuota: reachability.providerSendQuota,
    },
    update: {
      lastSeenAt: input.receivedAt,
      lastUserMessageAt: reachability.lastUserMessageAt,
      reachableUntil: reachability.reachableUntil,
      providerSendQuota: reachability.providerSendQuota,
      matchingEnabled: true,
      state: "available",
    },
  });
}
