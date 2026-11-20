"""The scout end to end with fakes: no network, no API key, no Azure."""
from __future__ import annotations

import csv
import datetime as dt
from types import SimpleNamespace as NS

from townwise_research.dedupe import merge
from townwise_research.graph import run
from townwise_research.researcher import BeatResult, KnownEvent, Researcher, _validate
from townwise_research.schema import CSV_COLUMNS, Event, event_id, record_events_tool
from townwise_research.sources import HANOVER_BEATS, SAWTOOTH
from townwise_research.store import index_definition, to_document

START, END = dt.date(2026, 11, 20), dt.date(2026, 12, 19)


def event(title="Dartmouth vs. Harvard (men's hockey)", day=dt.date(2026, 12, 5), **over) -> dict:
    base = dict(title=title, category="athletics", start_date=day.isoformat(), end_date=day.isoformat(),
                start_time="19:00", venue="Thompson Arena", town="Hanover, NH", expected_attendance=3000,
                audience="mixed", demand_effect="increase", effect_strength="high", dayparts=["dinner", "late_night"],
                rationale="Sellout rivalry game a short walk away.", source_url="https://dartmouthsports.com/x",
                source_title="Dartmouth Athletics", confidence="high")
    base.update(over)
    return base


# --- schema -------------------------------------------------------------------------------------------------------

def test_record_events_tool_is_strict_all_the_way_down():
    tool = record_events_tool()
    assert tool["strict"] is True
    item = tool["input_schema"]["properties"]["events"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(Event.model_fields)
    assert "$ref" not in str(tool) and "$defs" not in str(tool)
    assert item["properties"]["dayparts"]["items"]["enum"] == ["brunch", "lunch", "dinner", "late_night"]


def test_validate_keeps_good_events_and_names_bad_ones():
    events, errors = _validate({"events": [event(), event(category="space_launch"),
                                           event(day=dt.date(2026, 12, 6), end_date="2026-12-01")]})
    assert len(events) == 1 and events[0].venue == "Thompson Arena"
    assert len(errors) == 2 and errors[0].startswith("events[1]") and "before start_date" in errors[1]
    assert _validate("nope") == ([], ["input must be an object with an 'events' array"])


def test_event_id_is_stable_and_ignores_case_and_punctuation():
    a = Event.model_validate(event())
    b = Event.model_validate(event(title="DARTMOUTH vs Harvard -- Men's Hockey", confidence="low"))
    assert event_id(a) == event_id(b)
    assert event_id(a) != event_id(Event.model_validate(event(day=dt.date(2026, 12, 6))))


# --- dedupe -------------------------------------------------------------------------------------------------------

def test_merge_folds_near_duplicates_keeping_the_better_source():
    high = Event.model_validate(event(start_time=None))
    low = Event.model_validate(event(title="Dartmouth vs Harvard men's hockey game", confidence="medium",
                                     dayparts=["brunch"], start_time="19:30"))
    other_day = Event.model_validate(event(day=dt.date(2026, 12, 6)))
    merged = merge([low, high, other_day])
    assert len(merged) == 2
    assert merged[0].confidence == "high" and merged[0].start_time == "19:30"
    assert merged[0].dayparts == ["brunch", "dinner", "late_night"]


def test_merge_keeps_same_day_events_with_different_names():
    show = Event.model_validate(event(title="The Nutcracker", category="arts_culture", venue="Hopkins Center"))
    game = Event.model_validate(event())
    assert len(merge([show, game])) == 2


# --- store --------------------------------------------------------------------------------------------------------

def test_index_definition_has_a_key_and_matches_documents():
    index = index_definition("townwise-events")
    names = {f.name for f in index.fields}
    assert [f.name for f in index.fields if f.key] == ["id"]
    doc = to_document(Event.model_validate(event()), "run-1", dt.datetime(2026, 11, 19, 12, tzinfo=dt.timezone.utc))
    assert set(doc) == names
    assert doc["start_date"] == "2026-12-05T00:00:00Z" and doc["last_seen"] == "2026-11-19T12:00:00Z"


# --- researcher loop ----------------------------------------------------------------------------------------------

class FakeStream:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.response


def response(stop, content, searches=0):
    usage = NS(input_tokens=100, output_tokens=50, cache_read_input_tokens=0, cache_creation_input_tokens=0,
               server_tool_use=NS(web_search_requests=searches, web_fetch_requests=0))
    return NS(stop_reason=stop, content=content, usage=usage, stop_details=None)


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = NS(messages=NS(stream=self.stream))

    def stream(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})  # a snapshot: the loop keeps appending
        return FakeStream(self.responses.pop(0))


