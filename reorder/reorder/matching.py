"""Match a raw item name to a catalog id. Unmatched names stay on the review list."""

from __future__ import annotations

import re

from reorder.contracts import UnmatchedItem

_TOKEN = re.compile(r"[a-z0-9]+")


def normalize(name: str) -> str:
    return " ".join(_TOKEN.findall(name.lower()))


class ItemMatcher:
    def __init__(self, aliases: dict[str, str] | None = None) -> None:
        self._exact: dict[str, str] = {}
        self._labels: list[tuple[str, str]] = []
        for name, item_id in (aliases or {}).items():
            self.add(name, item_id)

    def add(self, name: str, item_id: str) -> None:
        key = normalize(name)
        if not key:
            return
        self._exact.setdefault(key, item_id)
        self._labels.append((key, item_id))

    def match(self, raw_name: str) -> str | None:
        return self._exact.get(normalize(raw_name))

    def suggest(self, raw_name: str) -> str | None:
        """Best catalog name that shares tokens with ``raw_name``. Not an assignment."""

        tokens = set(normalize(raw_name).split())
        if not tokens:
            return None
        best_id: str | None = None
        best_score = 0.0
        seen: set[str] = set()
        for label, item_id in self._labels:
            if item_id in seen:
                continue
            seen.add(item_id)
            label_tokens = set(label.split())
            if not label_tokens:
                continue
            overlap = len(tokens & label_tokens) / len(tokens)
            if overlap > best_score:
                best_score = overlap
                best_id = item_id
        if best_score <= 0:
            return None
        return best_id

    def review(self, raw_name: str, source_id: str) -> UnmatchedItem:
        return UnmatchedItem(
            raw_name=raw_name,
            source_id=source_id,
            suggested_item_id=self.suggest(raw_name),
            reason="no exact catalog name or confirmed alias",
        )
