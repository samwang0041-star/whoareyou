import type { UserState } from "./types";

export type UserSnapshot = {
  state: UserState;
  matchingEnabled: boolean;
};

export type UserEvent =
  | "open"
  | "continue"
  | "pause"
  | "matched"
  | "connection_closed"
  | "cooldown_done_reachable"
  | "cooldown_done_unreachable"
  | "provider_expired"
  | "blocked";

export function transitionUser(user: UserSnapshot, event: UserEvent): UserSnapshot {
  if (user.state === "blocked") return { state: "blocked", matchingEnabled: false };
  if (event === "blocked") return { state: "blocked", matchingEnabled: false };
  if (event === "provider_expired") return { state: "unreachable", matchingEnabled: false };
  if (event === "pause") return { state: "paused", matchingEnabled: false };
  if (event === "open" || event === "continue") return { state: "available", matchingEnabled: true };
  if (event === "matched") return { state: "matched", matchingEnabled: user.matchingEnabled };
  if (event === "connection_closed") return { state: "cooldown", matchingEnabled: user.matchingEnabled };
  if (event === "cooldown_done_reachable") return { state: "available", matchingEnabled: true };
  if (event === "cooldown_done_unreachable") return { state: "unreachable", matchingEnabled: false };
  return user;
}
