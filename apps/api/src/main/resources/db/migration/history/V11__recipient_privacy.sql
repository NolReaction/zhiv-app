-- One outgoing decision per recipient, shared by direct and group views.
CREATE TABLE recipient_sharing_preferences (
  actor_user_id uuid NOT NULL REFERENCES app_users(id),
  recipient_user_id uuid NOT NULL REFERENCES app_users(id),
  sharing_mode varchar(16) NOT NULL CHECK (sharing_mode IN ('OFF', 'LATEST_ONLY')),
  enabled_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id, recipient_user_id),
  CHECK(actor_user_id <> recipient_user_id),
  CHECK((sharing_mode = 'OFF' AND enabled_since IS NULL) OR (sharing_mode = 'LATEST_ONLY' AND enabled_since IS NOT NULL AND enabled_since <= updated_at)),
  CHECK(created_at <= updated_at)
);
CREATE FUNCTION guard_recipient_sharing_preference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'privacy decisions are retained' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable privacy identity' USING ERRCODE = '55000';
    END IF;
    NEW.enabled_since := CASE WHEN NEW.sharing_mode = 'OFF' THEN NULL WHEN OLD.sharing_mode = 'LATEST_ONLY' THEN OLD.enabled_since ELSE changed_at END;
  ELSE
    NEW.created_at := changed_at;
    NEW.enabled_since := CASE WHEN NEW.sharing_mode = 'OFF' THEN NULL ELSE changed_at END;
  END IF;
  NEW.updated_at := changed_at;
  RETURN NEW;
END $$;
CREATE TRIGGER recipient_sharing_preferences_guard BEFORE INSERT OR UPDATE OR DELETE ON recipient_sharing_preferences FOR EACH ROW EXECUTE FUNCTION guard_recipient_sharing_preference();

CREATE VIEW active_recipient_sharing_paths AS
SELECT paths.* FROM (
  SELECT pair.actor_user_id, pair.recipient_user_id, COALESCE(p.sharing_mode, 'OFF')::varchar(16) AS sharing_mode,
         p.enabled_since, COALESCE(p.updated_at, c.created_at) AS updated_at, c.created_at AS path_since
  FROM circles c
  CROSS JOIN LATERAL (VALUES(c.direct_user_low_id,c.direct_user_high_id),(c.direct_user_high_id,c.direct_user_low_id)) pair(actor_user_id,recipient_user_id)
  LEFT JOIN circle_sharing_preferences p ON p.circle_id=c.id AND p.user_id=pair.actor_user_id
  WHERE c.kind='DIRECT' AND c.archived_at IS NULL
  UNION ALL
  SELECT a.user_id, r.user_id, COALESCE(p.sharing_mode,'OFF')::varchar(16), p.enabled_since,
         COALESCE(p.updated_at,a.joined_at), GREATEST(c.created_at,a.joined_at,r.joined_at)
  FROM circles c
  JOIN circle_memberships a ON a.circle_id=c.id AND a.left_at IS NULL
  JOIN circle_memberships r ON r.circle_id=c.id AND r.left_at IS NULL AND r.user_id<>a.user_id AND r.history_visibility<>'NONE'
  LEFT JOIN circle_sharing_preferences p ON p.circle_id=c.id AND p.user_id=a.user_id
  WHERE c.kind='GROUP' AND c.archived_at IS NULL
) paths
JOIN app_users a ON a.id=paths.actor_user_id AND a.deleted_at IS NULL
JOIN app_users r ON r.id=paths.recipient_user_id AND r.deleted_at IS NULL;

