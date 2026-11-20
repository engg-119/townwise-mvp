"""Command line.

    python -m townwise_research scout [--from YYYY-MM-DD] [--days 60] [--beats key,key] [--dry-run]
    python -m townwise_research search "hockey" [--from ...] [--days ...]
    python -m townwise_research ensure-index
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from pathlib import Path

from .sources import HANOVER_BEATS, SAWTOOTH

OUT = Path(__file__).resolve().parent.parent / "out"


def _window(args: argparse.Namespace) -> tuple[dt.date, dt.date]:
    start = dt.date.fromisoformat(args.start) if args.start else dt.date.today()
    return start, start + dt.timedelta(days=args.days - 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="townwise_research")
    sub = parser.add_subparsers(dest="command", required=True)

    scout = sub.add_parser("scout", help="research events for the window and index them")
    scout.add_argument("--from", dest="start")
    scout.add_argument("--days", type=int, default=60)
    scout.add_argument("--beats", help="comma-separated beat keys (default: all)")
    scout.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    scout.add_argument("--max-searches", type=int, default=10, help="web searches per beat")
    scout.add_argument("--max-fetches", type=int, default=15, help="page fetches per beat")
    scout.add_argument("--concurrency", type=int, default=4)
    scout.add_argument("--dry-run", action="store_true", help="don't read or write Azure AI Search")
    scout.add_argument("--out", type=Path, default=OUT)

    search = sub.add_parser("search", help="query the event index")
    search.add_argument("text", nargs="?", default="")
    search.add_argument("--from", dest="start")
    search.add_argument("--days", type=int, default=60)
    search.add_argument("--top", type=int, default=20)

    sub.add_parser("ensure-index", help="create or update the Azure AI Search index")
    sub.add_parser("beats", help="list the research beats")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for noisy in ("httpx", "azure", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.command == "beats":
        for beat in HANOVER_BEATS:
            print(f"{beat.key:28} {beat.title}")
        return 0

    from .store import AzureEventStore, NullStore

    if args.command == "ensure-index":
        store = AzureEventStore.from_env()
        print(("created" if store.ensure_index() else "updated") + f" index {store.index}")
        return 0

    if args.command == "search":
        start, end = _window(args)
        for doc in AzureEventStore.from_env().query(args.text, start=start, end=end, top=args.top):
            print(f"{doc['start_date'][:10]}  {doc['demand_effect']:8} {doc['effect_strength']:6} {doc['title']}"
                  f"  ({doc.get('venue') or doc['town']})")
        return 0

    from .graph import run
    from .researcher import Researcher

    start, end = _window(args)
    beats = list(HANOVER_BEATS)
    if args.beats:
        wanted = set(args.beats.split(","))
        unknown = wanted - {b.key for b in beats}
        if unknown:
            parser.error(f"unknown beat(s): {', '.join(sorted(unknown))}; see `beats`")
        beats = [b for b in beats if b.key in wanted]
    store = NullStore() if args.dry_run else AzureEventStore.from_env()
    if not args.dry_run and not store.index_exists():
        # Developers hold only Search Index Data Contributor, which cannot create an index; an administrator runs
        # ensure-index once (infra/README.md, "Event search").
        parser.error(f"index {store.index} doesn't exist yet: an administrator runs `ensure-index` once")
    researcher = Researcher(effort=args.effort, max_searches=args.max_searches, max_fetches=args.max_fetches)
    state = run(researcher, store, SAWTOOTH, beats, start, end, args.out, concurrency=args.concurrency)
    searches = sum(r.searches for r in state["results"])
    tokens_in = sum(r.input_tokens for r in state["results"])
    tokens_out = sum(r.output_tokens for r in state["results"])
    cached = sum(r.cache_read_tokens for r in state["results"])
    cost = sum(r.cost_usd() for r in state["results"])
    print(f"\n{len(state['events'])} events ({state['indexed']} indexed) from {len(beats)} beats; "
          f"{searches} searches, {tokens_in:,} input ({cached:,} from cache) / {tokens_out:,} output tokens; "
          f"about ${cost:.2f}")
    for path in state["files"]:
        print(f"  {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
