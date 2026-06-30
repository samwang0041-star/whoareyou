-- CreateTable
CREATE TABLE "OpenClawBotSession" (
    "id" TEXT NOT NULL,
    "qrcode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting_to_scan',
    "botTokenCiphertext" TEXT,
    "ilinkBotId" TEXT,
    "baseUrl" TEXT,
    "ilinkUserId" TEXT,
    "getUpdatesBuf" TEXT,
    "redirectHost" TEXT,
    "providerError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "OpenClawBotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProviderRef" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "latestContextToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProviderRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpenClawBotSession_qrcode_key" ON "OpenClawBotSession"("qrcode");

-- CreateIndex
CREATE INDEX "OpenClawBotSession_status_updatedAt_idx" ON "OpenClawBotSession"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "OpenClawBotSession_expiresAt_idx" ON "OpenClawBotSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserProviderRef_provider_userId_key" ON "UserProviderRef"("provider", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProviderRef_provider_providerUserId_key" ON "UserProviderRef"("provider", "providerUserId");

-- CreateIndex
CREATE INDEX "UserProviderRef_userId_idx" ON "UserProviderRef"("userId");

-- AddForeignKey
ALTER TABLE "UserProviderRef" ADD CONSTRAINT "UserProviderRef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
