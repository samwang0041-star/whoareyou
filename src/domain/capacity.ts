import type { UserState } from "./types";

export type CapacityInput = {
  activeConnections: number;
  waitingUsers: number;
  maxActiveConnections: number;
  maxWaitingUsers: number;
};

export function decideCapacityState(input: CapacityInput): Extract<UserState, "available" | "waiting" | "paused"> {
  if (input.activeConnections < input.maxActiveConnections) return "available";
  if (input.waitingUsers < input.maxWaitingUsers) return "waiting";
  return "paused";
}