CREATE FUNCTION effective_recipient_sharing(actor_id uuid, recipient_id uuid)
RETURNS TABLE(sharing_mode varchar(16), enabled_since timestamptz, updated_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE AS $$
WITH state AS (
  SELECT count(*) AS paths, bool_or(p.sharing_mode='OFF') AS denied,
         max(p.enabled_since) AS enabled, max(p.updated_at) AS updated, min(p.path_since) AS epoch
  FROM active_recipient_sharing_paths p WHERE p.actor_user_id=actor_id AND p.recipient_user_id=recipient_id
), decision AS (
  SELECT s.*, p.enabled_since AS override_since, p.updated_at AS override_updated, p.created_at AS override_created,
    CASE WHEN paths=0 THEN 'OFF' WHEN p.sharing_mode IS NOT NULL THEN p.sharing_mode WHEN denied THEN 'OFF' ELSE 'LATEST_ONLY' END::varchar(16) AS mode
  FROM state s LEFT JOIN recipient_sharing_preferences p ON p.actor_user_id=actor_id AND p.recipient_user_id=recipient_id
)
SELECT mode, CASE WHEN mode='OFF' THEN NULL ELSE GREATEST(COALESCE(override_since,enabled),epoch) END,
       GREATEST(COALESCE(override_updated,updated),epoch), COALESCE(override_created,epoch)
FROM decision;
$$;

-- Preserve old OFF choices even after a legacy route is removed.
INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode)
SELECT actor_user_id,recipient_user_id,'OFF' FROM active_recipient_sharing_paths
GROUP BY actor_user_id,recipient_user_id HAVING bool_or(sharing_mode='OFF') ON CONFLICT DO NOTHING;

CREATE FUNCTION preserve_recipient_denies(related_user uuid) RETURNS void LANGUAGE sql AS $$
INSERT INTO recipient_sharing_preferences(actor_user_id,recipient_user_id,sharing_mode)
SELECT actor_user_id,recipient_user_id,'OFF' FROM active_recipient_sharing_paths
WHERE actor_user_id=related_user OR recipient_user_id=related_user
GROUP BY actor_user_id,recipient_user_id HAVING bool_or(sharing_mode='OFF') ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION guard_check_in_audience() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_at timestamptz;
BEGIN
  SELECT checked_at INTO STRICT event_at FROM check_ins WHERE id=NEW.check_in_id AND user_id=NEW.actor_user_id;
  IF NEW.circle_kind='DIRECT' THEN
    PERFORM c.id FROM circles c
    CROSS JOIN LATERAL effective_recipient_sharing(NEW.actor_user_id,NEW.recipient_user_id) p
    WHERE c.id=NEW.circle_id AND c.kind='DIRECT' AND c.created_at<=event_at AND (c.archived_at IS NULL OR c.archived_at>event_at)
      AND NEW.actor_user_id IN(c.direct_user_low_id,c.direct_user_high_id) AND NEW.recipient_user_id IN(c.direct_user_low_id,c.direct_user_high_id)
      AND NEW.actor_user_id<>NEW.recipient_user_id AND p.sharing_mode<>'OFF' AND p.enabled_since<=event_at AND p.updated_at<=event_at AND NEW.access_level=p.sharing_mode
    FOR SHARE OF c;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid DIRECT audience snapshot' USING ERRCODE='23514'; END IF;
  ELSIF NEW.circle_kind='GROUP' THEN
    PERFORM a.id FROM circles c
    JOIN circle_memberships a ON a.circle_id=c.id AND a.user_id=NEW.actor_user_id AND a.joined_at<=event_at AND (a.left_at IS NULL OR a.left_at>event_at)
    JOIN circle_memberships r ON r.id=NEW.recipient_membership_id AND r.circle_id=c.id AND r.user_id=NEW.recipient_user_id AND r.joined_at<=event_at AND (r.left_at IS NULL OR r.left_at>event_at) AND r.history_visibility<>'NONE'
    CROSS JOIN LATERAL effective_recipient_sharing(NEW.actor_user_id,NEW.recipient_user_id) p
    WHERE c.id=NEW.circle_id AND c.kind='GROUP' AND c.created_at<=event_at AND (c.archived_at IS NULL OR c.archived_at>event_at)
      AND NEW.actor_user_id<>NEW.recipient_user_id AND p.sharing_mode<>'OFF' AND p.enabled_since<=event_at AND p.updated_at<=event_at AND NEW.access_level=p.sharing_mode
    FOR SHARE OF c,a,r;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid GROUP audience snapshot' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'unknown circle kind' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
