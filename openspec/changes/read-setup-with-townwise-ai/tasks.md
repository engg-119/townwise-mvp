## 1. Spike

- [x] 1.1 Measure latency and output tokens on a 150-row synthetic order guide, a 20-page synthetic PDF and a synthetic photo, at low and medium effort, against the real API
- [x] 1.2 Set the effort, `max_tokens`, the item cap and the 150-second limit from the results, and update design Decision 8 and the `[CONFIRM]` markers

## 2. API: the reader

- [x] 2.1 Move the reader's input preparation from `files/ai-reader.ts` to `files/extract/input.ts`, taking bytes; `ai-read.int.test.ts` stays green
- [x] 2.2 `files/extract/setup-prompt.ts`: the prompt, the structured-output schema (no par, no never run out), the server's check of the answer (caps, dedupe, redaction, `inFile`)
- [x] 2.3 `files/extract/setup-reader.ts`: the request (content plus the saved setup's supplier and item names only) and the cost ceiling
- [x] 2.4 The model factory in `files/extract/model.ts`; wire `setupReader` through `main.ts` and `app.ts`

## 3. API: the route

- [x] 3.1 Allow an `'8mb'` body on this route only and pin it in `assertRouteTable` and `routes.test.ts`
- [x] 3.2 The `org.orders.setup.read` entry in `TOWNWISE_ROUTES` (member, open as admin, `ai_reads`)
- [x] 3.3 The handler: on, budget, byte gate, input, reserve, one call, correct, check, answer; every error code of the spec
- [x] 3.4 The `order.setup_read` audit allowlist and the two counts-only log lines
- [x] 3.5 `canReadWithAi` on `GET .../orders/setup`

## 4. API: tests

- [x] 4.1 Unit: the prompt and schema (no par or never-run-out keys), the answer's check, the request holds no point-of-sale, organization, location or file name, a picture's metadata is gone, a cut is said
- [x] 4.2 Integration (`test/setup-read.int.test.ts`, fake model): each input kind; off, spent, reserved, corrected, a failure charges 0, a refusal is charged; view-as 403; staff open as admin audited; cross-tenant 404; the 400 caps; `extract_busy`; nothing stored and the setup version unchanged; logs and audit carry no name sentinel
- [x] 4.3 Update the `isolation.test.ts` lists the move touches

## 5. Client

- [x] 5.1 Split `template.ts` into `readRow` and a shared `mergeRows`; add `importProposal`; widen the kept fields; the existing import tests stay green
- [ ] 5.2 `api.ts`: `readSetupWithAi` with its schema and a 170-second timeout; `canReadWithAi` on the setup
- [ ] 5.3 `SetupRead.web.tsx`: drop, choose or paste; Read; loading with Cancel; the summary; each error; disabled under view-as; files over the caps refused in the browser; the file name never sent
- [ ] 5.4 Field marks in `SetupEditor.tsx` and `SetupRows.tsx` (estimated servings, not in the file), cleared on edit or Save
- [ ] 5.5 The native line on Ordering setup
- [ ] 5.6 Tests: `template.test.ts`, `setupRead.test.web.tsx`, `setup.test.native.tsx`, the privacy page test

## 6. Privacy and console

- [ ] 6.1 The privacy page's "Files and text you give TownwiseAI for ordering" and the Anthropic paragraph's sentence
- [ ] 6.2 A staff console label for `order.setup_read`

## 7. Docs

- [ ] 7.1 `docs/portal/spec.md`: D41 in 22, the privacy rule's second exception, 10.17's route row and audit action, P31's bullet, 11A.9's shared budget, the changelog
- [ ] 7.2 `api/README.md`: Ordering, the Orders table, the `ai-reads` row, audit and logs, the budget's description
- [ ] 7.3 `client/MODULE.md`: the Ordering setup entry

## 8. Review and ship

- [ ] 8.1 Security review: prompt injection, names in logs and audit, cross-tenant 404, the body limit
- [ ] 8.2 Correctness review: budget accounting and every error path
- [ ] 8.3 `npm run verify`, a browser check on synthetic files with `/browse`, then a PR to `develop` merged on all-green checks
