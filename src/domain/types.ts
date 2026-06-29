export type UserState =
  | "new"
  | "available"
  | "waiting"
  | "matched"
  | "cooldown"
  | "paused"
  | "unreachable"
  | "blocked";

export type ConnectionState = "active" | "ending" | "awaiting_echo" | "closed";

export type CloseReason = "timeout" | "left" | "reported" | "provider_expired";

export type OutboxStatus =
  | "pending"
  | "retrying"
  | "sending"
  | "sent"
  | "failed"
  | "provider_window_expired";

export type ScheduledJobType =
  | "reminder_10"
  | "reminder_20"
  | "reminder_30"
  | "reminder_40"
  | "reminder_50"
  | "close_connection"
  | "reachability_renewal_prompt"
  | "cooldown_release"
  | "outbox_body_cleanup"
  | "metric_snapshot";

export type Command = "open" | "continue" | "pause" | "leave" | "report" | "help" | "message";

export type NormalizedInboundEvent = {
  providerMessageKey: string;
  providerUserId: string;
  text: string;
  receivedAt: Date;
};

export type OutboundMessage = {
  recipientUserId: string;
  body: string;
  idempotencyKey: string;
};
