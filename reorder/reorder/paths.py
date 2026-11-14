"""Path checks. Evaluation files are never model inputs."""

from __future__ import annotations

from pathlib import Path


def reject_ground_truth(path: Path) -> None:
    """ground_truth/ is for scoring only. Reading it as an input is an error."""

    if "ground_truth" in Path(path).parts:
        raise ValueError(
            f"{path} is under ground_truth and cannot be used as a model input"
        )
