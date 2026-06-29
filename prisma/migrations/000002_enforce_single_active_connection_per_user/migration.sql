CREATE OR REPLACE FUNCTION "enforce_single_active_connection_per_user"()
RETURNS trigger AS $$
DECLARE
  user_lock_key bigint;
BEGIN
  IF NEW."state" IN ('active', 'ending', 'awaiting_echo') THEN
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
      WHERE existing_connection."state" IN ('active', 'ending', 'awaiting_echo')
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

CREATE TRIGGER "enforce_single_active_connection_per_user_trigger"
BEFORE INSERT OR UPDATE OF "userAId", "userBId", "state" ON "Connection"
FOR EACH ROW
EXECUTE FUNCTION "enforce_single_active_connection_per_user"();
