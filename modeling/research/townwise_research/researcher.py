"""One beat's research: a Claude conversation with web search, web fetch and the `record_events` tool.

Claude searches and reads pages server-side (Anthropic runs web search and web fetch), and hands its findings back
through `record_events`, a strict client tool whose input this module validates and keeps. The loop resumes a paused
server-tool turn (`pause_turn`), answers each `record_events` call, and stops when Claude ends its turn or the beat
runs out of iterations.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import anthropic
from pydantic import ValidationError

from .schema import Event, record_events_tool
from .sources import Beat, Restaurant

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
# Opus 5.5 can refuse in a few safety categories; "default" re-runs a declined request on a fitting fallback model.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass
class KnownEvent:
    """An event already in the index for this window, shown to Claude so it looks for what's missing."""

    title: str
    start_date: str
    venue: str | None = None


@dataclass
class BeatResult:
    beat: str
    events: list[Event] = field(default_factory=list)
    searches: int = 0
    fetches: int = 0
    input_tokens: int = 0  # every input token, cached or not
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    rejected_calls: int = 0
    stop_reason: str | None = None
    error: str | None = None

    def cost_usd(self) -> float:
        """Claude Opus 5.5 list prices: $4 / $20 per million, cache reads $0.20, 5-minute cache writes 1.25x input;
        web search $10 per 1,000 (fetches are billed as tokens only)."""
        uncached = self.input_tokens - self.cache_read_tokens - self.cache_write_tokens
        return (uncached * 4 + self.cache_read_tokens * 0.20 + self.cache_write_tokens * 5 + self.output_tokens * 20) / 1e6 \
            + self.searches * 0.01


SYSTEM = """You research upcoming events for a restaurant's demand planning.

You work one beat (one slice of local life) per conversation. Search the web and read the most authoritative pages \
(official calendars, organizer and venue pages) for events whose dates fall inside the research window. For each \
confirmed event, judge how it moves demand at the restaurant and record it with the record_events tool.

Rules:
- Record only events with a date you read on a page; put that page in source_url. Never invent dates or crowd sizes.
- Rate confidence honestly: high for an official calendar or organizer page showing these dates, medium for a \
secondary source, low for anything inferred.
- Judge the effect for this restaurant specifically: walking distance from Allen Street matters, evening events \
create pre- and post-event dinner and bar demand, student breaks and closures lower it.
- Record in batches as you go; don't hold everything to the end. Skip events already listed as known unless their \
date changed.
- When you have covered the beat, end with a short plain summary of what you found and what you could not confirm."""


def _prompt(restaurant: Restaurant, beat: Beat, start: dt.date, end: dt.date, known: list[KnownEvent]) -> str:
    known_lines = "\n".join(f"- {k.start_date}: {k.title}" + (f" ({k.venue})" if k.venue else "") for k in known)
    seeds = "\n".join(f"- {url}" for url in beat.seeds) or "- (none; search from scratch)"
    return f"""Restaurant: {restaurant.name}, {restaurant.address}
{restaurant.description}

Beat: {beat.title}
What to cover: {beat.focus}

Research window: {start.isoformat()} to {end.isoformat()} (inclusive). Today is {dt.date.today().isoformat()}.

Good starting points:
{seeds}

Already known for this window (don't record again unless a date changed):
{known_lines or "- nothing yet"}"""


def _validate(raw: Any) -> tuple[list[Event], list[str]]:
    """Strict tools still need checking here: with eager input streaming the SDK hands over the input unvalidated."""
    if not isinstance(raw, dict) or not isinstance(raw.get("events"), list):
        return [], ["input must be an object with an 'events' array"]
    events, errors = [], []
    for index, item in enumerate(raw["events"]):
        try:
            event = Event.model_validate(item)
        except ValidationError as err:
            errors.append(f"events[{index}]: {err.errors()[0]['msg']}")
            continue
        if event.end_date < event.start_date:
            errors.append(f"events[{index}]: end_date is before start_date")
            continue
        events.append(event)
    return events, errors


def _server_tool_pending(content: list[Any]) -> bool:
    """True when a server tool call in this turn has no result yet, i.e. it is waiting on our tool results."""
    used = {b.id for b in content if getattr(b, "type", None) == "server_tool_use"}
    answered = {getattr(b, "tool_use_id", None) for b in content if str(getattr(b, "type", "")).endswith("_tool_result")}
    return bool(used - answered)


