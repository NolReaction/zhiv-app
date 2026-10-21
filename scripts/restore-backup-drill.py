#!/usr/bin/env python3
"""Rehearse a trusted local pg_dump on a local Docker daemon, never an app database."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
DOCKER = ["docker", "--host", "unix:///var/run/docker.sock"]


def validate_dump(path: Path) -> Path:
    if not path.is_file() or path.is_symlink():
        raise ValueError("Provide an existing, trusted local custom-format pg_dump file.")
    with path.open("rb") as source:
        if source.read(5) != b"PGDMP":
            raise ValueError("The input is not a custom-format PostgreSQL dump.")
    return path.resolve()


def validate_model(model: dict, project: str) -> None:
    """Refuse a changed compose file before any start or volume removal."""
    try:
        database = model["services"]["db"]
        volume = model["volumes"]["restore_data"]
        network = model["networks"]["restore"]
        mounts = database.get("volumes", [])
        valid = (
            model.get("name") == project and set(model["services"]) == {"db"}
            and database.get("image") == "postgres:18-alpine"
            and not any(database.get(key) for key in ("ports", "network_mode", "privileged", "cap_add", "devices", "volumes_from", "command", "entrypoint", "pid", "ipc", "userns_mode", "secrets", "configs"))
            and set(database.get("networks", {})) == {"restore"}
            and len(mounts) == 1 and mounts[0].get("type") == "volume"
            and mounts[0].get("source") == "restore_data"
            and mounts[0].get("target") == "/var/lib/postgresql"
            and set(model["volumes"]) == {"restore_data"}
            and volume.get("name") == f"{project}_restore_data" and not volume.get("external")
            and not volume.get("driver_opts") and volume.get("driver", "local") == "local"
            and set(model["networks"]) == {"restore"}
            and network.get("name") == f"{project}_restore" and network.get("internal") is True
            and not network.get("external")
            and not network.get("driver_opts") and network.get("driver", "bridge") == "bridge"
            and set(database["environment"]) == {"POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"}
            and database["environment"]["POSTGRES_DB"] == "zhiv_restore"
            and database["environment"]["POSTGRES_USER"] == "zhiv_restore"
        )
    except (KeyError, TypeError, AttributeError, IndexError):
        valid = False
    if not valid:
        raise ValueError("The restore configuration is not an isolated disposable database.")


def execute(dump: Path, timeout: int, expected_schema: str | None) -> None:
    project = f"zhiv-restore-drill-{uuid.uuid4().hex}"
    started = time.monotonic()
    # No caller-provided project, compose file, database URL, daemon or volume.
    with tempfile.TemporaryDirectory(prefix="zhiv-restore-drill-") as temporary:
        directory = Path(temporary)
        env_path = directory / "compose.env"
        env_path.write_text(f"POSTGRES_PASSWORD={secrets.token_hex(32)}\n", encoding="utf-8")
        env_path.chmod(0o600)
        command = [*DOCKER, "compose", "--project-name", project, "--env-file", str(env_path),
                   "-f", str(ROOT / "deploy/restore.compose.yml")]
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("COMPOSE_", "DOCKER_", "POSTGRES_", "PG"))}

        def run(args: list[str], *, source=None, deadline=timeout, capture=False):
            # PostgreSQL errors can contain row contents: never echo raw output.
            return subprocess.run([*command, *args], env=environment, stdin=source,
                                  stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, check=True, timeout=deadline)

        def interrupted(_signum, _frame):
            raise KeyboardInterrupt()

        previous_term = signal.signal(signal.SIGTERM, interrupted)
        attempted = False
        stage = "verify isolated Compose configuration"
        failure = None
        try:
            rendered = run(["config", "--format", "json"], deadline=30, capture=True)
            validate_model(json.loads(rendered.stdout), project)
            stage = "start isolated PostgreSQL"
            attempted = True
            run(["up", "--detach", "--wait", "--wait-timeout", "90"], deadline=120)
            stage = "restore the archive"
            with dump.open("rb") as source:
                run(["exec", "-T", "db", "pg_restore", "--username", "zhiv_restore", "--dbname", "zhiv_restore",
                     "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction"], source=source)
            stage = "verify migration history"
            result = run(["exec", "-T", "db", "psql", "--username", "zhiv_restore", "--dbname", "zhiv_restore",
                          "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command",
                          "SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1;"],
                         deadline=30, capture=True)
            version = result.stdout.decode("ascii").strip()
            if not version or not all(char in "0123456789." for char in version) or len(version) > 32:
                raise ValueError("Missing or invalid migration version.")
            if expected_schema and version != expected_schema:
                raise ValueError("Unexpected migration version.")
        except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
            failure = f"Restore rehearsal failed during: {stage}. No archive or database details were printed."
        finally:
            # Ignore another interrupt only while removing our own unique project.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            previous_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                if attempted:
                    run(["down", "--volumes", "--remove-orphans", "--timeout", "10"], deadline=60)
            except (OSError, subprocess.SubprocessError):
                failure = f"Cleanup failed for isolated project {project}; remove only that project before repeating."
            finally:
                signal.signal(signal.SIGTERM, previous_term)
                signal.signal(signal.SIGINT, previous_int)
        if failure:
            raise ValueError(failure)
        print(f"Restore rehearsal passed: schema {version}; elapsed {round(time.monotonic() - started)}s; isolated resources removed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path, help="Trusted local custom-format PostgreSQL dump; never a URL")
    parser.add_argument("--execute", action="store_true", help="Actually create the isolated local container and restore")
    parser.add_argument("--timeout-seconds", type=int, default=1800, help="Restore deadline, 30–3600 seconds")
    parser.add_argument("--expect-schema", help="Optional exact latest successful Flyway version, e.g. 62")
    args = parser.parse_args()
    if not 30 <= args.timeout_seconds <= 3600:
        parser.error("Restore deadline must be between 30 and 3600 seconds.")
    if args.expect_schema and (len(args.expect_schema) > 32 or not all(c in "0123456789." for c in args.expect_schema)):
        parser.error("Expected schema must be a numeric Flyway version.")
    try:
        dump = validate_dump(args.dump)
        if not args.execute:
            print("Plan only: restore a trusted local archive into a unique local Docker project, without published ports or application volumes; remove it afterwards. Add --execute to run.")
        else:
            execute(dump, args.timeout_seconds, args.expect_schema)
    except (OSError, ValueError) as error:
        print(str(error) if type(error) is ValueError else "Could not access the trusted local dump.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
