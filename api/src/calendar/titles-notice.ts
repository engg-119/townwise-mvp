// The weekly notice's version (openspec change calendar-event-suggestions, design decision 11): the number an add of a
// file or link, or a Google connect, sends when its screen said "Once a week TownwiseAI reads the titles, ...". It is
// stored on the calendar row (stores/owner-calendars.ts) or the connection (stores/google-connections.ts), and the
// weekly call sends a calendar's titles only with it. The client sends the same number (client/src/portal/calendar/calendars.ts).
export const WEEKLY_TITLES_NOTICE = 1;
