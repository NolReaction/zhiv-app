#!/usr/bin/env python3
"""Enable explicitly selected administrator accounts in the VPS configuration."""
import argparse
import os
from pathlib import Path
import re
import secrets
import tempfile

PUBLIC_ID = re.compile(r"[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}")


def configure(path: Path, public_ids: list[str]) -> None:
    if not path.is_file():
        raise ValueError("deploy/.env is missing. Configure the production deployment first.")
    if not public_ids or any(not PUBLIC_ID.fullmatch(value) for value in public_ids):
        raise ValueError("Use the exact public ID from your app profile, such as XXXX-XXXX-XXXX.")
    lines = path.read_text().splitlines()
    previous = {}
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            previous[key.strip()] = value.strip().strip("\"'")
    # Preserve existing administrators and optional profiles. Access removal is
    # an explicit edit of ADMIN_PUBLIC_IDS, never an incidental setup side effect.
    existing = [value.strip() for value in previous.get("ADMIN_PUBLIC_IDS", "").split(",") if value.strip()]
    if any(not PUBLIC_ID.fullmatch(value) for value in existing):
        raise ValueError("Existing ADMIN_PUBLIC_IDS is invalid; correct it before enabling the panel.")
    administrators = list(dict.fromkeys(existing + public_ids))
    if len(administrators) > 32:
        raise ValueError("At most 32 administrator accounts are supported.")
    profiles = list(dict.fromkeys([value.strip() for value in previous.get("COMPOSE_PROFILES", "").split(",") if value.strip()] + ["monitoring"]))
    secret_root = path.parent / ".secrets"
    secret_root.mkdir(mode=0o700, exist_ok=True)
    secret_root.chmod(0o700)
    monitoring_directory = secret_root / "monitoring"
    monitoring_directory.mkdir(mode=0o755, exist_ok=True)
    monitoring_directory.chmod(0o755)
    token_file = monitoring_directory / "token"
    if not token_file.exists():
        with token_file.open("x", encoding="utf-8") as handle:
            handle.write(secrets.token_urlsafe(48) + "\n")
        token_file.chmod(0o444)
    elif not re.fullmatch(r"[A-Za-z0-9_-]{64}", token_file.read_text().strip()):
        raise ValueError("Existing monitoring token is invalid; it was preserved.")
    # The host parent is private; both non-root containers need read access to
    # the mounted token, including one previously created with a strict umask.
    token_file.chmod(0o444)
    updates = {"ADMIN_PUBLIC_IDS": ",".join(administrators), "MONITORING_URL": "http://prometheus:9090",
               "METRICS_TOKEN_FILE": "/run/monitoring-secrets/token", "COMPOSE_PROFILES": ",".join(profiles)}
    retained = [line for line in lines if line.split("=", 1)[0].strip() not in updates]
    content = "\n".join(retained + ["", "# Private operations panel", *[f"{key}={value}" for key, value in updates.items()]]) + "\n"
    staged = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".admin-config-", delete=False) as handle:
            staged = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staged, path)
    finally:
        if staged and staged.exists():
            staged.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-id", action="append", required=True, help="Exact administrator public ID; repeat for multiple admins")
    args = parser.parse_args()
    path = Path(__file__).resolve().parent.parent / "deploy" / ".env"
    try:
        configure(path, args.public_id)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Configuration not saved: {error}\n")
    print("Administrator access and monitoring configured. Restart the production stack to apply.")
    print("Sign in with the selected account, then open https://<your-domain>/admin.")


if __name__ == "__main__":
    main()
