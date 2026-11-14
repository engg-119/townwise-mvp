"""Owner screens for the count gap and the void review. Not for staff."""

from __future__ import annotations

from html import escape

from reorder.inventory import CountGap
from reorder.void_review import VoidReview


def render_owner_report(gaps: list[CountGap], review: VoidReview, *, count_date: str | None = None) -> str:
    shown = gaps
    if count_date is not None:
        shown = [gap for gap in gaps if gap.count_date.isoformat() == count_date]
    elif gaps:
        latest = max(gap.count_date for gap in gaps)
        shown = [gap for gap in gaps if gap.count_date == latest]
    rows = []
    for gap in sorted(shown, key=lambda item: item.item_id):
        rows.append(
            "<tr>"
            f"<td>{escape(gap.item_id)}</td>"
            f"<td>{gap.counted:.2f}</td>"
            f"<td>{gap.estimated:.2f}</td>"
            f"<td>{gap.known_waste:.2f}</td>"
            f"<td>{gap.unexplained:.2f}</td>"
            "</tr>"
        )
    flag_blocks = []
    for flag in review.flags:
        reasons = "".join(f"<li>{escape(line)}</li>" for line in flag.innocent_explanations)
        flag_blocks.append(f"<p>{escape(flag.summary)}</p><ul>{reasons}</ul>")
    if not flag_blocks:
        flag_blocks.append("<p>No unusual void pattern to review in this period.</p>")
    rate_rows = []
    for row in list(review.by_employee) + list(review.by_weekday) + list(review.by_hour) + list(review.by_reason):
        rate_rows.append(
            "<tr>"
            f"<td>{escape(row.slice_name)}</td>"
            f"<td>{escape(row.key)}</td>"
            f"<td>{row.voids}</td>"
            f"<td>{row.share_of_team:.1%}</td>"
            "</tr>"
        )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>How it's doing</title>
<style>
body {{ font-family: Georgia, serif; margin: 2rem; max-width: 46rem; color: #1c1c1c; }}
.banner {{ background: #f4efe6; border: 1px solid #d8d0c4; padding: 0.8rem 1rem; }}
table {{ border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }}
th, td {{ text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #e4e0d8; }}
</style>
</head>
<body>
<p class="banner">{escape(review.notice)}</p>
<h1>How it's doing</h1>
<p>Purchase units. Known waste is comps plus voids marked as waste. Unexplained is the rest of the gap between the estimate and the count.</p>
<table>
<thead><tr><th>Item</th><th>Counted</th><th>Estimated</th><th>Known waste</th><th>Unexplained</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody>
</table>
<h1>Void review</h1>
<p>Patterns to review. Not an accusation, and not for staff.</p>
{''.join(flag_blocks)}
<table>
<thead><tr><th>Slice</th><th>Group</th><th>Voids</th><th>Share</th></tr></thead>
<tbody>
{''.join(rate_rows)}
</tbody>
</table>
</body>
</html>
"""
