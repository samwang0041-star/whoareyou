export type ProviderPolicyInput = {
  replyWindowHours: number;
  sendQuota: number;
};

export type Reachability = {
  lastUserMessageAt: Date;
  reachableUntil: Date;
  providerSendQuota: number;
};

export function computeReachability(now: Date, input: ProviderPolicyInput): Reachability {
  return {
    lastUserMessageAt: now,
    reachableUntil: new Date(now.getTime() + input.replyWindowHours * 60 * 60 * 1000),
    providerSendQuota: input.sendQuota,
  };
}

export function minutesUntil(now: Date, target: Date): number {
  return Math.floor((target.getTime() - now.getTime()) / 60000);
}

export function canStartMatch(
  now: Date,
  reachableUntil: Date | null,
  requiredMinutes: number,
): boolean {
  if (!reachableUntil) return false;
  return minutesUntil(now, reachableUntil) >= requiredMinutes;
}

export function shouldSendRenewalPrompt(
  now: Date,
  reachableUntil: Date | null,
  promptBeforeMinutes: number,
): boolean {
  if (!reachableUntil) return false;
  const remaining = minutesUntil(now, reachableUntil);
  return remaining > 0 && remaining <= promptBeforeMinutes;
}

export function isProviderWindowExpired(now: Date, reachableUntil: Date | null): boolean {
  if (!reachableUntil) return true;
  return reachableUntil.getTime() <= now.getTime();
}
