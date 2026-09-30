"""Admin commands for share links (run inside the pod):

    python -m fpgaweb.shares_admin stats
    python -m fpgaweb.shares_admin show <id>
    python -m fpgaweb.shares_admin delete <id>
    python -m fpgaweb.shares_admin ban <id> [--purge]   # ban the creator of <id>; --purge deletes all their links
"""

import argparse
import json
import sys

from fpgaweb.config import from_env
from fpgaweb.shares import ShareError, ShareStore


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fpgaweb.shares_admin")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats")
    for name in ("show", "delete"):
        sub.add_parser(name).add_argument("id")
    ban = sub.add_parser("ban")
    ban.add_argument("id")
    ban.add_argument("--purge", action="store_true")
    a = ap.parse_args(argv)

    s = from_env()
    store = ShareStore(s.shares_db, s.share_quota_bytes, s.share_ttl_days)
    try:
        if a.cmd == "stats":
            print(json.dumps(store.stats(), indent=2))
        elif a.cmd == "show":
            p = store.get(a.id)
            if p is None:
                print("not found", file=sys.stderr)
                return 1
            print(json.dumps({k: v for k, v in p.items() if k != "files"}, indent=2))
            for name, text in p["files"].items():
                print(f"\n=== {name} ({len(text)} chars)\n{text[:4000]}")
        elif a.cmd == "delete":
            if not store.admin_delete(a.id):
                print("not found", file=sys.stderr)
                return 1
            print("deleted")
        elif a.cmd == "ban":
            n = store.admin_ban(a.id, a.purge)
            print(f"banned; deleted {n} share(s)")
    except ShareError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
