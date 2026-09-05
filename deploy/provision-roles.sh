
#!/bin/sh
set -eu
export PGPASSWORD="$(cat /run/secrets/db_admin)"
export ZHIV_MIGRATION_PASSWORD="$(cat /run/secrets/db_migration)"
export ZHIV_APP_PASSWORD="$(cat /run/secrets/db_app)"
psql --host=db --username=zhiv --dbname=zhiv --no-psqlrc --set=ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password ZHIV_MIGRATION_PASSWORD
\getenv app_password ZHIV_APP_PASSWORD
BEGIN;
SELECT 'CREATE ROLE zhiv_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zhiv_migrator') \gexec
SELECT 'CREATE ROLE zhiv_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zhiv_app') \gexec
SELECT format('ALTER ROLE zhiv_migrator PASSWORD %L', :'migration_password') \gexec
SELECT format('ALTER ROLE zhiv_app PASSWORD %L', :'app_password') \gexec
-- Dedicated application database only; also upgrades the former single-role installation.
ALTER DATABASE zhiv OWNER TO zhiv_migrator;
DO $roles$
DECLARE item record;
BEGIN
  FOR item IN SELECT c.oid, c.relkind, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')
      AND pg_get_userbyid(c.relowner)='zhiv'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  LOOP
    EXECUTE format('ALTER %s public.%I OWNER TO zhiv_migrator',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,item.relname);
  END LOOP;
  FOR item IN SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND pg_get_userbyid(p.proowner)='zhiv'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO zhiv_migrator',item.signature);
  END LOOP;
END $roles$;
ALTER SCHEMA public OWNER TO zhiv_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE zhiv FROM PUBLIC;
GRANT CONNECT ON DATABASE zhiv TO zhiv_app, zhiv_migrator;
GRANT USAGE ON SCHEMA public TO zhiv_app;
COMMIT;
SQL
