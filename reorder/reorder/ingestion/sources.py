"""Which fields each source file can report. A missing capability is unknown, not zero."""

from __future__ import annotations

from pathlib import Path

from reorder.contracts import SourceCapabilities
from reorder.ingestion.tabular import iter_rows
from reorder.paths import reject_ground_truth

_UNKNOWN = SourceCapabilities(False, False, False, False)


def load_source_capabilities(path: Path) -> dict[str, SourceCapabilities]:
    """Read reference/data_sources.csv. Keys are the source file names."""

    reject_ground_truth(path)
    catalog: dict[str, SourceCapabilities] = {}
    for raw in iter_rows(path):
        if not isinstance(raw, dict):
            raise ValueError("data_sources.csv needs a header row")
        catalog[Path(raw["source_file"]).name] = SourceCapabilities(
            has_void_qty=_flag(raw["has_void_qty"]),
            has_void_reason=_flag(raw["has_void_reason"]),
            has_comp_qty=_flag(raw["has_comp_qty"]),
            has_employee=_flag(raw["has_employee"]),
        )
    return catalog


def capabilities_for(path: Path, catalog: dict[str, SourceCapabilities] | None) -> SourceCapabilities:
    if not catalog:
        return _UNKNOWN
    return catalog.get(path.name, _UNKNOWN)


def _flag(value: str) -> bool:
    return value.strip().lower() == "true"
