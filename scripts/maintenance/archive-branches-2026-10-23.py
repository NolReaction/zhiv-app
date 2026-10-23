#!/usr/bin/env python3
"""One-shot exact-tip archive from the dedicated post-merge Actions job.

All remote writes are one atomic Git push: tag creations plus branch deletions.
Every head has an exact-SHA lease; every new tag has an absence lease.
Git uses checkout's configured authentication; credentials never leave runner.
A push timeout is ambiguous: inspect remote refs; never force a retry.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse

REPOSITORY = "NolReaction/zhiv-app"
DATE = "2026-10-23"
TASK_BRANCH = "work/0.7.2-map-world-fixes"
RETAINED = {"master", "work/admin-operations", "work/0.6.8-unity"}
SHA = re.compile(r"^[0-9a-f]{40}$")
MAINTENANCE = re.compile(r"^maintenance/archive-2026-10-23-[0-9a-f]{12}(?:-[a-z0-9]+)?$")
CONFIRMATION = "archive-2026-10-23-after-pr-34"
ARCHIVE_FILES = {
    ".github/workflows/archive-branches-2026-10-23.yml",
    "scripts/maintenance/archive-branches-2026-10-23.py",
    "scripts/maintenance/archive-branches-2026-10-23.json",
}

class ArchiveError(RuntimeError):
    pass

def require(condition: bool, message: str) -> None:
    if not condition:
        raise ArchiveError(message)

def git(*args: str, timeout: int = 180) -> str:
    result = subprocess.run(
        ["git", *args], text=True, capture_output=True, timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if result.returncode:
        # Never print environment/config/extraheaders. Network commands run only
        # after validation that origin has no embedded credentials.
        raise ArchiveError("git " + args[0] + " failed: " + result.stderr.strip()[-3000:])
    return result.stdout.strip()

def load_config(path: Path) -> dict:
    c = json.loads(path.read_text(encoding="utf-8"))
    require(c.get("schema") == 1, "Unsupported manifest schema.")
    require(c.get("repository") == REPOSITORY, "Wrong manifest repository.")
    require(c.get("archive_date") == DATE and c.get("release_pr") == 34, "Wrong archive date/release PR.")
    for key in ("release_commit_sha", "final_task_head_sha", "expected_release_tree_sha"):
        require(bool(SHA.fullmatch(c.get(key, ""))), "Unfilled/invalid SHA: " + key)
    require(set(c.get("retained_branches", [])) == RETAINED, "Retained allowlist changed.")
    branch = c.get("maintenance_branch", "")
    require(bool(MAINTENANCE.fullmatch(branch)), "Unfilled/invalid maintenance branch.")
    require(branch.split("archive-2026-10-23-", 1)[1].split("-", 1)[0] == c["release_commit_sha"][:12],
            "Maintenance branch must include exact release SHA prefix.")
    require(c.get("archive_maintenance_branch") is True, "Maintenance archive must be enabled.")
    entries = c.get("archive_branches", [])
    require(len(entries) == 26, "Expected exactly 26 original archive branches.")
    names = [entry.get("branch", "") for entry in entries]
    require(len(set(names)) == len(names), "Duplicate archive branch.")
    require(not RETAINED.intersection(names), "Retained branch included in archive list.")
    require(branch not in names and TASK_BRANCH in names, "Maintenance/task archive scope mismatch.")
    for entry in entries:
        name = entry.get("branch", "")
        require(bool(SHA.fullmatch(entry.get("sha", ""))), "Unfilled/invalid branch SHA: " + name)
        git("check-ref-format", "refs/heads/" + name)
        git("check-ref-format", "refs/tags/archive/" + DATE + "/" + name)
        if name == TASK_BRANCH:
            require(entry["sha"] == c["final_task_head_sha"], "Final task SHA mismatch.")
    git("check-ref-format", "refs/heads/" + branch)
    git("check-ref-format", "refs/tags/archive/" + DATE + "/" + branch)
    return c

def remote_refs() -> dict[str, str]:
    output = git("ls-remote", "--heads", "--tags", "origin")
    refs: dict[str, str] = {}
    for line in output.splitlines():
        sha, ref = line.split("\t", 1)
        require(ref not in refs, "Duplicate remote ref: " + ref)
        refs[ref] = sha
    return refs

def validate_event(c: dict) -> str:
    require(os.environ.get("GITHUB_ACTIONS") == "true", "Requires dedicated Actions runner.")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Wrong runner repository.")
    require(os.environ.get("GITHUB_EVENT_NAME") == "push", "Only initial branch creation push is allowed.")
    ref = "refs/heads/" + c["maintenance_branch"]
    require(os.environ.get("GITHUB_REF") == ref, "Wrong runner branch.")
    sha = os.environ.get("GITHUB_SHA", "")
    require(bool(SHA.fullmatch(sha)), "Invalid runner SHA.")
    path = os.environ.get("GITHUB_EVENT_PATH", "")
    require(bool(path), "Missing push event payload.")
    event = json.loads(Path(path).read_text(encoding="utf-8"))
    require(event.get("repository", {}).get("full_name") == REPOSITORY, "Wrong event repository.")
    require(event.get("ref") == ref and event.get("after") == sha, "Push payload/ref/SHA mismatch.")
    initial_create = event.get("created") is True and event.get("before") == "0" * 40
    first_update = event.get("created") is False and event.get("before") == c["release_commit_sha"]
    require(initial_create or first_update, "Only initial create or first release-to-maintenance push is allowed.")
    require(not event.get("deleted") and not event.get("forced"), "Delete/force push events forbidden.")
    require(git("rev-parse", "HEAD") == sha, "Checkout HEAD differs from push SHA.")
    return sha

def archive_entries(c: dict, run_sha: str) -> list[dict[str, str]]:
    return [*c["archive_branches"], {"branch": c["maintenance_branch"], "sha": run_sha}]

def build_push_args(entries: list[dict[str, str]]) -> list[str]:
    args = ["push", "--atomic", "--porcelain", "--no-follow-tags"]
    refspecs = []
    for entry in entries:
        head = "refs/heads/" + entry["branch"]
        tag = "refs/tags/archive/" + DATE + "/" + entry["branch"]
        # Empty expected value means the tag MUST NOT exist.
        args.extend(["--force-with-lease=" + head + ":" + entry["sha"],
                     "--force-with-lease=" + tag + ":"])
        refspecs.extend([entry["sha"] + ":" + tag, ":" + head])
    return [*args, "origin", *refspecs]

def preflight(c: dict, run_sha: str) -> tuple[list[dict[str, str]], dict[str, str]]:
    origin = urlparse(git("remote", "get-url", "origin"))
    require(origin.scheme == "https" and origin.hostname == "github.com", "Expected HTTPS github.com origin.")
    require(not origin.username and not origin.password and not origin.query and not origin.fragment,
            "Origin must contain no embedded credentials/query/fragment.")
    require(origin.path.rstrip("/").removesuffix(".git") == "/" + REPOSITORY, "Wrong origin repository.")
    # Local-only snapshot namespace; no remote mutation.
    git("fetch", "--no-tags", "origin", "+refs/heads/*:refs/archive-preflight/heads/*")
    refs = remote_refs()
    entries = archive_entries(c, run_sha)
    expected = RETAINED | {entry["branch"] for entry in entries}
    actual = {ref.removeprefix("refs/heads/") for ref in refs if ref.startswith("refs/heads/")}
    require(actual == expected, "Remote branch inventory changed. Missing: "
            + ", ".join(sorted(expected - actual)) + "; new: " + ", ".join(sorted(actual - expected)))
    for entry in entries:
        name, sha = entry["branch"], entry["sha"]
        require(refs.get("refs/heads/" + name) == sha, "Remote branch moved: " + name)
        require(git("rev-parse", "refs/archive-preflight/heads/" + name) == sha,
                "Branch moved during fetch: " + name)
        tag = "refs/tags/archive/" + DATE + "/" + name
        require(tag not in refs and tag + "^{}" not in refs, "Archive tag already exists: " + name)
    master = refs["refs/heads/master"]
    require(git("rev-parse", "refs/archive-preflight/heads/master") == master, "Master moved during fetch.")
    git("merge-base", "--is-ancestor", c["release_commit_sha"], master)
    task_tree = git("rev-parse", c["final_task_head_sha"] + "^{tree}")
    require(git("rev-parse", master + "^{tree}") == task_tree == c["expected_release_tree_sha"],
            "Master tree differs from final task/release tree.")
    require(git("show", "-s", "--format=%P", run_sha) == c["release_commit_sha"],
            "Maintenance commit must have exactly release commit as parent.")
    changed = set(git("diff", "--name-only", c["release_commit_sha"], run_sha).splitlines())
    require(changed == ARCHIVE_FILES, "Maintenance commit must change exactly the three archive files.")
    return entries, refs

def summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as output:
            output.write(text + "\n")

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--validate-only", action="store_true", help="Filled manifest validation; offline/no writes.")
    modes.add_argument("--dry-run", action="store_true", help="Actions-only full preflight/server dry-run.")
    modes.add_argument("--execute", action="store_true", help="Actions-only atomic archive push.")
    args = parser.parse_args()
    push_started = push_completed = False
    try:
        c = load_config(args.manifest)
        if args.validate_only:
            summary("Filled manifest valid: 26 original archive branches; 3 retained branches.")
            return 0
        run_sha = validate_event(c)
        entries, before = preflight(c, run_sha)
        require(len(entries) == 27, "Expected 26 original branches plus maintenance branch.")
        push_args = build_push_args(entries)
        summary("Preflight passed: release is in master; master/task trees match; all 27 heads "
                "and absent archive tags match the manifest.")
        if args.dry_run:
            git("push", "--dry-run", *push_args[1:])
            summary("Atomic push dry-run passed. No remote refs changed.")
            return 0
        require(os.environ.get("ARCHIVE_EXECUTION_CONFIRMATION") == CONFIRMATION,
                "Missing explicit workflow execution confirmation.")
        push_started = True
        git(*push_args)
        push_completed = True
        after = remote_refs()
        for entry in entries:
            head = "refs/heads/" + entry["branch"]
            tag = "refs/tags/archive/" + DATE + "/" + entry["branch"]
            require(head not in after, "Post-push branch still exists: " + entry["branch"])
            require(after.get(tag) == entry["sha"] and tag + "^{}" not in after,
                    "Post-push lightweight archive tag mismatch: " + entry["branch"])
        require(all("refs/heads/" + branch in after for branch in RETAINED), "Retained branch disappeared.")
        lines = ["Archived **27 branches** (26 original + maintenance) as exact-tip lightweight tags.", "",
                 "Retained: master, work/admin-operations (PR #24), work/0.6.8-unity.", "",
                 "| Archived branch | Preserved commit |", "| --- | --- |"]
        lines.extend("| " + entry["branch"] + " | " + entry["sha"] + " |" for entry in entries)
        moved = [b for b in sorted(RETAINED) if before["refs/heads/" + b] != after["refs/heads/" + b]]
        if moved:
            lines += ["", "External concurrent movement in retained branches: " + ", ".join(moved)
                      + ". This push did not include those refs."]
        summary("\n".join(lines))
        return 0
    except (ArchiveError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        note = ""
        if push_started:
            note = (" Atomic push acknowledged; verification did not finish." if push_completed else
                    " Push outcome may be ambiguous. Inspect remote refs before any retry.")
        summary("Archive stopped: " + str(error) + note)
        return 1

if __name__ == "__main__":
    sys.exit(main())

