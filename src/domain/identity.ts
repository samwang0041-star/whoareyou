import { createHmac } from "crypto";
import { prisma } from "../storage/prisma";
import { computeReachability } from "./provider-policy";

export const providerUserHashDevelopmentSecret = "whoareyou-dev-provider-user-hash-secret";

export function hashProviderUserId(providerUserId: string): string {
  return createHmac("sha256", providerUserHashSecret()).update(providerUserId).digest("hex");
}

export async function findOrCreateUserFromInbound(input: {
  providerUserId: string;
  receivedAt: Date;
  replyWindowHours: number;
  sendQuota: number;
  preserveExistingState?: boolean;
}) {
  const providerUserHash = hashProviderUserId(input.providerUserId);
  const reachability = computeReachability(input.receivedAt, {
    replyWindowHours: input.replyWindowHours,
    sendQuota: input.sendQuota,
  });

  return prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { providerUserHash } });
    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            lastSeenAt: input.receivedAt,
            lastUserMessageAt: reachability.lastUserMessageAt,
            reachableUntil: reachability.reachableUntil,
            providerSendQuota: reachability.providerSendQuota,
          },
        })
      : await tx.user.create({
          data: {
            providerUserHash,
            state: "new",
            matchingEnabled: false,
            lastSeenAt: input.receivedAt,
            lastUserMessageAt: reachability.lastUserMessageAt,
            reachableUntil: reachability.reachableUntil,
            providerSendQuota: reachability.providerSendQuota,
          },
        });

    await upsertReachabilityJob(tx, {
      userId: user.id,
      idempotencyKey: `reachability-renewal:${user.id}`,
      runAt: reachabilityRenewalRunAt(reachability.reachableUntil),
    });
    await upsertReachabilityJob(tx, {
      userId: user.id,
      idempotencyKey: `reachability-expiry:${user.id}`,
      runAt: reachability.reachableUntil,
    });

    return user;
  });
}

type IdentityTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function upsertReachabilityJob(
  tx: IdentityTransaction,
  input: {
    userId: string;
    idempotencyKey: string;
    runAt: Date;
  },
) {
  await tx.scheduledJob.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      userId: input.userId,
      type: "reachability_renewal_prompt",
      runAt: input.runAt,
      idempotencyKey: input.idempotencyKey,
    },
    update: {
      runAt: input.runAt,
      status: "pending",
      attempts: 0,
      lockedAt: null,
      completedAt: null,
    },
  });
}

function reachabilityRenewalRunAt(reachableUntil: Date): Date {
  const promptBeforeMinutes = Number(process.env.REACHABILITY_RENEWAL_PROMPT_BEFORE_MINUTES ?? 60);
  return new Date(reachableUntil.getTime() - promptBeforeMinutes * 60_000);
}

function providerUserHashSecret(): string {
  const secret = process.env.PROVIDER_USER_HASH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PROVIDER_USER_HASH_SECRET is required");
  }
  return providerUserHashDevelopmentSecret;
}