class Researcher:
    def __init__(self, client: anthropic.Anthropic | None = None, *, model: str = MODEL, effort: str = "high",
                 max_searches: int = 10, max_fetches: int = 15, max_iterations: int = 16) -> None:
        self.client = client or anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.max_searches = max_searches
        self.max_fetches = max_fetches
        self.max_iterations = max_iterations

    def tools(self) -> list[dict]:
        location = {"type": "approximate", "city": "Hanover", "region": "New Hampshire", "country": "US",
                    "timezone": "America/New_York"}
        return [
            {"type": "web_search_20260209", "name": "web_search", "max_uses": self.max_searches,
             "user_location": location},
            {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": self.max_fetches},
            record_events_tool(),
        ]

    def research(self, restaurant: Restaurant, beat: Beat, start: dt.date, end: dt.date,
                 known: list[KnownEvent]) -> BeatResult:
        result = BeatResult(beat=beat.key)
        messages: list[dict] = [{"role": "user", "content": _prompt(restaurant, beat, start, end, known)}]
        tools = self.tools()
        for _ in range(self.max_iterations):
            try:
                response = self._turn(messages, tools)
            except anthropic.APIError as err:
                # One beat's failure ends that beat with what it recorded; the graph carries on with the others.
                previous = messages[-1]["content"] if messages[-1]["role"] == "assistant" else None
                shape = [getattr(b, "type", "?") for b in previous] if isinstance(previous, list) else None
                log.error("beat %s: API error after stop %s %s: %s", beat.key, result.stop_reason, shape, err)
                result.error = f"{type(err).__name__}: {getattr(err, 'message', err)}"
                result.stop_reason = "error"
                break
            self._count(result, response)
            result.stop_reason = response.stop_reason
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                log.warning("beat %s: refused (%s)", beat.key, getattr(response.stop_details, "category", None))
                break
            if result.searches >= 2 * self.max_searches or result.fetches >= 2 * self.max_fetches:
                # max_uses counts one request; a beat that keeps searching across turns is stopped here.
                log.warning("beat %s: stopped at %d searches / %d fetches", beat.key, result.searches, result.fetches)
                break
            if response.stop_reason == "pause_turn":
                continue  # the server resumes its own tool loop when the paused turn is sent back
            if response.stop_reason == "max_tokens":
                log.warning("beat %s: hit max_tokens; keeping what was recorded", beat.key)
                break
            calls = [b for b in response.content if b.type == "tool_use" and b.name == "record_events"]
            if response.stop_reason != "tool_use" or not calls:
                break
            replies = []
            for call in calls:
                events, errors = _validate(call.input)
                result.events.extend(events)
                if errors:
                    result.rejected_calls += 1
                    replies.append({"type": "tool_result", "tool_use_id": call.id, "is_error": True,
                                    "content": f"Recorded {len(events)}; fix and resend these: " + "; ".join(errors[:10])})
                else:
                    replies.append({"type": "tool_result", "tool_use_id": call.id,
                                    "content": f"Recorded {len(events)} event(s). Continue the beat, or finish with a summary."})
            over = result.searches >= self.max_searches or result.fetches >= self.max_fetches
            if over and not _server_tool_pending(response.content):
                # A text block after the results, not a tool change: changing tools would void the cached prefix.
                # Not while a server tool waits on these results (the web tools' code step calling record_events):
                # then the reply may hold tool_result blocks only, so the note waits for a later turn.
                replies.append({"type": "text", "text": (
                    f"Budget reached ({result.searches} searches, {result.fetches} fetches). Don't search or fetch "
                    "again: record anything confirmed that you haven't recorded, then finish with your summary.")})
            messages.append({"role": "user", "content": replies})
        else:
            log.warning("beat %s: stopped at %d iterations", beat.key, self.max_iterations)
        log.info("beat %s: %d events, %d searches, %d fetches", beat.key, len(result.events), result.searches, result.fetches)
        return result

    def _turn(self, messages: list[dict], tools: list[dict]) -> Any:
        with self.client.beta.messages.stream(
            model=self.model,
            max_tokens=64000,
            system=SYSTEM,
            messages=messages,
            tools=tools,
            output_config={"effort": self.effort},
            # Each turn resends everything read so far; caching the prefix bills it at a tenth on later turns.
            # Tools and system never change within a beat, so nothing ahead of the history invalidates it.
            cache_control={"type": "ephemeral"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            return stream.get_final_message()

    @staticmethod
    def _count(result: BeatResult, response: Any) -> None:
        usage = response.usage
        read = getattr(usage, "cache_read_input_tokens", 0) or 0
        write = getattr(usage, "cache_creation_input_tokens", 0) or 0
        result.input_tokens += (usage.input_tokens or 0) + read + write
        result.cache_read_tokens += read
        result.cache_write_tokens += write
        result.output_tokens += usage.output_tokens or 0
        server = getattr(usage, "server_tool_use", None)
        if server is not None:
            result.searches += getattr(server, "web_search_requests", 0) or 0
            result.fetches += getattr(server, "web_fetch_requests", 0) or 0


def summarize(results: list[BeatResult]) -> str:
    return json.dumps([{"beat": r.beat, "events": len(r.events), "searches": r.searches, "fetches": r.fetches,
                        "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "stop": r.stop_reason}
                       for r in results], indent=1)
