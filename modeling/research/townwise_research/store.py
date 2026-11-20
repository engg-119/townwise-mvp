"""Azure AI Search: the scout's memory.

Every event goes into one index (default `townwise-events`), keyed by a stable id, so re-running a window updates
documents instead of adding copies. The scout reads it back twice: before researching (what's already known for the
window, so Claude looks for gaps) and for people and other agents who ask "what's on that week?".

Auth: your Entra sign-in (az login). The service has API keys turned off (infra/terraform/production/search.tf);
developers hold Search Index Data Contributor, which reads and writes documents, and an administrator creates the
index once with `ensure-index`. AZURE_SEARCH_KEY is honoured only for a service that still allows keys.
"""
from __future__ import annotations

import datetime as dt
import os
from typing import Protocol

from azure.core.credentials import AzureKeyCredential, TokenCredential
from azure.core.exceptions import ResourceNotFoundError
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchableField, SearchFieldDataType, SearchIndex, SimpleField,
)

from .researcher import KnownEvent
from .schema import Event, event_id

DEFAULT_INDEX = "townwise-events"


class EventStore(Protocol):
    def known(self, start: dt.date, end: dt.date) -> list[KnownEvent]: ...
    def upsert(self, events: list[Event], run_id: str) -> int: ...


def index_definition(name: str) -> SearchIndex:
    text = SearchFieldDataType.String
    when = SearchFieldDataType.DateTimeOffset
    return SearchIndex(name=name, fields=[
        SimpleField(name="id", type=text, key=True),
        SearchableField(name="title", type=text, analyzer_name="en.microsoft"),
        SimpleField(name="category", type=text, filterable=True, facetable=True),
        SimpleField(name="start_date", type=when, filterable=True, sortable=True),
        SimpleField(name="end_date", type=when, filterable=True, sortable=True),
        SimpleField(name="start_time", type=text),
        SearchableField(name="venue", type=text, filterable=True),
        SearchableField(name="town", type=text, filterable=True, facetable=True),
        SimpleField(name="expected_attendance", type=SearchFieldDataType.Int32, filterable=True, sortable=True),
        SimpleField(name="audience", type=text, filterable=True, facetable=True),
        SimpleField(name="demand_effect", type=text, filterable=True, facetable=True),
        SimpleField(name="effect_strength", type=text, filterable=True, facetable=True),
        SimpleField(name="dayparts", type=SearchFieldDataType.Collection(text), filterable=True, facetable=True),
        SearchableField(name="rationale", type=text, analyzer_name="en.microsoft"),
        SimpleField(name="source_url", type=text),
        SearchableField(name="source_title", type=text),
        SimpleField(name="confidence", type=text, filterable=True, facetable=True),
        SimpleField(name="last_seen", type=when, filterable=True, sortable=True),
        SimpleField(name="run_id", type=text, filterable=True),
    ])


def _midnight(day: dt.date) -> str:
    return f"{day.isoformat()}T00:00:00Z"


def to_document(event: Event, run_id: str, now: dt.datetime) -> dict:
    return {
        "id": event_id(event), "title": event.title, "category": event.category,
        "start_date": _midnight(event.start_date), "end_date": _midnight(event.end_date),
        "start_time": event.start_time, "venue": event.venue, "town": event.town,
        "expected_attendance": event.expected_attendance, "audience": event.audience,
        "demand_effect": event.demand_effect, "effect_strength": event.effect_strength, "dayparts": event.dayparts,
        "rationale": event.rationale, "source_url": event.source_url, "source_title": event.source_title,
        "confidence": event.confidence, "last_seen": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "run_id": run_id,
    }


def _odata(value: str) -> str:
    return value.replace("'", "''")


class AzureEventStore:
    def __init__(self, endpoint: str, index: str = DEFAULT_INDEX, credential: AzureKeyCredential | TokenCredential | None = None):
        if credential is None:
            key = os.environ.get("AZURE_SEARCH_KEY")
            if key:
                credential = AzureKeyCredential(key)
            else:
                from azure.identity import DefaultAzureCredential
                credential = DefaultAzureCredential()
        self.index = index
        self.indexes = SearchIndexClient(endpoint, credential)
        self.search = SearchClient(endpoint, index, credential)

    @classmethod
    def from_env(cls) -> "AzureEventStore":
        endpoint = os.environ.get("AZURE_SEARCH_ENDPOINT")
        if not endpoint:
            raise SystemExit("AZURE_SEARCH_ENDPOINT is not set (e.g. https://<service>.search.windows.net)")
        return cls(endpoint, os.environ.get("AZURE_SEARCH_INDEX", DEFAULT_INDEX))

    def index_exists(self) -> bool:
        """Asks through the documents API, which Search Index Data roles may call (reading the index definition needs
        a control-plane role developers don't hold)."""
        try:
            self.search.get_document_count()
            return True
        except ResourceNotFoundError:
            return False

    def ensure_index(self) -> bool:
        """Creates the index or updates its fields. True when it was created."""
        try:
            self.indexes.get_index(self.index)
            created = False
        except ResourceNotFoundError:
            created = True
        self.indexes.create_or_update_index(index_definition(self.index))
        return created

    def known(self, start: dt.date, end: dt.date) -> list[KnownEvent]:
        """Every indexed event overlapping the window, whatever its town (beats reach into the Upper Valley)."""
        flt = f"start_date le {_midnight(end)} and end_date ge {_midnight(start)}"
        try:
            results = self.search.search(search_text="*", filter=flt, select=["title", "start_date", "venue"],
                                         order_by=["start_date asc"], top=1000)
            return [KnownEvent(r["title"], r["start_date"][:10], r.get("venue")) for r in results]
        except ResourceNotFoundError:
            return []

    def upsert(self, events: list[Event], run_id: str) -> int:
        if not events:
            return 0
        now = dt.datetime.now(dt.timezone.utc)
        documents = {}
        for event in events:
            document = to_document(event, run_id, now)
            documents[document["id"]] = document  # one per id: a batch may not name a key twice
        results = self.search.merge_or_upload_documents(list(documents.values()))
        failed = [r for r in results if not r.succeeded]
        if failed:
            raise RuntimeError(f"{len(failed)} event(s) failed to index, first: {failed[0].key}: {failed[0].error_message}")
        return len(documents)

    def query(self, text: str, *, town: str | None = None, start: dt.date | None = None, end: dt.date | None = None,
              top: int = 20) -> list[dict]:
        filters = []
        if town:
            filters.append(f"town eq '{_odata(town)}'")
        if start:
            filters.append(f"end_date ge {_midnight(start)}")
        if end:
            filters.append(f"start_date le {_midnight(end)}")
        results = self.search.search(search_text=text or "*", filter=" and ".join(filters) or None,
                                     order_by=None if text else ["start_date asc"], top=top)
        return [dict(r) for r in results]


class NullStore:
    """For a dry run: remembers nothing and writes nothing."""

    def known(self, start: dt.date, end: dt.date) -> list[KnownEvent]:
        return []

    def upsert(self, events: list[Event], run_id: str) -> int:
        return 0
