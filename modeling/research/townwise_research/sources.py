"""Who the research is for, and the beats it covers.

A beat is one slice of the town's life the agent researches on its own (one Claude conversation each, run in
parallel by the graph). Seed pages are starting points, not limits: the agent searches past them. Federal holidays
are left out on purpose, since the API's town calendar already computes them from their legal rules.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Restaurant:
    name: str
    address: str
    town: str
    description: str


@dataclass(frozen=True)
class Beat:
    key: str
    title: str
    focus: str
    seeds: tuple[str, ...] = field(default_factory=tuple)


SAWTOOTH = Restaurant(
    name="Sawtooth Kitchen",
    address="Allen Street, Hanover, NH 03755",
    town="Hanover, NH",
    description=(
        "A sit-down restaurant and bar a block off Main Street, a short walk from the Dartmouth Green. "
        "Services: lunch, dinner, late night and weekend brunch. It also sells event tickets and takes event deposits. "
        "Guests are a mix of Dartmouth students, visiting families and alumni, and Upper Valley locals."
    ),
)

HANOVER_BEATS: tuple[Beat, ...] = (
    Beat(
        "dartmouth_academic", "Dartmouth academic calendar and big weekends",
        "Term starts and ends, finals, breaks and interims, orientation, move-in and move-out, Family Weekend, "
        "Homecoming, Winter Carnival, Green Key, Commencement, reunions, admitted-student days. These decide how many "
        "students are in town, so note breaks (demand down) as well as big weekends (demand up).",
        ("https://registrar.dartmouth.edu/calendars", "https://home.dartmouth.edu/events"),
    ),
    Beat(
        "dartmouth_athletics", "Dartmouth home athletics",
        "Home games and meets that draw crowds: football at Memorial Field, men's and women's hockey at Thompson Arena, "
        "basketball at Leede Arena, plus tournaments and big rivalry games. Away games don't count. Give the start time.",
        ("https://dartmouthsports.com/calendar",),
    ),
    Beat(
        "arts_culture", "Arts and culture",
        "Performances and exhibitions that bring audiences downtown before or after a show: Hopkins Center for the Arts, "
        "Hood Museum of Art, Dartmouth film and music series, author talks, Northern Stage in White River Junction, "
        "Lebanon Opera House. Prefer evening shows, which create pre-theater dinner demand.",
        ("https://hop.dartmouth.edu/events", "https://hoodmuseum.dartmouth.edu/events", "https://northernstage.org",
         "https://lebanonoperahouse.org"),
    ),
    Beat(
        "town_community", "Hanover town and community events",
        "Main Street and town events: festivals, street fairs, farmers markets, parades, holiday tree lighting, "
        "races (e.g. road races that close streets), town meetings, Hanover Area Chamber events, Storrs Pond, "
        "Hanover Improvement Society, library and church events with big draws.",
        ("https://www.hanovernh.org", "https://www.hanoverchamber.org/events"),
    ),
    Beat(
        "upper_valley", "Upper Valley regional events",
        "Events within about 30 minutes that pull people through or away from Hanover: Lebanon and West Lebanon, "
        "Norwich and White River Junction (VT), Woodstock (VT), Enfield, Grantham, ski area openings and events at "
        "Dartmouth Skiway, Whaleback and Suicide Six, regional fairs and festivals.",
        ("https://www.uppervalleychamber.org", "https://www.woodstockvt.com/events"),
    ),
    Beat(
        "visitors_conferences", "Visitors, conferences and reunions",
        "Things that fill hotel rooms and bring adults who eat out: conferences and executive programs at Tuck and "
        "Geisel, Dartmouth Health events, alumni reunions and class gatherings, admissions open houses, weddings season "
        "at the Hanover Inn, large youth sports tournaments.",
        ("https://www.tuck.dartmouth.edu/news/events", "https://alumni.dartmouth.edu/events"),
    ),
    Beat(
        "school_breaks_disruptions", "Local school breaks and disruptions",
        "Hanover and Dresden school district vacations (local families travel away), and anything that keeps people out "
        "of downtown: Main Street or Allen Street construction and closures, parking changes, bus (Advance Transit, "
        "Dartmouth Coach) service changes, planned utility work. Mark these demand_effect 'decrease' where they do.",
        ("https://www.sau70.org", "https://www.hanovernh.org/public-works"),
    ),
)
