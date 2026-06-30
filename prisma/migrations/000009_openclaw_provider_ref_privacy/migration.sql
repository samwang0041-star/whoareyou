-- Existing rows contain raw provider ids/context tokens and cannot be safely
-- backfilled in SQL because encryption/hashing require runtime secrets. This
-- MVP/dev migration must run before any refs exist, or after resetting dev refs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UserProviderRef" LIMIT 1) THEN
    RAISE EXCEPTION '000009_openclaw_provider_ref_privacy requires empty UserProviderRef; reset dev refs before applying';
  END IF;
END $$;

DROP INDEX IF EXISTS "UserProviderRef_provider_providerUserId_key";

ALTER TABLE "UserProviderRef"
  ADD COLUMN "providerUserHash" TEXT NOT NULL,
  ADD COLUMN "providerUserIdCiphertext" TEXT NOT NULL,
  ADD COLUMN "latestContextTokenCiphertext" TEXT,
  ADD COLUMN "botSessionId" TEXT NOT NULL,
  DROP COLUMN "providerUserId",
  DROP COLUMN "latestContextToken";

CREATE UNIQUE INDEX "UserProviderRef_provider_providerUserHash_key" ON "UserProviderRef"("provider", "providerUserHash");

CREATE INDEX "UserProviderRef_botSessionId_idx" ON "UserProviderRef"("botSessionId");

ALTER TABLE "UserProviderRef" ADD CONSTRAINT "UserProviderRef_botSessionId_fkey" FOREIGN KEY ("botSessionId") REFERENCES "OpenClawBotSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
