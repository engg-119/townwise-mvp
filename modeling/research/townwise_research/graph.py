"""The scout as a LangGraph graph.

    START -> recall -> research (one branch per beat, in parallel) -> merge -> index -> report -> END

recall    reads what Azure AI Search already holds for the window, so each beat looks for what's missing
research  one Claude conversation per beat (researcher.py); branches fan out with Send and their findings and usage
          are added together by the state's reducers
merge     de-duplicates across beats (dedupe.py)
index     upserts the merged events into Azure AI Search (store.py)
report    writes the CSV and the planning brief (report.py)

The researcher and the store are passed in, so tests run the whole graph with fakes and no network.
"""
from __future__ import annotations

import datetime as dt
import operator
import uuid
from pathlib import Path
from typing import Annotated, Protocol, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from . import report as report_mod
from .dedupe import merge
from .researcher import BeatResult, KnownEvent
from .schema import Event
from .sources import Beat, Restaurant
from .store import EventStore


class BeatResearcher(Protocol):
    def research(self, restaurant: Restaurant, beat: Beat, start: dt.date, end: dt.date,
                 known: list[KnownEvent]) -> BeatResult: ...


class ScoutState(TypedDict, total=False):
    restaurant: Restaurant
    beats: list[Beat]
    start: dt.date
    end: dt.date
    run_id: str
    out_dir: Path
    known: list[KnownEvent]
    results: Annotated[list[BeatResult], operator.add]
    events: list[Event]
    indexed: int
    files: list[Path]


class BeatTask(TypedDict):
    restaurant: Restaurant
    beat: Beat
    start: dt.date
    end: dt.date
    known: list[KnownEvent]


def build_graph(researcher: BeatResearcher, store: EventStore):
    def recall(state: ScoutState) -> dict:
        return {"known": store.known(state["start"], state["end"])}

    def fan_out(state: ScoutState) -> list[Send]:
        return [Send("research", BeatTask(restaurant=state["restaurant"], beat=beat, start=state["start"],
                                          end=state["end"], known=state["known"]))
                for beat in state["beats"]]

    def research(task: BeatTask) -> dict:
        result = researcher.research(task["restaurant"], task["beat"], task["start"], task["end"], task["known"])
        return {"results": [result]}

    def merge_node(state: ScoutState) -> dict:
        found = [event for result in state["results"] for event in result.events]
        inside = [e for e in found if e.end_date >= state["start"] and e.start_date <= state["end"]]
        return {"events": merge(inside)}

    def index(state: ScoutState) -> dict:
        return {"indexed": store.upsert(state["events"], state["run_id"])}

    def report(state: ScoutState) -> dict:
        files = report_mod.write(state["out_dir"], state["restaurant"], state["start"], state["end"],
                                 state["events"], state["results"], state["run_id"])
        return {"files": files}

    graph = StateGraph(ScoutState)
    graph.add_node("recall", recall)
    graph.add_node("research", research)
    graph.add_node("merge", merge_node)
    graph.add_node("index", index)
    graph.add_node("report", report)
    graph.add_edge(START, "recall")
    graph.add_conditional_edges("recall", fan_out, ["research"])
    graph.add_edge("research", "merge")
    graph.add_edge("merge", "index")
    graph.add_edge("index", "report")
    graph.add_edge("report", END)
    return graph.compile()


def run(researcher: BeatResearcher, store: EventStore, restaurant: Restaurant, beats: list[Beat], start: dt.date,
        end: dt.date, out_dir: Path, *, concurrency: int = 4) -> ScoutState:
    run_id = f"{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:6]}"
    state: ScoutState = {"restaurant": restaurant, "beats": beats, "start": start, "end": end, "run_id": run_id,
                         "out_dir": out_dir, "results": []}
    return build_graph(researcher, store).invoke(state, config={"max_concurrency": concurrency})
