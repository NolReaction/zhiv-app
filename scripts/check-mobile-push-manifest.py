#!/usr/bin/env python3
"""Verify the merged debug manifest, after AGP has resolved all plugin manifests."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
PACKAGE = "ru.zhiv.mochlik.lab"
ACTION = "com.google.firebase.MESSAGING_EVENT"
OWN_SERVICE = f"{PACKAGE}.MochlikMessagingService"
PLUGIN_SERVICE = "com.capacitorjs.plugins.pushnotifications.MessagingService"
SDK_SERVICE = "com.google.firebase.messaging.FirebaseMessagingService"


def qualified(name: str, package: str) -> str:
    if name.startswith("."):
        return package + name
    return f"{package}.{name}" if "." not in name else name


def verify(build_dir: Path) -> Path:
    manifests = sorted((build_dir / "intermediates" / "merged_manifests" / "debug").glob("**/AndroidManifest.xml"))
    if len(manifests) != 1:
        raise ValueError(f"Expected one merged debug manifest, found {len(manifests)}")
    manifest = manifests[0]
    root = ET.parse(manifest).getroot()
    package = root.get("package", "")
    if package != PACKAGE:
        raise ValueError("Unexpected application package in merged debug manifest")
    applications = root.findall("application")
    if len(applications) != 1:
        raise ValueError("Expected exactly one application")
    permissions = {node.get(ANDROID + "name") for node in root.findall("uses-permission")}
    if not {"android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"}.issubset(permissions):
        raise ValueError("Missing internet or notification permission in merged manifest")
    handlers: list[tuple[str, int]] = []
    own_services = 0
    for service in applications[0].findall("service"):
        name = qualified(service.get(ANDROID + "name", ""), package)
        if name == PLUGIN_SERVICE:
            raise ValueError("Capacitor default messaging service was not removed")
        if name == OWN_SERVICE:
            own_services += 1
            if service.get(ANDROID + "exported") != "false":
                raise ValueError("Mochlik messaging service must explicitly be non-exported")
        for intent in service.findall("intent-filter"):
            if not any(action.get(ANDROID + "name") == ACTION for action in intent.findall("action")):
                continue
            try:
                priority = int(intent.get(ANDROID + "priority", "0"))
            except ValueError as error:
                raise ValueError("Messaging intent filter has invalid priority") from error
            if service.get(ANDROID + "exported") != "false":
                raise ValueError("Messaging services must explicitly be non-exported")
            if (name, priority) not in {(OWN_SERVICE, 0), (SDK_SERVICE, -500)}:
                raise ValueError("Unexpected messaging service or priority in merged manifest")
            handlers.append((name, priority))
    if own_services != 1 or handlers.count((OWN_SERVICE, 0)) != 1:
        raise ValueError("Expected exactly one priority-0 Mochlik messaging handler")
    if handlers.count((SDK_SERVICE, -500)) > 1:
        raise ValueError("Duplicate Firebase SDK fallback messaging handler")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build_dir", type=Path, nargs="?", default=Path("apps/mobile/android/app/build"))
    args = parser.parse_args()
    try:
        manifest = verify(args.build_dir)
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"Native push manifest verification failed: {error}", file=sys.stderr)
        return 1
    print(f"Verified native push receiver, fallback and permissions: {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
