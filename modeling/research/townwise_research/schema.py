"""The event record the agent produces, the index stores and the CSV carries.

One schema serves three places: the `record_events` tool Claude calls (strict JSON schema), the Azure AI Search
document, and the CSV row, which keeps the columns of ../dartmouth_calendar_2025_2026.csv first so the demand model
can read both files the same way.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal[
    "academic", "athletics", "arts_culture", "community", "festival", "conference_reunion", "visitors",
    "school_break", "disruption", "other",
]
Audience = Literal["students", "families_visitors", "alumni", "locals", "mixed"]
Effect = Literal["increase", "decrease", "mixed", "none"]
Strength = Literal["low", "medium", "high"]
Daypart = Literal["brunch", "lunch", "dinner", "late_night"]
Confidence = Literal["high", "medium", "low"]


class Event(BaseModel):
    """One dated happening, as Claude records it from a source it read."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(description="The event's name as the source gives it, e.g. 'Dartmouth vs. Harvard (men's hockey)'.")
    category: Category
    start_date: dt.date = Field(description="First day, ISO date.")
    end_date: dt.date = Field(description="Last day, inclusive; the start date for a one-day event.")
    start_time: str | None = Field(description="Local start time like '19:00', or null when the source gives none.")
    venue: str | None = Field(description="Where it happens, e.g. 'Thompson Arena'; null when unknown.")
    town: str = Field(description="Town it happens in, e.g. 'Hanover, NH' or 'Lebanon, NH'.")
    expected_attendance: int | None = Field(description="Rough crowd size if a source or venue capacity supports one; else null.")
    audience: Audience
    demand_effect: Effect = Field(description="Likely effect on a sit-down restaurant and bar on Allen Street, Hanover.")
    effect_strength: Strength
    dayparts: list[Daypart] = Field(description="Which services the effect lands on.")
    rationale: str = Field(description="One or two sentences: why this moves (or doesn't move) demand at the restaurant.")
    source_url: str = Field(description="The page the dates were read from.")
    source_title: str
    confidence: Confidence = Field(description="high: official calendar or organizer page for these dates; medium: secondary source; low: inferred or unconfirmed.")


def record_events_tool() -> dict:
    """The client tool Claude calls to hand over what it found. Strict, so every call matches the schema."""
    schema = Event.model_json_schema()
    item = {k: v for k, v in schema.items() if k not in ("title", "description")}
    return {
        "name": "record_events",
        "description": (
            "Record dated events you confirmed from a source you read. Call it once per batch (any number of events). "
            "Only events whose dates fall in the research window; skip ones already listed as known unless a date changed."
        ),
        "strict": True,
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "properties": {"events": {"type": "array", "items": _strictify(item, schema.get("$defs", {}))}},
            "required": ["events"],
            "additionalProperties": False,
        },
    }


def _strictify(node: dict, defs: dict) -> dict:
    """Inline $refs and make every object strict: all properties required, no extra keys, no unsupported keywords."""
    if "$ref" in node:
        return _strictify(defs[node["$ref"].split("/")[-1]], defs)
    out = {k: v for k, v in node.items() if k not in ("title", "default", "$defs")}
    if "anyOf" in out:
        out["anyOf"] = [_strictify(option, defs) for option in out["anyOf"]]
    if out.get("type") == "object" and "properties" in out:
        out["properties"] = {k: _strictify(v, defs) for k, v in out["properties"].items()}
        out["required"] = list(out["properties"])
        out["additionalProperties"] = False
    if out.get("type") == "array" and "items" in out:
        out["items"] = _strictify(out["items"], defs)
    return out


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def event_id(event: Event) -> str:
    """Stable across runs for the same event, so a re-run updates the index document instead of adding a copy."""
    raw = f"{slug(event.town)}|{event.start_date.isoformat()}|{slug(event.title)}"
    return hashlib.sha256(raw.encode()).hexdigest()


CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}

# The calendar CSV's columns first (same names and order), then what the scout adds.
CSV_COLUMNS = [
    "event", "kind", "start_date", "end_date", "source_url", "confidence", "notes",
    "venue", "town", "start_time", "expected_attendance", "audience", "demand_effect", "effect_strength", "dayparts",
]


def to_csv_row(event: Event) -> dict:
    return {
        "event": event.title,
        "kind": event.category,
        "start_date": event.start_date.isoformat(),
        "end_date": event.end_date.isoformat(),
        "source_url": event.source_url,
        "confidence": event.confidence,
        "notes": event.rationale,
        "venue": event.venue or "",
        "town": event.town,
        "start_time": event.start_time or "",
        "expected_attendance": "" if event.expected_attendance is None else event.expected_attendance,
        "audience": event.audience,
        "demand_effect": event.demand_effect,
        "effect_strength": event.effect_strength,
        "dayparts": ";".join(event.dayparts),
    }