def tool_use(id_, input_):
    return NS(type="tool_use", name="record_events", id=id_, input=input_)


def test_researcher_resumes_pauses_answers_tool_calls_and_stops_at_end_turn():
    client = FakeClient([
        response("pause_turn", [NS(type="server_tool_use", name="web_search", id="s1", input={})], searches=3),
        response("tool_use", [tool_use("t1", {"events": [event(), event(category="bogus")]})], searches=2),
        response("end_turn", [NS(type="text", text="Done.")]),
    ])
    result = Researcher(client).research(SAWTOOTH, HANOVER_BEATS[1], START, END, [KnownEvent("Old", "2026-11-21")])
    assert [e.title for e in result.events] == ["Dartmouth vs. Harvard (men's hockey)"]
    assert result.searches == 5 and result.rejected_calls == 1 and result.stop_reason == "end_turn"
    assert len(client.calls) == 3
    first = client.calls[0]
    assert first["model"] == "claude-opus-5-5" and first["fallbacks"] == "default"
    assert "temperature" not in first and "thinking" not in first
    assert "2026-11-21: Old" in first["messages"][0]["content"]
    # the paused turn is sent back as-is, with no extra user message
    assert [m["role"] for m in client.calls[1]["messages"]] == ["user", "assistant"]
    reply = client.calls[2]["messages"][-1]["content"][0]
    assert reply["tool_use_id"] == "t1" and reply["is_error"] is True and "events[1]" in reply["content"]


def test_researcher_stops_on_refusal():
    client = FakeClient([response("refusal", [])])
    assert Researcher(client).research(SAWTOOTH, HANOVER_BEATS[0], START, END, []).stop_reason == "refusal"


# --- graph --------------------------------------------------------------------------------------------------------

class FakeResearcher:
    def __init__(self):
        self.seen = []

    def research(self, restaurant, beat, start, end, known):
        self.seen.append((beat.key, [k.title for k in known]))
        found = {
            "dartmouth_athletics": [event()],
            "dartmouth_academic": [event(title="Dartmouth vs Harvard men's hockey", confidence="medium"),
                                   event(title="Winter break begins", category="academic", day=dt.date(2026, 12, 12),
                                         demand_effect="decrease", audience="students", dayparts=["lunch", "dinner"]),
                                   event(title="Out of window", day=dt.date(2027, 3, 1))],
        }.get(beat.key, [])
        return BeatResult(beat=beat.key, events=[Event.model_validate(e) for e in found], searches=2,
                          input_tokens=10, output_tokens=5)


class MemoryStore:
    def __init__(self):
        self.docs = {}

    def known(self, start, end):
        return [KnownEvent("Already indexed", "2026-11-25")]

    def upsert(self, events, run_id):
        for e in events:
            self.docs[event_id(e)] = to_document(e, run_id, dt.datetime.now(dt.timezone.utc))
        return len(events)


def test_graph_fans_out_merges_indexes_and_reports(tmp_path):
    researcher, store = FakeResearcher(), MemoryStore()
    state = run(researcher, store, SAWTOOTH, list(HANOVER_BEATS), START, END, tmp_path)

    assert sorted(k for k, _ in researcher.seen) == sorted(b.key for b in HANOVER_BEATS)
    assert all(known == ["Already indexed"] for _, known in researcher.seen)
    assert [e.title for e in state["events"]] == ["Dartmouth vs. Harvard (men's hockey)", "Winter break begins"]
    assert state["indexed"] == 2 and len(store.docs) == 2

    csv_path, brief_path, usage_path = state["files"]
    with csv_path.open() as handle:
        rows = list(csv.DictReader(handle))
    assert list(rows[0]) == CSV_COLUMNS
    assert rows[1]["kind"] == "academic" and rows[1]["demand_effect"] == "decrease"
    brief = brief_path.read_text()
    assert "## Plan around these" in brief and "▲ Dartmouth vs. Harvard" in brief and "▼ Winter break begins" in brief
    assert '"beat": "dartmouth_academic"' in usage_path.read_text()


# --- fixes from the first full run (2026-11-19) -------------------------------------------------------------------

