"""Load config/sawtooth.yaml. Sawtooth numbers are not hard-coded in Python."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from reorder.paths import reject_ground_truth


def repo_root() -> Path:
    """Directory that contains config/sawtooth.yaml."""

    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "config" / "sawtooth.yaml").is_file():
            return parent
    raise FileNotFoundError("config/sawtooth.yaml not found above the reorder package")


@dataclass(frozen=True)
class BarConfig:
    raw: dict[str, Any]
    path: Path

    @property
    def cutoff_hour(self) -> int:
        return int(self.raw["bar"]["business_day_cutoff_hour"])

    @property
    def time_zone(self) -> str:
        return str(self.raw["bar"].get("time_zone", "America/New_York"))

    @property
    def bottle_service(self) -> bool:
        return bool(self.raw["modules"]["bottle_service"])

    @property
    def closed_weekdays(self) -> tuple[str, ...]:
        days = self.raw["bar"].get("closed_weekdays", ["Sun"])
        return tuple(str(day) for day in days)

    @property
    def item_aliases(self) -> dict[str, str]:
        return {str(k): str(v) for k, v in self.raw.get("item_aliases", {}).items()}

    @property
    def targets(self) -> dict[str, float]:
        return {str(k): float(v) for k, v in self.raw["targets"].items()}

    @property
    def state_rules(self) -> str:
        return str(self.raw["bar"].get("state_rules", "")).strip().lower()

    @property
    def supplier_channels(self) -> dict[str, str]:
        return {str(k): str(v) for k, v in self.raw.get("supplier_channels", {}).items()}

    def resolve(self, key: str) -> Path:
        relative = Path(str(self.raw["paths"][key]))
        path = relative if relative.is_absolute() else self.path.parent.parent / relative
        reject_ground_truth(path)
        return path


def load_config(path: Path | None = None) -> BarConfig:
    config_path = path or (repo_root() / "config" / "sawtooth.yaml")
    reject_ground_truth(config_path)
    with config_path.open() as handle:
        raw = yaml.safe_load(handle)
    if not isinstance(raw, dict):
        raise ValueError(f"{config_path} did not contain a mapping")
    return BarConfig(raw=raw, path=config_path)
