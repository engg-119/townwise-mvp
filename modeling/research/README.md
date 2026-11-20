# research

Townwise's event scout: a LangGraph agent that researches what's happening in and around Hanover, judges how each
event moves demand at Sawtooth, and keeps what it finds in Azure AI Search.

```
START -> recall -> research (one Claude conversation per beat, in parallel) -> merge -> index -> report -> END
```

| Step | What it does | File |
|---|---|---|
| recall | Reads the events Azure AI Search already holds for the window, so each beat looks for what's missing | `store.py` |
| research | One Claude Opus 5.5 conversation per beat, with Anthropic's server-side web search and web fetch. Claude hands each confirmed event back through `record_events`, a strict tool whose input is validated before it is kept; a bad item goes back to Claude as an error to fix | `researcher.py` |
| merge | Folds duplicates found by two beats (same start day and town, near-identical name), keeping the better-sourced record | `dedupe.py` |
| index | Upserts into the `townwise-events` index, keyed by a stable id, so a re-run updates documents instead of copying them | `store.py` |
| report | Writes `out/events_<from>_<to>.csv` (the columns of `../dartmouth_calendar_2025_2026.csv` first, so the demand model reads both the same way), a planning brief (`.md`) and the run's usage (`.usage.json`) | `report.py` |

The beats (`sources.py`) are Dartmouth's academic calendar and big weekends, home athletics, arts and culture, Hanover
town events, the Upper Valley, visitors and conferences, and local school breaks and disruptions. Federal holidays are
left out: the API's town calendar already computes them. Each event carries its source URL, a confidence rating, the
likely effect on demand (increase, decrease, mixed, none), how strong it is, and which services it lands on.

## Setup

Uses [uv](https://docs.astral.sh/uv/). From this folder:

```sh
uv sync
uv run pytest        # fakes only: no network, no API key, no Azure
```

Put the settings in `.env.local` here (gitignored):

```sh
ANTHROPIC_API_KEY=...                                    # the shared dev key: see ../../infra/README.md, "Shared developer key"
AZURE_SEARCH_ENDPOINT=https://srch-townwise-2d2c15bf.search.windows.net
# AZURE_SEARCH_INDEX=townwise-events                     # default
```

The search service is Terraform's (`infra/terraform/production/search.tf`, off until `enable_event_search`; see
`../../infra/README.md`, "Event search"). It accepts Entra sign-in only, so the store signs in as you (`az login`).
Developers hold Search Index Data Contributor on it, which reads and writes events; an administrator creates the
index once with `ensure-index`. Until then, use `--dry-run`.

## Run

```sh
uv run --env-file .env.local python -m townwise_research beats                 # list the beats
uv run --env-file .env.local python -m townwise_research scout --days 60       # research, index, report
uv run --env-file .env.local python -m townwise_research scout --beats dartmouth_athletics --days 14 --dry-run
uv run --env-file .env.local python -m townwise_research search "hockey" --days 30
uv run --env-file .env.local python -m townwise_research ensure-index
```

`--dry-run` neither reads nor writes Azure AI Search. `--effort` (default `high`) and `--max-searches` (default 10
per beat) trade depth for cost.

## Cost

Each beat is one conversation, and every turn resends what Claude has read so far, so input tokens dominate. Prompt
caching bills that resent history at a twentieth of the input price ($0.20 against $4 per million on Claude Opus 5.5),
and tools and the system prompt never change within a beat, so the cache holds. A beat stops searching at
`--max-searches` (default 10) and fetching at `--max-fetches` (default 15), counted across all its turns (the API's own
`max_uses` counts one request), and ends at twice either.

Measured on Hanover, 60 days, all seven beats (2026-11-20): 69 events, 77 searches, 4.6M input tokens of which 93%
came from the cache, 67k output, about $4.60. The same run before caching and budgets cost about $22. Each run's
`out/*.usage.json` has the per-beat counts and an estimated cost. Refused requests fall back to another model
automatically (`fallbacks: "default"`). A beat that hits an API error ends with the events it recorded, the error is in
the usage file, and the rest of the run carries on.
