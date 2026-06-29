BEGIN;

DROP INDEX IF EXISTS "connections_active_user_a_unique";
DROP INDEX IF EXISTS "connections_active_user_b_unique";

CREATE UNIQUE INDEX "connections_active_user_a_unique"
ON "Connection"("userAId")
WHERE "state" IN ('active', 'ending');

CREATE UNIQUE INDEX "connections_active_user_b_unique"
ON "Connection"("userBId")
WHERE "state" IN ('active', 'ending');

CREATE OR REPLACE FUNCTION "enforce_single_active_connection_per_user"()
RETURNS trigger AS $$
DECLARE
  user_lock_key bigint;
BEGIN
  IF NEW."state" IN ('active', 'ending') THEN
    FOR user_lock_key IN
      SELECT hashtextextended(user_id, 0)
      FROM (
        VALUES (NEW."userAId"), (NEW."userBId")
      ) AS active_connection_users(user_id)
      GROUP BY user_id
      ORDER BY user_id
    LOOP
      PERFORM pg_advisory_xact_lock(user_lock_key);
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM "Connection" existing_connection
      WHERE existing_connection."state" IN ('active', 'ending')
        AND existing_connection."id" <> NEW."id"
        AND (
          existing_connection."userAId" IN (NEW."userAId", NEW."userBId")
          OR existing_connection."userBId" IN (NEW."userAId", NEW."userBId")
        )
    ) THEN
      RAISE EXCEPTION 'a user can participate in at most one active-state connection'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_single_active_connection_per_user"()
RETURNS void AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT active_connection_users."userId"
      FROM (
        SELECT "id" AS "connectionId", "userAId" AS "userId"
        FROM "Connection"
        WHERE "state" IN ('active', 'ending')

        UNION ALL

        SELECT "id" AS "connectionId", "userBId" AS "userId"
        FROM "Connection"
        WHERE "state" IN ('active', 'ending')
      ) active_connection_users
      GROUP BY active_connection_users."userId"
      HAVING COUNT(DISTINCT active_connection_users."connectionId") > 1
    ) conflicting_active_connection_users
  ) THEN
    RAISE EXCEPTION 'existing data violates single active-state connection per user invariant'
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

LOCK TABLE "Connection" IN SHARE ROW EXCLUSIVE MODE;

SELECT "validate_single_active_connection_per_user"();

COMMIT;