def test_merge_catches_reworded_titles_and_shifted_runs_from_the_first_run():
    a = Event.model_validate(event(title="UVBA's Celebrate the Season in Downtown Hanover (Dartmouth Green tree lighting)",
                                   category="community", day=dt.date(2026, 12, 4)))
    b = Event.model_validate(event(title="UVBA's Celebrate the Season in Downtown Hanover (tree lighting on the Dartmouth Green)",
                                   category="community", day=dt.date(2026, 12, 4)))
    preview = Event.model_validate(event(title="Disney's Frozen: The Broadway Musical (Northern Stage)", category="arts_culture",
                                         day=dt.date(2026, 11, 18), end_date="2027-01-03", town="White River Junction, VT"))
    opening = Event.model_validate(event(title="Disney's Frozen: The Broadway Musical (Northern Stage)", category="arts_culture",
                                         day=dt.date(2026, 11, 19), end_date="2027-01-03", town="White River Junction, VT"))
    merged = merge([a, b, preview, opening])
    assert len(merged) == 2
    run_ = next(e for e in merged if "Frozen" in e.title)
    assert (run_.start_date, run_.end_date) == (dt.date(2026, 11, 18), dt.date(2027, 1, 3))


def test_merge_keeps_mens_and_womens_games_apart():
    men = Event.model_validate(event(title="Dartmouth vs. Harvard (men's hockey)"))
    women = Event.model_validate(event(title="Dartmouth vs. Harvard (women's hockey)"))
    assert len(merge([men, women])) == 2


def test_researcher_caches_and_enforces_the_search_budget_across_turns():
    client = FakeClient([
        response("tool_use", [tool_use("t1", {"events": [event()]})], searches=4),
        response("tool_use", [tool_use("t2", {"events": []})], searches=3),
        response("end_turn", [NS(type="text", text="Done.")]),
    ])
    result = Researcher(client, max_searches=4).research(SAWTOOTH, HANOVER_BEATS[1], START, END, [])
    assert all(call["cache_control"] == {"type": "ephemeral"} for call in client.calls)
    assert client.calls[0]["tools"] == client.calls[2]["tools"]  # unchanged tools keep the cache valid
    note = client.calls[1]["messages"][-1]["content"][-1]
    assert note["type"] == "text" and "Budget reached (4 searches" in note["text"]
    assert result.searches == 7 and result.stop_reason == "end_turn"


def test_researcher_hard_stops_a_beat_at_twice_its_budget():
    client = FakeClient([response("pause_turn", [], searches=5), response("pause_turn", [], searches=4),
                         response("end_turn", [])])
    result = Researcher(client, max_searches=4).research(SAWTOOTH, HANOVER_BEATS[1], START, END, [])
    assert len(client.calls) == 2 and result.searches == 9


def test_cost_counts_cache_reads_at_a_twentieth_of_input():
    r = BeatResult(beat="x", searches=10, input_tokens=1_000_000, cache_read_tokens=800_000,
                   cache_write_tokens=100_000, output_tokens=10_000)
    assert round(r.cost_usd(), 2) == round((100_000 * 4 + 800_000 * 0.2 + 100_000 * 5 + 10_000 * 20) / 1e6 + 0.10, 2)


def test_a_beat_that_hits_an_api_error_keeps_its_events_and_the_run_goes_on(tmp_path):
    import anthropic
    import httpx

    class FailingClient(FakeClient):
        def stream(self, **kwargs):
            if len(self.calls) == 1:
                self.calls.append(kwargs)
                raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
            return super().stream(**kwargs)

    client = FailingClient([response("tool_use", [tool_use("t1", {"events": [event()]})])])
    result = Researcher(client).research(SAWTOOTH, HANOVER_BEATS[5], START, END, [])
    assert len(result.events) == 1 and result.stop_reason == "error" and result.error.startswith("APIConnectionError")


def test_budget_note_waits_while_a_server_tool_is_pending():
    pending = NS(type="server_tool_use", name="code_execution", id="srv1", input={})
    client = FakeClient([
        response("tool_use", [pending, tool_use("t1", {"events": [event()]})], searches=4),
        response("tool_use", [tool_use("t2", {"events": []})]),
        response("end_turn", [NS(type="text", text="Done.")]),
    ])
    Researcher(client, max_searches=4).research(SAWTOOTH, HANOVER_BEATS[1], START, END, [])
    first_reply = client.calls[1]["messages"][-1]["content"]
    assert [b["type"] for b in first_reply] == ["tool_result"]  # only tool results while code_execution waits
    later_reply = client.calls[2]["messages"][-1]["content"]
    assert later_reply[-1]["type"] == "text" and "Budget reached" in later_reply[-1]["text"]
