"""Hendy Tools Pro bootstrap utility.

Replace this scaffold with the existing production CLI if one exists; this file
is deliberately dependency-light and only reports workspace diagnostics.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

REQUIRED = ["package.json", "apps/admin-web", "apps/studio-web", "apps/site", "apps/api", "packages/core-utils", "packages/shared-types"]

def main() -> int:
    parser = argparse.ArgumentParser(description="Hendy Tools Pro — workspace diagnostics")
    parser.add_argument("--root", default=".", help="Đường dẫn root monorepo")
    parser.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    checks = [{"path": item, "exists": (root / item).exists()} for item in REQUIRED]
    ok = all(item["exists"] for item in checks)
    report = {"tool": "Hendy Tools Pro", "root": str(root), "ok": ok, "checks": checks}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Hendy Tools Pro — {root}")
        for item in checks:
            print(f"{'[OK]' if item['exists'] else '[MISSING]'} {item['path']}")
        print("Workspace structure: " + ("OK" if ok else "INCOMPLETE"))
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
