## ADDED Requirements

### Requirement: Each reason has a signed size
From today on, the client SHALL give each of a forecast day's reasons a signed size in percent (`reasonSize` in `client/src/portal/calendar/model.ts`, pure). A run reason with an effect SHALL be +pct for more, -pct for fewer and 0 for about the same. A note's or business rule's reason SHALL be: `added`, +100 times its guests divided by the model's middle figure for the day, rounded to the nearest 5, or +100 when the model has no middle figure; `closed`, -100; `booked`, +100 times (the party's guests divided by the model's middle, less 1), rounded to the nearest 5, or 0 without a party or a middle; any other outcome, 0. As a run effect of 5% or less is about the same, a note's or rule's rounded size of 5 or less either way SHALL be 0, so every size other than 0 is at least 10 either way. A run reason with no effect, and every reason on a day before today, SHALL have no size.

#### Scenario: Run reasons
- **WHEN** a day's weekday effect is 35% more and its holiday effect 70% fewer
- **THEN** their sizes are +35 and -70

#### Scenario: A note that adds guests
- **WHEN** a private-event note adds 70 guests on a day whose model middle figure is 200
- **THEN** its size is +35

#### Scenario: A closure and a buyout
- **WHEN** one day's reason is a closure note and another's is a buyout with a 70-guest party on a model middle of 200
- **THEN** their sizes are -100 and -65

#### Scenario: A note that changed nothing
- **WHEN** a note's outcome is `no_guest_count`
- **THEN** its size is 0

#### Scenario: A small note
- **WHEN** a private-event note adds 10 guests on a day whose model middle figure is 200
- **THEN** its size is 0 (5 or less), not +5

### Requirement: Marks are colored by the size of the effect
A reason whose size is above 0 SHALL carry ▲ and one below 0 ▼, a run reason about the same SHALL carry =, and a reason at 0 that is not a run reason, or with no size, SHALL carry no mark; notes and rules SHALL carry ▲ or ▼ by their size. A mark's color SHALL be graded by its size's magnitude: 10 to 15 step 1, 20 to 35 step 2, 40 and over step 3, `effectUp1` to `effectUp3` for ▲ and `effectDown1` to `effectDown3` for ▼; = SHALL be `text2`. Within each ramp the steps SHALL share about one hue, and each step SHALL be greener or redder than the last in HSL saturation and in channel dominance (green less the larger of red and blue for ▲, red less the larger of green and blue for ▼), step 1 included, so it reads as green or red and not as the gray of =. Each of the six tokens SHALL have a dark and a light value with at least 4.5:1 contrast on `ground`, `panel` and `raised` in its palette, and SHALL be declared in `client/src/theme.ts` and in `client/public/index.html` for both palettes. The six SHALL be their own set of tokens: the `error` token SHALL stay unadopted (spec 15.7). Only the mark SHALL be colored. The mark SHALL stay hidden from screen readers, so a reason's words SHALL say what its mark shows: a run reason's effect words, "Adds {n} guests", "Closes the day", and for a buyout with a size other than 0 "Books the day: about {n}% fewer guests than Townwise’s model" (or "more"), "Books the day" at 0; color is never the only sign.

#### Scenario: Grades
- **WHEN** a day's reasons have sizes +10, +35, +40, -15 and -70
- **THEN** their marks are ▲ in `effectUp1`, ▲ in `effectUp2`, ▲ in `effectUp3`, ▼ in `effectDown1` and ▼ in `effectDown3`

#### Scenario: About the same
- **WHEN** a run reason is about the same
- **THEN** its mark is = in `text2`

#### Scenario: A note's mark
- **WHEN** a note adds 70 guests on a model middle of 200
- **THEN** its row shows ▲ in `effectUp2` before "Adds 70 guests"

#### Scenario: A small note has no mark
- **WHEN** a note adds 10 guests on a model middle of 200
- **THEN** its row shows no mark before "Adds 10 guests"

#### Scenario: A buyout's words say its direction
- **WHEN** a buyout books the day for a party of 70 on a model middle of 200
- **THEN** its row shows ▼ in `effectDown3` before "Books the day: about 65% fewer guests than Townwise’s model"

#### Scenario: A screen reader
- **WHEN** a screen reader reaches a Why row with a colored ▼
- **THEN** it hears the reason's label and words, which say fewer guests, and not the mark

#### Scenario: Contrast and steps
- **WHEN** the palette test checks the six tokens in both palettes
- **THEN** each has at least 4.5:1 contrast on `ground`, `panel` and `raised`, and each ramp's saturation and channel dominance rise from step 1 to step 3

