#!/usr/bin/env python3
"""Read-only CLI inventory. Does not install packages or certify app readiness."""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys


COMMANDS = {
    "python3": [sys.executable, "--version"],
    "git": ["git", "--version"],
    "node": ["node", "--version"],
    "npm": ["npm", "--version"],
    "psql": ["psql", "--version"],
    "docker": ["docker", "--version"],
    "swift": ["swift", "--version"],
    "xcodebuild": ["xcodebuild", "-version"],
}
REQUIRED = {
    "inventory": set(),
    "docs": {"python3", "git"},
    "node": {"node", "npm", "git"},
    "ios": {"swift", "xcodebuild", "git"},
}


def inspect_tool(command: list[str]) -> dict:
    executable = shutil.which(command[0])
    if executable is None:
        return {"status": "missing", "version_output": None}
    try:
        result = subprocess.run(
            [executable, *command[1:]], capture_output=True, text=True,
            timeout=5, check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "version_output": None}
    except OSError:
        return {"status": "unavailable", "version_output": None}
    if result.returncode != 0:
        return {"status": "command_failed", "exit_code": result.returncode, "version_output": None}
    output = result.stdout.strip() or result.stderr.strip()
    if not output:
        return {"status": "empty_output", "version_output": None}
    return {"status": "present", "version_output": "\n".join(output.splitlines()[:2])[:300]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=REQUIRED, default="inventory")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    checks = {name: inspect_tool(command) for name, command in COMMANDS.items()}
    issues = [f"{name}: {checks[name]['status']}" for name in sorted(REQUIRED[args.profile]) if checks[name]["status"] != "present"]

    if args.profile == "docs" and sys.version_info < (3, 10):
        issues.append("Documentation checks require Python 3.10 or later")
    if args.profile == "ios" and platform.system() != "Darwin":
        issues.append("Native iOS build requires macOS/Xcode")
    if args.profile == "node" and checks["node"]["status"] == "present":
        version = re.match(r"v(\d+)\.", checks["node"]["version_output"])
        if version is None or int(version.group(1)) not in {22, 24}:
            issues.append("Node baseline reviewed on 2026-09-15: major 22 or 24; review other versions explicitly")

    report = {
        "schema_version": 1,
        "profile": args.profile,
        "platform": platform.system(),
        "architecture": platform.machine(),
        "cli_requirements_satisfied": not issues,
        "checks": checks,
        "issues": issues,
        "not_checked": [
            "dependency installation and framework compatibility",
            "PostgreSQL server connectivity and migrations",
            "Docker daemon availability",
            "iOS build, simulator, signing and real device",
            "AI provider credentials, API calls and deployment",
        ],
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"CLI inventory: {report['platform']} / {report['architecture']}; profile={args.profile}")
        for name, check in checks.items():
            version = (check["version_output"] or "").replace("\n", "; ")
            print(f"{name}: {check['status']} {version}".rstrip())
        print("CLI requirements: " + ("PASS" if not issues else "NOT SATISFIED"))
        for issue in issues:
            print(f"- {issue}")
        print("This inventory does not certify application, database or deployment readiness.")
    return 2 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
