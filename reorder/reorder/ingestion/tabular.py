"""Read CSV and the simple spreadsheets in this dataset. No vendor-specific logic."""

from __future__ import annotations

import csv
import zipfile
from datetime import date, datetime
from pathlib import Path
# ElementTree never resolves external entities or fetches DTDs, and the expat behind Python 3.12 (2.4.1 or newer)
# refuses entity-expansion bombs, so the XXE and billion-laughs cases this rule guards against do not apply.
# nosemgrep: python.lang.security.use-defused-xml.use-defused-xml
from xml.etree import ElementTree as ET

from reorder.paths import reject_ground_truth

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_headers(path: Path) -> list[str]:
    reject_ground_truth(path)
    rows = iter_rows(path)
    if not rows:
        return []
    first = rows[0]
    if isinstance(first, dict):
        return list(first.keys())
    return [str(cell) for cell in first]


def iter_rows(path: Path) -> list[dict[str, str]] | list[list[str]]:
    reject_ground_truth(path)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(newline="") as handle:
            return list(csv.DictReader(handle))
    if suffix == ".xlsx":
        return _xlsx_rows(path)
    raise ValueError(f"unsupported table format: {path.suffix}")


def parse_date(value: str) -> date:
    text = value.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"could not read a date from {value!r}")


def parse_timestamp(value: str) -> datetime:
    text = value.strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"could not read a timestamp from {value!r}")


def parse_number(value: str) -> float:
    text = value.strip().replace(",", "").replace("$", "")
    if not text:
        return 0.0
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    return float(text)


def _xlsx_rows(path: Path) -> list[list[str]]:
    """First worksheet, inline strings. Enough for the owner count workbook and a POS export."""

    with zipfile.ZipFile(path) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    rows: list[list[str]] = []
    for row in sheet.findall("m:sheetData/m:row", _NS):
        values: list[str] = []
        for cell in row.findall("m:c", _NS):
            values.append(_cell_text(cell))
        rows.append(values)
    return rows


def xlsx_sheets(path: Path) -> list[tuple[str, list[list[str]]]]:
    """Every sheet name plus its rows. Used for one-tab-per-count workbooks."""

    reject_ground_truth(path)
    with zipfile.ZipFile(path) as workbook:
        root = ET.fromstring(workbook.read("xl/workbook.xml"))
        names = [
            sheet.attrib.get("name", "")
            for sheet in root.findall("m:sheets/m:sheet", _NS)
        ]
        sheets: list[tuple[str, list[list[str]]]] = []
        for index, name in enumerate(names, start=1):
            sheet = ET.fromstring(workbook.read(f"xl/worksheets/sheet{index}.xml"))
            rows: list[list[str]] = []
            for row in sheet.findall("m:sheetData/m:row", _NS):
                rows.append([_cell_text(cell) for cell in row.findall("m:c", _NS)])
            sheets.append((name, rows))
    return sheets


def _cell_text(cell: ET.Element) -> str:
    if cell.attrib.get("t") == "inlineStr":
        node = cell.find("m:is/m:t", _NS)
        return "" if node is None or node.text is None else node.text
    value = cell.find("m:v", _NS)
    return "" if value is None or value.text is None else value.text
