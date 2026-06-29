-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('new', 'available', 'waiting', 'matched', 'cooldown', 'paused', 'unreachable', 'blocked');

-- CreateEnum
CREATE TYPE "ConnectionState" AS ENUM ('active', 'ending', 'awaiting_echo', 'closed');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('timeout', 'left', 'reported', 'provider_expired');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'retrying', 'sent', 'failed', 'provider_window_expired');

-- CreateEnum
CREATE TYPE "ScheduledJobStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ScheduledJobType" AS ENUM ('reminder_10', 'reminder_20', 'reminder_30', 'reminder_40', 'reminder_50', 'close_connection', 'reachability_renewal_prompt', 'cooldown_release', 'outbox_body_cleanup', 'metric_snapshot');

-- CreateEnum
CREATE TYPE "PairBlockReason" AS ENUM ('left', 'reported');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "providerUserHash" TEXT NOT NULL,
    "state" "UserState" NOT NULL DEFAULT 'new',
    "matchingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUserMessageAt" TIMESTAMP(3),
    "reachableUntil" TIMESTAMP(3),
    "providerSendQuota" INTEGER NOT NULL DEFAULT 999,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "state" "ConnectionState" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endingAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" "CloseReason",

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairBlock" (
    "id" TEXT NOT NULL,
    "userLowId" TEXT NOT NULL,
    "userHighId" TEXT NOT NULL,
    "reason" "PairBlockReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "reportedUserId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundDedupe" (
    "id" TEXT NOT NULL,
    "providerMessageKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "InboundDedupe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageOutbox" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "recipientUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bodyCiphertextOrBody" TEXT,
    "bodyClearedAt" TIMESTAMP(3),
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "providerWindowCheckedAt" TIMESTAMP(3),

    CONSTRAINT "MessageOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "userId" TEXT,
    "type" "ScheduledJobType" NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ScheduledJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Echo" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Echo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppError" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contextJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AppError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "workerName" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "metadataJson" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketSize" TEXT NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "waitingUsers" INTEGER NOT NULL,
    "activeConnections" INTEGER NOT NULL,
    "matchingEnabledUsers" INTEGER NOT NULL,
    "reachableUsers" INTEGER NOT NULL,
    "expiringReachabilityUsers" INTEGER NOT NULL,
    "completedConnections" INTEGER NOT NULL,
    "oneHourCompletionRate" DOUBLE PRECISION NOT NULL,
    "renewalPromptSentCount" INTEGER NOT NULL,
    "renewalPromptAnsweredCount" INTEGER NOT NULL,
    "outboxPending" INTEGER NOT NULL,
    "providerWindowExpiredCount" INTEGER NOT NULL,
    "scheduledJobLagSeconds" INTEGER NOT NULL,
    "reportCount" INTEGER NOT NULL,
    "blockedCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_providerUserHash_key" ON "User"("providerUserHash");

-- CreateIndex
CREATE INDEX "User_state_updatedAt_idx" ON "User"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "User_matchingEnabled_reachableUntil_state_idx" ON "User"("matchingEnabled", "reachableUntil", "state");

-- CreateIndex
CREATE INDEX "Connection_state_startedAt_idx" ON "Connection"("state", "startedAt");

-- CreateIndex
CREATE INDEX "Connection_userAId_state_idx" ON "Connection"("userAId", "state");

-- CreateIndex
CREATE INDEX "Connection_userBId_state_idx" ON "Connection"("userBId", "state");

-- CreateIndex
CREATE INDEX "PairBlock_userLowId_userHighId_idx" ON "PairBlock"("userLowId", "userHighId");

-- CreateIndex
CREATE UNIQUE INDEX "PairBlock_userLowId_userHighId_key" ON "PairBlock"("userLowId", "userHighId");

-- CreateIndex
CREATE INDEX "Report_reportedUserId_reporterUserId_idx" ON "Report"("reportedUserId", "reporterUserId");

-- CreateIndex
CREATE INDEX "Report_reportedUserId_createdAt_idx" ON "Report"("reportedUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterUserId_reportedUserId_key" ON "Report"("reporterUserId", "reportedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundDedupe_providerMessageKey_key" ON "InboundDedupe"("providerMessageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MessageOutbox_idempotencyKey_key" ON "MessageOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MessageOutbox_status_nextAttemptAt_idx" ON "MessageOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_idempotencyKey_key" ON "ScheduledJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ScheduledJob_status_runAt_idx" ON "ScheduledJob"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "Echo_connectionId_fromUserId_key" ON "Echo"("connectionId", "fromUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerHeartbeat_workerName_key" ON "WorkerHeartbeat"("workerName");

-- CreateIndex
CREATE INDEX "MetricSnapshot_bucketStart_idx" ON "MetricSnapshot"("bucketStart");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOutbox" ADD CONSTRAINT "MessageOutbox_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Echo" ADD CONSTRAINT "Echo_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Echo" ADD CONSTRAINT "Echo_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "connections_active_user_a_unique"
ON "Connection"("userAId")
WHERE "state" IN ('active', 'ending', 'awaiting_echo');

CREATE UNIQUE INDEX "connections_active_user_b_unique"
ON "Connection"("userBId")
WHERE "state" IN ('active', 'ending', 'awaiting_echo');
