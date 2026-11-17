Lands after `autonomous-forecasts` phase 3b. Tests first.

## 1. Switch and store

- [ ] 1.1 `tw_orgs.weeklySuggestions`, `PATCH /api/org/weekly-suggestions` in `TOWNWISE_ROUTES` (`org_admin`, 2 KB, `writes`), audit `org.weekly_suggestions_changed`. Tests: `api/test/weekly-suggestions.int.test.ts` (admin 200 for off and on, member 403, view-as refused; an organization with no field reads as on).
- [ ] 1.2 `api/src/stores/agent-suggestions.ts` (`tw_agent_suggestions`), deletion with the location and the organization; accept and dismiss routes (org admin), accept writing the note or rule with the suggestion's id, and expiry by first date. Tests: same file (one write on a retried accept; dismiss; an expired suggestion not listed; another organization's id is 404).

## 2. The pass

- [ ] 2.1 `api/src/lab/suggestions.ts`: the request (calendar, notes, rules, history effects), the structured answer, the note and rule checks, at most 5, the $0.30 reservation and its correction, `TOWNWISE_WEEKLY_SUGGESTIONS`. Tests first: `api/test/weekly-suggestions.test.ts` with a fake model (sentinel emails and names absent from the request; an invalid suggestion dropped; the budget skip).
- [ ] 2.2 Hook the pass into `api/src/lab/schedule.ts` after each worker pass's calibrations, recorded on the week row; add the `anthropic-api-key` Key Vault reference to `caj-townwise-forecasts` in `infra/terraform/production/jobs.tf` with its `terraform test`. Test: `api/test/weekly-refresh.int.test.ts` (one pass a week by default; none when an org admin turned it off; none with the switch off).

## 3. Client and docs

- [ ] 3.1 `GET .../agent` lists open suggestions, and Home's question count includes them. P25's Questions panel shows suggestions with Accept and Dismiss for org admins, and the switch with its words. Tests: `client/test/portal/chat/questions.test.web.tsx` and `.test.native.tsx`, plus Home's count test.
- [ ] 3.2 `docs/portal/spec.md` (D42's suggestions part, P25, 6.x, 10.12), `docs/portal/tuning-chat.md` (the pass's prompt and what it sends), `api/README.md`, `api/production.env` (`TOWNWISE_WEEKLY_SUGGESTIONS=true`, explicit), `api/.env.example` (true).
- [ ] 3.3 Draft the suggestions sentence of the privacy paragraph in `client/app/(marketing)/privacy.tsx` (with "Last updated" bumped and a test) and in `docs/portal/estimates.md` section 5, for the owner's approval before push.

## 4. Owner, review and verification

- [ ] 4.1 Owner: approve the privacy sentence, and decide both `[CONFIRM]` markers.
- [ ] 4.2 Independent UI review of the Questions panel (web and native).
- [ ] 4.3 An end-to-end test with the worker and a fake model (one pass makes suggestions for an organization with no field), then `/review`, then `/verify`. Push only after the owner's go.
