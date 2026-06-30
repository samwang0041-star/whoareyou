ALTER TABLE "OpenClawBotSession"
  ADD COLUMN IF NOT EXISTS "providerQrcodeCiphertext" TEXT,
  ADD COLUMN IF NOT EXISTS "providerQrcodeHash" TEXT,
  ADD COLUMN IF NOT EXISTS "ilinkBotHash" TEXT,
  ADD COLUMN IF NOT EXISTS "ilinkUserHash" TEXT;

CREATE INDEX IF NOT EXISTS "OpenClawBotSession_providerQrcodeHash_idx"
  ON "OpenClawBotSession"("providerQrcodeHash");

CREATE INDEX IF NOT EXISTS "OpenClawBotSession_ilinkUserHash_ilinkBotHash_idx"
  ON "OpenClawBotSession"("ilinkUserHash", "ilinkBotHash");
