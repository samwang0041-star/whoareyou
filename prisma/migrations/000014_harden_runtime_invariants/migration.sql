ALTER TABLE "AppError"
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "occurrenceCount" INTEGER NOT NULL DEFAULT 1;

UPDATE "AppError"
SET "lastSeenAt" = "createdAt";

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "source", "fingerprint"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number,
    COUNT(*) OVER (PARTITION BY "source", "fingerprint") AS occurrence_count,
    MAX("createdAt") OVER (PARTITION BY "source", "fingerprint") AS last_seen_at
  FROM "AppError"
  WHERE "resolvedAt" IS NULL
)
UPDATE "AppError" app_error
SET
  "occurrenceCount" = ranked.occurrence_count,
  "lastSeenAt" = ranked.last_seen_at
FROM ranked
WHERE app_error."id" = ranked."id" AND ranked.row_number = 1;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "source", "fingerprint"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number
  FROM "AppError"
  WHERE "resolvedAt" IS NULL
)
DELETE FROM "AppError"
WHERE "id" IN (
  SELECT "id"
  FROM ranked
  WHERE row_number > 1
);

CREATE INDEX IF NOT EXISTS "AppError_source_fingerprint_resolvedAt_idx"
  ON "AppError"("source", "fingerprint", "resolvedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "AppError_active_source_fingerprint_key"
  ON "AppError"("source", "fingerprint")
  WHERE "resolvedAt" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Connection" WHERE "userAId" = "userBId") THEN
    RAISE EXCEPTION 'self-connections exist; remove them before applying Connection_no_self_connection_check';
  END IF;
END $$;

ALTER TABLE "Connection"
  ADD CONSTRAINT "Connection_no_self_connection_check"
  CHECK ("userAId" <> "userBId");
