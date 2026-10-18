#!/usr/bin/env python3
"""Read rendered Compose JSON on stdin; check exposure without contacting a host."""
import json
import sys


def check(config: dict) -> tuple[list[str], list[str]]:
    failures, notes = [], []
    services = config.get("services", {})
    if not isinstance(services, dict) or not {"api", "web", "db", "caddy"}.issubset(services):
        return ["Required application services are missing from the rendered configuration."], []
    if config.get("networks", {}).get("backend", {}).get("internal") is not True:
        failures.append("The backend network is not internal.")
    for name, service in services.items():
        # Messages deliberately omit all configuration values, paths and names.
        if not isinstance(service, dict):
            failures.append("A service definition is invalid.")
            continue
        if service.get("network_mode") == "host" or service.get("privileged") is True:
            failures.append("A service uses host networking or privileged mode.")
        if service.get("cap_add"):
            failures.append("A service requests additional host capabilities; review them explicitly.")
        ports = service.get("ports", [])
        if ports and name != "caddy":
            failures.append("A service other than the edge publishes a host port.")
        if name == "caddy":
            for port in ports:
                if not isinstance(port, dict) or str(port.get("published")) not in {"80", "443"} or str(port.get("target")) != str(port.get("published")):
                    failures.append("The edge publishes a port other than the expected HTTP/HTTPS listeners.")
            if not ports:
                failures.append("The edge has no HTTP/HTTPS listener.")
        for volume in service.get("volumes", []):
            if not isinstance(volume, dict):
                failures.append("Volumes must be normalized by docker compose config --format json.")
                continue
            source = str(volume.get("source", ""))
            if "docker.sock" in source or "podman.sock" in source:
                failures.append("A service can access a container daemon socket.")
            if name != "node-exporter" and volume.get("type") == "bind" and source in {"/", "/proc", "/sys", "/dev", "/var/run", "/run"}:
                failures.append("A service mounts a sensitive host directory.")
            if name == "node-exporter" and volume.get("type") == "bind" and volume.get("read_only") is not True:
                failures.append("The host metrics collector has a writable host mount.")
        if name in {"api", "web", "prometheus", "alertmanager"} and service.get("read_only") is not True:
            failures.append("An application or monitoring container has a writable root filesystem.")
    notes.append("This checks rendered configuration only, not running containers, firewall rules, DNS, CDN bypass or upstream DDoS protection.")
    notes.append("Choose application resource budgets from measured peak usage and a recovery drill; this checker does not set gameplay limits.")
    return list(dict.fromkeys(failures)), notes


def main() -> int:
    try:
        # Do not print the input: a rendered Compose model can contain secrets.
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError()
        config = json.loads(raw)
        if not isinstance(config, dict):
            raise ValueError()
        failures, notes = check(config)
    except (ValueError, TypeError, AttributeError):
        print("Invalid rendered Compose JSON; no configuration values were printed.", file=sys.stderr)
        return 1
    for message in failures:
        print(f"FAIL: {message}")
    for message in notes:
        print(f"NOTE: {message}")
    if not failures:
        print("PASS: Rendered Compose exposure checks passed. No network request was made.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
