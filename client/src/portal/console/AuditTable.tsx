import type { Column } from '../ui/DataTable';
import { DataTable } from '../ui/DataTable';
import { CellLines } from './parts';
import type { AuditEvent } from './schemas';
import { actorLine, auditDetails, whenLabel } from './words';

// Audit events as the console shows them (spec 16.4 P21, P23): When, Who (email, role, and “viewing as” for
// view-as), Action (the server's plain-words summary, which already says “Didn’t take effect” where a
// staff_action.not_applied event qualifies it), then Organization and Details on the audit log. A deleted
// organization has no name left, so its events read “deleted organization”.

export function orgLabel(event: Pick<AuditEvent, 'orgId' | 'orgName'>): string {
  if (event.orgName !== null) return event.orgName;
  return event.orgId === null ? 'None' : 'deleted organization';
}

export function AuditTable(props: {
  label: string;
  events: readonly AuditEvent[];
  /** The Organization column; the audit log leaves it out when filtered to one. */
  org?: boolean;
  details?: boolean;
}): React.JSX.Element {
  const columns: Column[] = [
    { key: 'when', label: 'When' },
    { key: 'who', label: 'Who', flex: 1.4 },
    { key: 'action', label: 'Action', flex: 1.8 },
    ...(props.org === true ? [{ key: 'org', label: 'Organization', flex: 1.2 }] : []),
    ...(props.details === true ? [{ key: 'details', label: 'Details', flex: 1.6 }] : []),
  ];
  return (
    <DataTable
      label={props.label}
      columns={columns}
      rows={props.events.map((event) => ({
        key: event.id,
        cells: {
          when: whenLabel(event.at),
          who: <CellLines main={event.actorEmail} note={actorLine(event)} white />,
          action: event.summary,
          org: orgLabel(event),
          details: auditDetails(event),
        },
      }))}
    />
  );
}
