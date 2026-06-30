CREATE TYPE "RelayInviteState" AS ENUM ('created', 'a_qr_issued', 'a_bound', 'b_qr_issued', 'connected', 'closed', 'expired');

CREATE TYPE "RelayParticipantRole" AS ENUM ('a', 'b');

CREATE TYPE "RelayConnectionState" AS ENUM ('active', 'closing', 'closed');

CREATE TYPE "RelayCloseReason" AS ENUM ('disconnected', 'expired', 'provider_expired');

CREATE TABLE "RelayInvite" (
  "id" TEXT NOT NULL,
  "state" "RelayInviteState" NOT NULL DEFAULT 'created',
  "aBotSessionId" TEXT,
  "bBotSessionId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bQrIssuedAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closeReason" "RelayCloseReason",

  CONSTRAINT "RelayInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RelayParticipant" (
  "id" TEXT NOT NULL,
  "inviteId" TEXT NOT NULL,
  "role" "RelayParticipantRole" NOT NULL,
  "provider" TEXT NOT NULL,
  "providerUserHash" TEXT NOT NULL,
  "providerUserIdCiphertext" TEXT NOT NULL,
  "latestContextTokenCiphertext" TEXT,
  "botSessionId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "RelayParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RelayConnection" (
  "id" TEXT NOT NULL,
  "inviteId" TEXT NOT NULL,
  "state" "RelayConnectionState" NOT NULL DEFAULT 'active',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closeReason" "RelayCloseReason",

  CONSTRAINT "RelayConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RelayInvite_state_updatedAt_idx" ON "RelayInvite"("state", "updatedAt");
CREATE INDEX "RelayInvite_expiresAt_idx" ON "RelayInvite"("expiresAt");

CREATE UNIQUE INDEX "RelayParticipant_inviteId_role_key" ON "RelayParticipant"("inviteId", "role");
CREATE INDEX "RelayParticipant_provider_providerUserHash_idx" ON "RelayParticipant"("provider", "providerUserHash");
CREATE UNIQUE INDEX "RelayParticipant_provider_providerUserHash_active_key" ON "RelayParticipant"("provider", "providerUserHash") WHERE "deletedAt" IS NULL;
CREATE INDEX "RelayParticipant_botSessionId_idx" ON "RelayParticipant"("botSessionId");

CREATE UNIQUE INDEX "RelayConnection_inviteId_key" ON "RelayConnection"("inviteId");
CREATE INDEX "RelayConnection_state_startedAt_idx" ON "RelayConnection"("state", "startedAt");

ALTER TABLE "RelayParticipant" ADD CONSTRAINT "RelayParticipant_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RelayInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelayConnection" ADD CONSTRAINT "RelayConnection_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RelayInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
