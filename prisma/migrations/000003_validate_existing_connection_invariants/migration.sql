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
        WHERE "state" IN ('active', 'ending', 'awaiting_echo')

        UNION ALL

        SELECT "id" AS "connectionId", "userBId" AS "userId"
        FROM "Connection"
        WHERE "state" IN ('active', 'ending', 'awaiting_echo')
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
