-- Five production stations can each hold three jobs; Mochlik, the miner and
-- the builder each have one independent occupied queue, including ready work.
-- Retain every other constraint and preserve existing paid job JSON unchanged.
ALTER TABLE public.economy_profiles DROP CONSTRAINT economy_profiles_state_check6;
ALTER TABLE public.economy_profiles ADD CONSTRAINT economy_profiles_state_check6
    CHECK ((jsonb_typeof(state->'jobs') = 'array' AND jsonb_array_length(state->'jobs') <= 18) IS TRUE);
