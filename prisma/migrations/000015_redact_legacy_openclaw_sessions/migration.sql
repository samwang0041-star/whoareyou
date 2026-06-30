DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OpenClawBotSession" s
    JOIN "UserProviderRef" r ON r."botSessionId" = s."id"
    WHERE s."providerQrcodeCiphertext" IS NULL
      AND s."providerQrcodeHash" IS NULL
      AND s."status" = 'confirmed'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION '000015_redact_legacy_openclaw_sessions found confirmed legacy OpenClaw sessions still referenced by UserProviderRef; rebind or backfill before applying';
  END IF;
END $$;

UPDATE "OpenClawBotSession"
SET
  "qrcode" = 'legacy-redacted:' || "id",
  "status" = 'expired',
  "botTokenCiphertext" = NULL,
  "ilinkBotId" = NULL,
  "ilinkBotHash" = NULL,
  "ilinkUserId" = NULL,
  "ilinkUserHash" = NULL,
  "getUpdatesBuf" = NULL,
  "providerError" = 'legacy_openclaw_session_requires_rescan'
WHERE "providerQrcodeCiphertext" IS NULL
  AND "providerQrcodeHash" IS NULL
  AND (
    "botTokenCiphertext" IS NOT NULL
    OR "ilinkBotId" IS NOT NULL
    OR "ilinkUserId" IS NOT NULL
    OR "getUpdatesBuf" IS NOT NULL
    OR "status" IN ('waiting_to_scan', 'waiting_to_confirm', 'confirmed', 'scan_confirming', 'verification_required', 'provider_error')
  );
