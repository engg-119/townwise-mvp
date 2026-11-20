# open-as-admin Specification

## Purpose
TBD - created by archiving change open-as-admin-after-join. Update Purpose after archive.
## Requirements
### Requirement: Staff open an active organization as its admin, joined or not
The system SHALL let Townwise staff start open as admin on any active organization, whether or not anyone has joined it, and SHALL answer 409 `org_suspended` for a suspended one, writing nothing.

#### Scenario: An organization someone joined
- **WHEN** staff start open as admin on an active organization whose invited admin has joined
- **THEN** the system answers 201 with that organization's admin access and `openAsAdmin` set, and records `open_as_admin.started`

#### Scenario: A suspended organization
- **WHEN** staff start open as admin on a suspended organization
- **THEN** the system answers 409 `org_suspended` and writes nothing

### Requirement: Staff give a reason once anyone has joined
The start SHALL require `{ reason }`, 5 to 200 characters after trimming and validated as view-as's reason, once anyone has ever joined the organization by staff setup's notion (its `firstJoinedAt`, or, for an organization from before that field, a member row that joined); an open invitation SHALL NOT count. Without one it SHALL answer 400 `reason_required`, and with one outside that length 400 `invalid_request`, writing nothing. The reason SHALL be stored on the grant and in `open_as_admin.started`, and the organization's staff activity SHALL show it. An organization nobody has joined SHALL need no reason.

#### Scenario: Joined, no reason
- **WHEN** staff start open as admin with no body on an organization whose admin has joined
- **THEN** the system answers 400 `reason_required` and writes nothing

#### Scenario: Joined, with a reason
- **WHEN** staff start it with the reason "Fixing their location settings"
- **THEN** the grant and `open_as_admin.started` carry that reason, and the admin's staff activity row shows it

#### Scenario: Everyone who joined has left
- **WHEN** the organization has a `firstJoinedAt` but no member now
- **THEN** a start without a reason answers 400 `reason_required`

#### Scenario: Only an invitation
- **WHEN** the organization has only its admin's open invitation
- **THEN** a start with no body answers 201 and the grant carries no reason

### Requirement: A join does not end a live grant
An open-as-admin grant SHALL stay live through a join. It SHALL stop being live at End, sign-out, the end of the staff window, or a suspension, and a suspension SHALL end it for good, even after a reactivation.

#### Scenario: Someone joins while staff are inside
- **WHEN** the organization's invited admin joins while a staff member has it open as its admin
- **THEN** the staff member's next request still runs as that organization's org admin, scoped to the grant's organization

#### Scenario: Suspended after the join
- **WHEN** the organization is suspended after someone joined, while the grant is live
- **THEN** the next request resolves the staff member as plain staff

### Requirement: People stay closed and staff changes stay visible
While open as admin, people, seats and requests SHALL answer 403 `open_as_admin_refused`, before and after a join. Every change made inside SHALL be recorded with actor role `superadmin`, the staff email and the grant id, and the organization's admins SHALL see it in their Townwise staff activity while staff are still inside.

#### Scenario: Team after a join
- **WHEN** staff open as admin list, add, change or remove members, or leave, after someone joined
- **THEN** each answers 403 `open_as_admin_refused` and no member row changes

#### Scenario: The admin reads staff activity
- **WHEN** staff add a location and a note inside an organization whose admin has joined
- **THEN** that admin's staff activity lists the start and each change, and the note's author reads "Townwise staff"

