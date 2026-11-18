## ADDED Requirements

### Requirement: An active day is recorded for a member's own use
When a request to `/api` passes its route's policy and its principal is a member or org admin on their own seat in an active organization (not staff, not view-as, not staff opened as an organization's admin), the API SHALL record that the person was active in that organization on the current UTC day. The record SHALL be written from the route chain after the policy, never inside `resolveAccess`. A person SHALL have at most one record per organization per UTC day. Each replica SHALL write a person's day at most once while its write succeeds, so a person costs at most one write per replica per day. The write SHALL never delay the request and its failure SHALL never change the response; a failure SHALL be logged with the organization id and an error code only.

#### Scenario: Opening the app counts
- **WHEN** an owner opens the app, which reads `GET /api/me`, reads Home and leaves without changing anything
- **THEN** one record exists for that owner, their organization and today's UTC date

#### Scenario: Many requests in a day
- **WHEN** the same member makes 200 requests on one day across two API replicas
- **THEN** exactly one record exists for that member, organization and day, and at most two writes were made

#### Scenario: Staff and view-as are not recorded
- **WHEN** a staff member uses the console, views the app as a member, or opens an organization as its admin
- **THEN** no record is written for the staff member or for the member being viewed

#### Scenario: A refused request is not recorded
- **WHEN** a person whose organization is suspended, or who has no seat, makes a request
- **THEN** no record is written

#### Scenario: The database write fails
- **WHEN** the record's write fails
- **THEN** the request answers exactly as it would have, and the next request from that person that day tries the write again

### Requirement: An active day holds a person, an organization and a date only
A record in `tw_activity_days` SHALL hold the person's user id, the organization id and the UTC date, and SHALL NOT hold a time, a path, a route, a page, an IP address, a device, a count or anything the person sent. Its identifier SHALL be built from those three values, so it carries no time either. Nothing about the record SHALL be logged but counts and the organization id.

#### Scenario: What a record holds
- **WHEN** a record is read from the database
- **THEN** it has exactly an identifier made of the organization id, the user id and the date, the organization id, the user id and the date

### Requirement: Active days are kept 180 days and deleted with their person or organization
Records SHALL be kept for 180 days (the current UTC day and the 179 before it), and records dated earlier SHALL be deleted, without depending on stored files or the weekly worker being on. Deleting an organization SHALL delete its records. Deleting a person SHALL delete their records in every organization. Removing a person from an organization SHALL NOT delete their records there; they age out. The privacy page SHALL say that Townwise keeps the dates on which each signed-in person used the app, for 180 days, and that deleting an account deletes them.

#### Scenario: Old days go
- **WHEN** the first record of a new UTC day is written on a replica
- **THEN** every record dated more than 179 days before today is deleted, and a record dated 179 days ago stays

#### Scenario: A member is removed
- **WHEN** an org admin removes a member who had records in the organization
- **THEN** those records stay until they are older than 180 days

#### Scenario: A person is deleted
- **WHEN** staff delete a person who had records in two organizations
- **THEN** none of their records remain in either

#### Scenario: An organization is deleted
- **WHEN** staff delete a suspended organization
- **THEN** none of its records remain
