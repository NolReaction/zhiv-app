#!/usr/bin/env python3
"""Exercise the interactive full reset only against the isolated GitHub CI stack."""
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ["docker", "compose", "-f", "deploy/compose.yml"]
RESET = ["bash", "scripts/reset-database.sh", "--confirm-delete-database"]


def run(arguments, **kwargs):
    return subprocess.run(arguments, cwd=ROOT, check=True, **kwargs)


def sql(statement, database="zhiv"):
    result = run(COMPOSE + ["exec", "-T", "db", "psql", "-X", "-A", "-t", "-U", "zhiv",
                           "-d", database, "-v", "ON_ERROR_STOP=1"],
                 input=statement, text=True, capture_output=True)
    return result.stdout.strip()


def volume_mounts(service, project):
    container = run(COMPOSE + ["ps", "-q", service], text=True, capture_output=True).stdout.strip()
    if not container:
        raise RuntimeError(f"Missing running CI service: {service}")
    info = json.loads(run(["docker", "inspect", container], text=True, capture_output=True).stdout)[0]
    if info["Config"]["Labels"].get("com.docker.compose.project") != project:
        raise RuntimeError("Refusing automatic confirmation outside the isolated CI project")
    mounts = {item["Destination"]: item["Name"] for item in info["Mounts"] if item["Type"] == "volume"}
    if not mounts or any(not name.startswith(project + "_") for name in mounts.values()):
        raise RuntimeError("Refusing a stack whose volumes are not owned by the CI project")
    return mounts


def secret_fingerprints():
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (ROOT / "deploy/.secrets").rglob("*") if path.is_file()}


def interactive_reset(confirmation):
    # pty.fork gives /dev/tty to the child. The production script has no bypass flag.
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.environ["BUILDKIT_PROGRESS"] = "plain"
        os.execvp(RESET[0], RESET)
    tail = b""
    replied = False
    deadline = time.monotonic() + 900
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([terminal], [], [], 0.2)
            if not readable:
                continue
            try:
                output = os.read(terminal, 65536)
            except OSError:
                break
            if not output:
                break
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
            tail = (tail + output)[-4096:]
            if not replied and b"Type RESET zhiv to continue:" in tail:
                os.write(terminal, (confirmation + "\n").encode())
                replied = True
        else:
            raise TimeoutError("Interactive reset did not complete within 15 minutes")
        _, status = os.waitpid(pid, 0)
        pid = None
        if not replied:
            raise RuntimeError("Reset exited without requesting typed confirmation")
        return os.waitstatus_to_exitcode(status)
    finally:
        os.close(terminal)
        if pid is not None:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


def main():
    project = os.environ.get("COMPOSE_PROJECT_NAME", "")
    if (os.environ.get("CI") != "true" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("DOMAIN") != "localhost" or not re.fullmatch(r"zhiv-ci-[0-9]+", project)
            or (ROOT / "deploy/.env").exists()):
        raise RuntimeError("This verification is restricted to the isolated GitHub CI stack")
    original_volumes = {name: volume_mounts(name, project) for name in ("db", "caddy")}
    original_secrets = secret_fingerprints()
    if len(original_secrets) < 3:
        raise RuntimeError("Expected all three isolated database secrets")

    missing_flag = subprocess.run(["bash", "scripts/reset-database.sh"], cwd=ROOT, check=False)
    assert missing_flag.returncode == 2, "Reset must require its destructive flag"
    sql("""
        CREATE SCHEMA ci_reset_obsolete;
        CREATE TABLE ci_reset_obsolete.marker (value text NOT NULL);
        INSERT INTO ci_reset_obsolete.marker VALUES ('original-data');
        CREATE TABLE public.ci_reset_old_table (value text NOT NULL);
        INSERT INTO public.ci_reset_old_table VALUES ('old-schema');
        INSERT INTO app_users (id, public_id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000051', '0000-0000-0051', 'CI reset');
        INSERT INTO account_login_identities (provider, subject, user_id)
        VALUES ('email', 'ci-reset@example.invalid', '00000000-0000-4000-8000-000000000051');
        INSERT INTO app_sessions (user_id, token_hash, expires_at)
        VALUES ('00000000-0000-4000-8000-000000000051', decode(repeat('10', 32), 'hex'),
                clock_timestamp() + interval '1 day');
        INSERT INTO account_login_flows (token_hash, browser_hash, provider, intent)
        VALUES (decode(repeat('11', 32), 'hex'), decode(repeat('12', 32), 'hex'), 'vk', 'login');
        INSERT INTO account_registration_tickets (token_hash, browser_hash, provider, subject)
        VALUES (decode(repeat('13', 32), 'hex'), decode(repeat('14', 32), 'hex'),
                'email', 'ci-register@example.invalid');
        UPDATE flyway_schema_history SET description = 'ci-reset-history-marker'
        WHERE installed_rank = (SELECT max(installed_rank) FROM flyway_schema_history);
    """)

    assert interactive_reset("WRONG CONFIRMATION") == 2
    assert sql("SELECT value FROM ci_reset_obsolete.marker") == "original-data"
    assert sql("SELECT count(*) FROM app_users") == "1"
    backup_dir = ROOT.parent / "zhiv-backups"
    previous_backups = set(backup_dir.glob("before-database-reset-*.dump"))
    assert interactive_reset("RESET zhiv") == 0

    latest_migration = max(int(path.name.split("__", 1)[0][1:])
                           for path in (ROOT / "apps/api/src/main/resources/db/migration").glob("V*__*.sql"))
    assert sql("SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1") == str(latest_migration)
    assert sql("SELECT count(*) FROM flyway_schema_history WHERE NOT success OR description = 'ci-reset-history-marker'") == "0"
    assert sql("SELECT to_regnamespace('ci_reset_obsolete') IS NULL AND to_regclass('public.ci_reset_old_table') IS NULL") == "t"
    for table in ("app_users", "app_sessions", "account_login_identities", "account_login_flows", "account_registration_tickets"):
        assert sql(f"SELECT count(*) FROM {table}") == "0", table
    assert original_volumes == {name: volume_mounts(name, project) for name in ("db", "caddy")}
    assert original_secrets == secret_fingerprints()

    new_backups = set(backup_dir.glob("before-database-reset-*.dump")) - previous_backups
    assert len(new_backups) == 1, "Expected one original-data backup"
    backup = new_backups.pop()
    assert backup.stat().st_mode & 0o077 == 0, "Backup must remain private"
    verify_db = "zhiv_ci_reset_backup_check"
    run(COMPOSE + ["exec", "-T", "db", "createdb", "-U", "zhiv", "--template=template0", verify_db])
    try:
        with backup.open("rb") as dump:
            run(COMPOSE + ["exec", "-T", "db", "pg_restore", "-U", "zhiv", "-d", verify_db,
                           "--exit-on-error"], stdin=dump)
        assert sql("SELECT value FROM ci_reset_obsolete.marker", verify_db) == "original-data"
        assert sql("SELECT count(*) FROM app_users", verify_db) == "1"
        assert sql("SELECT count(*) FROM account_login_identities", verify_db) == "1"
        assert sql("SELECT count(*) FROM app_sessions", verify_db) == "1"
    finally:
        run(COMPOSE + ["exec", "-T", "db", "dropdb", "-U", "zhiv", verify_db])
    print("Full database reset verified: fresh schema, empty data, retained original backup, unchanged volumes and secrets.")


if __name__ == "__main__":
    main()
