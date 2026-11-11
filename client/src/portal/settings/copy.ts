// Settings copy (spec P18, the OrgSettings board) and the id of the page's one read-only line, which every
// disabled control on the page points to under view-as.

export const SETTINGS_READ_ONLY_ID = 'settings-ro';

export const SETTINGS_COPY = {
  loading: 'Loading your settings',
  saved: 'Saved.',
  twoStep: 'Recommended for admins.',
  nameHelper: 'Your team sees this name at the top of every page. Townwise staff see it in the staff console.',
  nameLength: 'Use 2 to 120 characters.',
  // D25: before anyone joined, staff may have opened the organization as its admin, so “Without View as” would be false.
  staffIntro: 'Each time Townwise staff use View as to see your sales and notes, it’s recorded here with its reason. Before '
    + 'anyone from your organization joined, staff setting it up may have opened it as its admin, which shows them what an '
    + 'admin sees; each time is listed here, with every change they made. Otherwise staff can see your team’s email '
    + 'addresses, your location names and towns, and which dates your data covers. Any change staff make to your team, '
    + 'name or status is listed here too.',
  staffEmpty: 'Townwise staff haven’t viewed or changed your organization.',
  showOlder: 'Show older staff activity',
  loadingOlder: 'Loading…',
  notApplied: 'Didn’t take effect.',
} as const;

export function leaveBody(org: string): string {
  return `You lose access right away. Your notes and uploads stay with ${org}.`;
}

export function everywhereHelp(email: string): string {
  return `Sign out on every device ends every Townwise sign-in for ${email} right away, this one included.`;
}
