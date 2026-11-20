"""Merging what several beats found. Two beats often find the same event (a hockey game is athletics and a big
weekend), and two pages often word it differently. They count as one when they happen in the same town at the same
time and their names say the same thing:

- same start day: one name inside the other, or mostly the same words, so "Tree lighting on the Dartmouth Green"
  matches "Dartmouth Green tree lighting";
- runs (a show's season, a break): overlapping dates and names nearly identical, so a show listed from its preview
  night and from its opening night is one run.

Word overlap needs 0.75, which keeps "Dartmouth vs. Harvard (men's hockey)" and "(women's hockey)" apart.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from .schema import CONFIDENCE_RANK, Event, slug

SAME_WORDS = 0.75
SAME_RUN = 0.9
STOP = {"the", "a", "an", "of", "on", "in", "at", "and", "for", "to", "vs", "s", "with", "by", "from", "day"}


def _words(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in STOP}


def _jaccard(a: str, b: str) -> float:
    wa, wb = _words(a), _words(b)
    return len(wa & wb) / len(wa | wb) if wa | wb else 0.0


def _contains(a: str, b: str) -> bool:
    x, y = slug(a), slug(b)
    return x == y or x in y or y in x


def _same(a: Event, b: Event) -> bool:
    if slug(a.town) != slug(b.town):
        return False
    if a.start_date == b.start_date:
        # Words, not characters: "men's" and "women's" are two letters apart but different games.
        return _contains(a.title, b.title) or _jaccard(a.title, b.title) >= SAME_WORDS
    multi_day = a.end_date != a.start_date or b.end_date != b.start_date
    overlap = a.start_date <= b.end_date and b.start_date <= a.end_date
    alike = _contains(a.title, b.title) or SequenceMatcher(None, slug(a.title), slug(b.title)).ratio() >= SAME_RUN
    return multi_day and overlap and alike


def _better(a: Event, b: Event) -> Event:
    """Keep the better-sourced record; fill its gaps from the other, and widen a run to cover both."""
    keep, other = (a, b) if CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] else (b, a)
    updates = {}
    for name in ("start_time", "venue", "expected_attendance"):
        if getattr(keep, name) is None and getattr(other, name) is not None:
            updates[name] = getattr(other, name)
    if other.dayparts:
        updates["dayparts"] = sorted(set(keep.dayparts) | set(other.dayparts))
    if keep.start_date != keep.end_date or other.start_date != other.end_date:
        updates["start_date"] = min(keep.start_date, other.start_date)
        updates["end_date"] = max(keep.end_date, other.end_date)
    return keep.model_copy(update=updates)


def merge(events: list[Event]) -> list[Event]:
    merged: list[Event] = []
    for event in sorted(events, key=lambda e: (e.start_date, -CONFIDENCE_RANK[e.confidence], e.title)):
        for index, existing in enumerate(merged):
            if _same(existing, event):
                merged[index] = _better(existing, event)
                break
        else:
            merged.append(event)
    return sorted(merged, key=lambda e: (e.start_date, e.start_time or "", e.title))
