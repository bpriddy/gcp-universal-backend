-- Replace the silent RULE with a trigger that raises a loud exception.

DROP RULE IF EXISTS "users_no_delete" ON "users";

CREATE OR REPLACE FUNCTION raise_users_no_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Users cannot be deleted. Set is_active = false instead.'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_no_delete
    BEFORE DELETE ON "users"
    FOR EACH ROW EXECUTE FUNCTION raise_users_no_delete();