### Requirement: Why runs from most positive to most negative
The Calendar's Why SHALL list the reasons with a size above 0, largest first; then those at 0 or with no size, the run's about-the-same reasons first, then the notes' and rules' reasons at 0, then the run's reasons with no effect, each group in the read's order; then those below 0, the smallest fall first and the largest last. At an equal size above or below 0, notes and rules SHALL come before the run's reasons, then the read's order; at 0 the three groups above SHALL decide the order. On a day before today the reasons SHALL keep the read's order. "+{n} more of your notes" and "+{n} more of your rules" SHALL stay after the list.

#### Scenario: A mixed day
- **WHEN** a day has a note adding 70 guests on a model middle of 200 (+35), a weekday effect of 35% more, an event effect of 20% more, a term effect of 10% fewer, a holiday effect of 70% fewer and a recent-level reason with no effect
- **THEN** Why lists the note, the weekday, the event, the recent level, the term, then the holiday

#### Scenario: A closure goes last
- **WHEN** a day's reasons are a closure note and a weekday effect of 20% more
- **THEN** the weekday comes first and the closure last

#### Scenario: Reasons at 0
- **WHEN** a day's reasons, in the read's order, are a note whose outcome is `no_guest_count` and a weekday effect about the same
- **THEN** Why lists the weekday, then the note

#### Scenario: A past day
- **WHEN** the selected day is before today
- **THEN** its reasons show in the read's order with no marks

### Requirement: The short lists keep the largest effects
The Calendar's tooltip and Home's day detail SHALL each show three of a day's reasons: the three with the largest size magnitude, either way (ties, and reasons with no size, in Why's order), shown in Why's order. Home's day detail rows for run reasons SHALL carry the same colored mark before their short line ("▲ Saturday: usually more guests"), hidden from screen readers, since those words say the direction; a note's or rule's row there, whose short line is its label alone, SHALL carry no mark. The tooltip SHALL keep its words only.

#### Scenario: A large fall is kept
- **WHEN** a day has rises of 10%, 15% and 20% and a holiday fall of 70%
- **THEN** Home's day detail shows the 20% rise, the 15% rise and the holiday, in that order, and the 10% rise is left out

#### Scenario: Home's marks
- **WHEN** Home's day detail shows "Thanksgiving Day: fewer guests last time" with a size of -70
- **THEN** a ▼ in `effectDown3` comes before it and a screen reader hears only the words

#### Scenario: A note on Home
- **WHEN** Home's day detail shows a private-event note that adds 70 guests on a model middle of 200
- **THEN** its row shows the note's label with no mark

### Requirement: The average day carries its number
Where a reason's words compare with "your average day", the client SHALL add the average open day's guests in parentheses after it, from the effect's `averageGuests`, formatted as a count: "Usually about 35% fewer guests than your average day (210)", "Usually about as many guests as your average day (1,210)". When `averageGuests` is null or missing, the words SHALL have no parentheses. The other comparisons and the short lines SHALL carry no number.

#### Scenario: A weekday that runs low
- **WHEN** a Tuesday's effect is 35% fewer from history with `averageGuests` 210
- **THEN** its Why line reads "Usually about 35% fewer guests than your average day (210)"

#### Scenario: About the same
- **WHEN** a weekday's effect is about the same with `averageGuests` 1210
- **THEN** its line reads "Usually about as many guests as your average day (1,210)"

#### Scenario: An older API
- **WHEN** the effect has no `averageGuests`
- **THEN** the line reads "Usually about 35% fewer guests than your average day" and the page parses the read as before

#### Scenario: Another comparison
- **WHEN** a term effect is 10% fewer
- **THEN** its line reads "Usually about 10% fewer guests than the same weekday at other times of the year", with no number

### Requirement: The forecast read carries the average day's guests
A run reason's `effect` in the forecast read (`api/src/forecasts/effects.ts`) SHALL carry `averageGuests`: on a weekday's history effect, the mean guests of the open days of the 52 weeks it compares against, rounded to the nearest guest; null on the model's effects and on every other kind. It SHALL be computed on read with the rest of the effect, stored nowhere and logged nowhere. TownwiseAI's `get_forecast` SHALL return it in each reason's `effect`, and its description SHALL say what it is.

#### Scenario: A weekday effect
- **WHEN** a location's open days over the last 52 weeks average 209.6 guests and its Tuesdays run 35% below them
- **THEN** a Tuesday's weekday reason has `effect` `{ direction: 'fewer', pct: 35, basis: 'history', days, averageGuests: 210 }`

#### Scenario: Other effects
- **WHEN** a reason is a term, holiday or event effect, or the run recorded its own effect
- **THEN** its `averageGuests` is null

#### Scenario: TownwiseAI
- **WHEN** TownwiseAI calls `get_forecast` over that Tuesday
- **THEN** the reason's `effect` carries `averageGuests: 210` and nothing about it is logged
