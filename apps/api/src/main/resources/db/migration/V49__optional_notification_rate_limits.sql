-- Preserve existing notification frequency unless the player explicitly opts
-- out. Quiet hours remain an independent preference.
UPDATE notification_preferences
SET preferences = preferences || '{"rateLimitsEnabled":true}'::jsonb
WHERE NOT (preferences ? 'rateLimitsEnabled');
