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

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
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

    await tx.scheduledJob.upsert({
      where: { idempotencyKey: `reachability-renewal:${user.id}` },
      create: {
        userId: user.id,
        type: "reachability_renewal_prompt",
        runAt: reachabilityRenewalRunAt(reachability.reachableUntil),
        idempotencyKey: `reachability-renewal:${user.id}`,
      },
      update: {
        runAt: reachabilityRenewalRunAt(reachability.reachableUntil),
        status: "pending",
        attempts: 0,
        lockedAt: null,
        completedAt: null,
      },
    });

    return user;
  });
}

function reachabilityRenewalRunAt(reachableUntil: Date): Date {
  const promptBeforeMinutes = Number(process.env.REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES ?? 60);
  return new Date(reachableUntil.getTime() - promptBeforeMinutes * 60_000);
}
