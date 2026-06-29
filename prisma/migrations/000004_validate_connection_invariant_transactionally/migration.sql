-- Prisma PostgreSQL migrations are not transaction-wrapped by default.
-- Use an explicit transaction so the write-blocking lock is held through validation.
BEGIN;

LOCK TABLE "Connection" IN SHARE ROW EXCLUSIVE MODE;

SELECT "validate_single_active_connection_per_user"();

COMMIT;
