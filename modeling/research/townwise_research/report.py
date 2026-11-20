"""The run's two files: a CSV in the calendar's columns (for the model) and a planning brief (for people)."""
from __future__ import annotations

import csv
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path

from .researcher import BeatResult
from .schema import CSV_COLUMNS, Event, to_csv_row
from .sources import Restaurant

ARROW = {"increase": "▲", "decrease": "▼", "mixed": "◆", "none": "·"}


def write(out_dir: Path, restaurant: Restaurant, start: dt.date, end: dt.date, events: list[Event],
          results: list[BeatResult], run_id: str) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"events_{start.isoformat()}_{end.isoformat()}"
    csv_path, brief_path, usage_path = out_dir / f"{stem}.csv", out_dir / f"{stem}.md", out_dir / f"{stem}.usage.json"

    with csv_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(to_csv_row(e) for e in events)

    brief_path.write_text(brief(restaurant, start, end, events, results, run_id))
    usage_path.write_text(json.dumps({
        "run_id": run_id,
        "beats": [{"beat": r.beat, "events": len(r.events), "searches": r.searches, "fetches": r.fetches,
                   "input_tokens": r.input_tokens, "cache_read_tokens": r.cache_read_tokens,
                   "cache_write_tokens": r.cache_write_tokens, "output_tokens": r.output_tokens,
                   "rejected_calls": r.rejected_calls, "stop_reason": r.stop_reason, "error": r.error,
                   "estimated_cost_usd": round(r.cost_usd(), 2)} for r in results],
        "estimated_cost_usd": round(sum(r.cost_usd() for r in results), 2),
    }, indent=1))
    return [csv_path, brief_path, usage_path]


def _week(day: dt.date) -> dt.date:
    return day - dt.timedelta(days=day.weekday())


def brief(restaurant: Restaurant, start: dt.date, end: dt.date, events: list[Event], results: list[BeatResult],
          run_id: str) -> str:
    lines = [f"# What's on near {restaurant.name}: {start:%b %-d} to {end:%b %-d, %Y}", "",
             f"{len(events)} events from {len(results)} research beats (run `{run_id}`). "
             "▲ raises demand, ▼ lowers it, ◆ mixed. Confidence in brackets.", ""]
    big = [e for e in events if e.effect_strength == "high" and e.demand_effect in ("increase", "decrease")]
    if big:
        lines += ["## Plan around these", ""]
        lines += [f"- **{e.start_date:%a %b %-d}** {ARROW[e.demand_effect]} {e.title} ({e.venue or e.town}): {e.rationale}"
                  for e in big]
        lines.append("")
    weeks: dict[dt.date, list[Event]] = defaultdict(list)
    for event in events:
        weeks[_week(max(event.start_date, start))].append(event)
    for monday in sorted(weeks):
        lines += [f"## Week of {monday:%b %-d}", ""]
        for e in weeks[monday]:
            when = f"{e.start_date:%a %b %-d}" + (f"-{e.end_date:%a %b %-d}" if e.end_date != e.start_date else "")
            time = f" {e.start_time}" if e.start_time else ""
            crowd = f", ~{e.expected_attendance:,} people" if e.expected_attendance else ""
            lines.append(f"- {when}{time} {ARROW[e.demand_effect]} **{e.title}** - {e.venue or e.town}{crowd}; "
                         f"{', '.join(e.dayparts) or 'all day'} [{e.confidence}] ([source]({e.source_url}))")
        lines.append("")
    return "\n".join(lines)
