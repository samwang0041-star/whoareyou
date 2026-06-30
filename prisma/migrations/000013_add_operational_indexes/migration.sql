CREATE INDEX IF NOT EXISTS "User_state_matchingEnabled_reachableUntil_updatedAt_id_idx"
  ON "User"("state", "matchingEnabled", "reachableUntil", "updatedAt", "id");

CREATE INDEX IF NOT EXISTS "Connection_closeReason_idx"
  ON "Connection"("closeReason");

CREATE INDEX IF NOT EXISTS "Report_reason_idx"
  ON "Report"("reason");

CREATE INDEX IF NOT EXISTS "Report_connectionId_createdAt_idx"
  ON "Report"("connectionId", "createdAt");

CREATE INDEX IF NOT EXISTS "InboundDedupe_status_idx"
  ON "InboundDedupe"("status");

CREATE INDEX IF NOT EXISTS "MessageOutbox_status_createdAt_idx"
  ON "MessageOutbox"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "MessageOutbox_connectionId_status_idx"
  ON "MessageOutbox"("connectionId", "status");

CREATE INDEX IF NOT EXISTS "MessageOutbox_connectionId_createdAt_idx"
  ON "MessageOutbox"("connectionId", "createdAt");

CREATE INDEX IF NOT EXISTS "MessageOutbox_recipientUserId_status_idx"
  ON "MessageOutbox"("recipientUserId", "status");

CREATE INDEX IF NOT EXISTS "ScheduledJob_status_lockedAt_idx"
  ON "ScheduledJob"("status", "lockedAt");

CREATE INDEX IF NOT EXISTS "ScheduledJob_connectionId_runAt_idx"
  ON "ScheduledJob"("connectionId", "runAt");

CREATE INDEX IF NOT EXISTS "Echo_connectionId_createdAt_idx"
  ON "Echo"("connectionId", "createdAt");

CREATE INDEX IF NOT EXISTS "RateLimitEvent_createdAt_idx"
  ON "RateLimitEvent"("createdAt");

CREATE INDEX IF NOT EXISTS "RateLimitEvent_userId_eventType_createdAt_idx"
  ON "RateLimitEvent"("userId", "eventType", "createdAt");

CREATE INDEX IF NOT EXISTS "AppError_createdAt_idx"
  ON "AppError"("createdAt");

CREATE INDEX IF NOT EXISTS "AppError_resolvedAt_severity_idx"
  ON "AppError"("resolvedAt", "severity");
