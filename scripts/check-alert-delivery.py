#!/usr/bin/env python3
"""Validate a private alert webhook without printing it or sending any request."""
from pathlib import Path
import stat
import sys
from urllib.parse import urlsplit


def validate(path: Path) -> None:
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 4096:
        raise ValueError("Alert webhook must be a regular private file of at most 4096 bytes.")
    raw = path.read_text(encoding="utf-8")
    value = raw.removesuffix("\n")
    if not value or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError("Alert webhook must contain one HTTPS URL without whitespace.")
    try:
        url = urlsplit(value)
        valid = url.scheme == "https" and bool(url.hostname) and not url.username and not url.password and not url.fragment
        valid = valid and (url.port is None or 0 < url.port < 65536)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Alert webhook must be an HTTPS URL without userinfo or fragment.")
    if stat.S_IMODE(path.stat().st_mode) != 0o444:
        raise ValueError("Alert webhook file must have mode 0444 for its non-root container reader.")
    if stat.S_IMODE(path.parent.parent.stat().st_mode) & 0o077:
        raise ValueError("The containing .secrets directory must be private (mode 0700).")


def main() -> int:
    path = Path(__file__).resolve().parent.parent / "deploy/.secrets/alerts/webhook_url"
    try:
        validate(path)
    except (OSError, UnicodeError, ValueError) as error:
        # Never include a parser or filesystem exception: it can contain secrets.
        message = str(error) if type(error) is ValueError else "Could not read the private alert webhook."
        print(message, file=sys.stderr)
        return 1
    print("Private HTTPS alert receiver configuration is valid; no notification sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
