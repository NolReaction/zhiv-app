-- The API appends receipts; UI clients cannot grant administrator privileges.
CREATE TABLE admin_actions (
    request_id uuid PRIMARY KEY,
    actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    target_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    actor_public_id varchar(14) NOT NULL,
    target_public_id varchar(14) NOT NULL,
    action varchar(32) NOT NULL CHECK (action = 'revoke_sessions'),
    reason varchar(240) NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 240 AND reason = btrim(reason) AND reason !~ '[[:cntrl:]]'),
    affected_sessions integer NOT NULL CHECK (affected_sessions >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (actor_public_id <> target_public_id),
    CHECK (actor_public_id ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$'),
    CHECK (target_public_id ~ '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$')
);
CREATE INDEX admin_actions_created_idx ON admin_actions(created_at DESC, request_id);
CREATE INDEX check_ins_admin_activity_idx ON check_ins(checked_at, user_id);
CREATE INDEX app_users_admin_created_idx ON app_users(created_at, id);

CREATE FUNCTION guard_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Referential cleanup may detach a physically deleted account, while preserving
    -- the public-ID snapshot, action, reason, counts, and timestamp forever.
    IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - 'actor_user_id' - 'target_user_id') = (to_jsonb(OLD) - 'actor_user_id' - 'target_user_id')
       AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
       AND (NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id OR NEW.target_user_id IS NULL) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'admin_actions is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER admin_actions_append_only BEFORE UPDATE OR DELETE ON admin_actions
    FOR EACH ROW EXECUTE FUNCTION guard_admin_audit();
