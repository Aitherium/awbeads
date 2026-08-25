#!/usr/bin/env python3
"""Emit real AitherOS datasets for the bead-space demo harness.

Produces demo/data/{constellation,fleet}.json straight from the repo's own config so the
demo exercises the adapters against real shapes rather than fixtures.

Usage (from the package dir):  python demo/build-data.py
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

PACKAGE_DIR = Path(__file__).resolve().parent.parent
# .../AitherOS/apps/packages/bead-space -> .../AitherOS
AITHEROS_DIR = PACKAGE_DIR.parents[2]
CONFIG_DIR = AITHEROS_DIR / "config"
OUT_DIR = PACKAGE_DIR / "demo" / "data"


def docker_health() -> dict[str, str]:
    """Live container status, keyed by container name. Empty if Docker is unavailable."""
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    health: dict[str, str] = {}
    for row in result.stdout.splitlines():
        name, _, status = row.partition("\t")
        if name and status:
            health[name.strip()] = status.strip()
    return health


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    constellation_path = CONFIG_DIR / "constellation.yaml"
    constellation = yaml.safe_load(constellation_path.read_text(encoding="utf-8"))
    (OUT_DIR / "constellation.json").write_text(
        json.dumps(constellation, indent=2), encoding="utf-8"
    )

    services_path = CONFIG_DIR / "services.yaml"
    services_doc = yaml.safe_load(services_path.read_text(encoding="utf-8"))
    services = services_doc.get("services") or {}
    health = docker_health()
    (OUT_DIR / "fleet.json").write_text(
        json.dumps({"services": services, "health": health}, indent=2), encoding="utf-8"
    )

    print(f"constellation: {len(constellation.get('agents', []))} agents, "
          f"{len(constellation.get('links', []))} links")
    print(f"fleet: {len(services)} services, {len(health)} live containers")
    print(f"written to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
