# MOSU stage 2: visual workflow demonstrator

A small local page that runs the **unchanged stage-1 `workflow.mjs`** against the kit's mock services. It shows the workflow graph, the state, and an event trace for each event.

## Run it (Node 20+, nothing to install)

```sh
node serve.mjs
```

Open **http://localhost:8080/** in your browser and stop the server with Ctrl+C. A small server is needed because browsers block ES-module imports from `file://` pages.

The stage-1 checks still run here too: `node run.mjs` gives 6/6, and `node extra-checks.mjs` passes.

## Files

| File | Role |
|---|---|
| `workflow.mjs`, `contract.mjs`, `mock-tools.mjs` | Stage-1 workflow and the kit's contract and mocks, **unchanged** |
| `index.html`, `web/app.js` | UI: scenarios, controls, diagram, state panel, trace |
| `web/crypto-shim.mjs` | Browser SHA-256 for the single `node:crypto` call in `contract.mjs`, applied through an import map. Action IDs match Node's exactly (`action-29137615fc4816ccefba3746`). |
| `serve.mjs` | Static server built on the standard library only |
| `run.mjs`, `cases.mjs`, `observations.mjs`, `smoke.mjs`, `extra-checks.mjs` | Stage-1 checks |

## Using it

- **Scenario A** (normal execution) has four steps: load v4 (waist missing, hip in inches) → try to send without approval (blocked, 0 provider calls) → **Approve** (a separate control) → send (receipt).
- **Scenario B** (delivered, then timeout) goes load → approve → send → **paused at `unknown`** → retry if you choose → `sent`. It makes 2 requests but only **1 delivery**.
- **Scenario B2** is the limit check: both attempts time out, a third send makes no call, and the outcome is `needs_reconciliation`.
- **Next step** only runs non-decision steps. At an approval or retry point you have to press the highlighted control yourself. The workflow buttons work in any order, and each one sends exactly one real event to `handle()`.
- **Changed conditions** buttons exist for the discussion: a corrected profile (new version), and a protocol revision followed by a reload.

**Implemented vs simulated:**
- **Executed:** loading the profile, validation, drafting, approval, sending, the retry and the limit.
- **Simulated:** the drafting tool is a deterministic mock labelled "simulated AI", and the notification provider is a mock.
- **Conceptual only (dashed boxes):** protocol definition, waiting for a corrected version, designer review, and production handoff. They are not implemented.

**What the app knows vs the provider:**
- The **Notification counts** panel shows only what the app learned from `notify()` responses.
- The yellow **Provider-internal debug** panel reads the mock's own records (actual deliveries). It exists for comparison only. The workflow never reads it.

## How the concepts map to the code

**Graph and states.**
- The workflow is a small state machine inside `handle()`. Its states are: awaiting approval → approved → send → sent / unknown → needs reconciliation. A profile with no issues becomes ready for designer review instead.
- The diagram's active stage comes from `activeStage(state)`, a pure function of the persisted state. The diagram, state panel and trace therefore all render from the same executed events.
- Transitions are allowed or blocked by guards in `handle()`, not by the UI:
  - Approval must match `pendingAction.id`.
  - SEND requires approval, `status !== 'sent'` and `attempts < 2`.
- The Send button stays enabled on purpose, so you can see that the workflow itself blocks it.

**Loops.**
- The only executed loop is unknown → send. It is allowed because the outcome is genuinely uncertain and a retry with the same key is deduplicated by the provider.
- It stops on a receipt, or when `delivery.attempts` reaches `MAX_ATTEMPTS` (2), which is stored in state.
- The limit counts **actual `notify()` calls**: the first call plus one permitted retry. A call that ends in a timeout still counts. A SEND blocked before `notify()` (not approved, no action, already sent) consumes no attempt.
- The original approval stays valid for a retry of the same unchanged action. Reloading an identical profile produces the same action ID, so the approval and the attempt count are both kept. Re-approving the same action never resets the attempt budget (checked in `extra-checks.mjs`).
- When the limit is reached with the outcome still unknown, the demo stops at `needs_reconciliation`. *Proposed extension (not built; the kit's contract has no such API):* a read-only delivery-status lookup by idempotency key. It would not count as a send attempt and could resolve `unknown` without calling `notify()` again.
- The outer loop (clarification → corrected version → validate again) is conceptual. A correction arrives as a new version.

**Harness and permissions.**
- `app.js` controls execution: one event at a time, with JSON round-trips between events, the same as the stage-1 runner.
- The workflow can only reach the three tools it is given. A wrapper records every call's arguments, its result or error, and the resulting state change.
- Permission checks and the attempt limit live in `workflow.mjs`. The only trusted approval input is the `APPROVE_ACTION` event. The protocol note is never interpreted.

**State, context and memory.**
- **Authoritative facts:** the immutable profile snapshot, the protocol's structured fields, the approval event, and the provider receipt.
- **AI context:** the drafting component receives only the profile ID, the version and the validated issue codes. It does not receive the free-text note as an instruction.
- **Worth retaining in production:** a version history, a per-action ledger (approval, attempts, receipts), and reconciliation results. A chat log is not reliable memory.

**AI and tool boundaries.**
- **Where AI could help:** wording the clarification, summarising a profile for the designer, or suggesting capture instructions.
- **What stays deterministic:** validation, action identity, approval checks, retry limits and delivery state.
- **Where an MCP/tool adapter would fit:** `readProtocol` and `notify` could be exposed as MCP tools with schemas. The harness would still check approval before any `notify` call, and the server must honour idempotency keys.

**If the profile or protocol changes after approval but before sending**, here is what the demo enforces and what production would add:
- **Enforced in the demo:** a new profile version, or anything that changes the issues, recipient or text, creates a new action ID. The old approval doesn't match, so sending is blocked until a human approves again, and attempts restart at 0. The "corrected profile" button shows this.
- **Not enforced (a gap the demo shows):** a protocol *revision* that leaves the fields and unit unchanged keeps the same action ID, so the approval survives. The "protocol revision" button shows this.
- **In production:**
  - Include `protocolRevision` in `makeActionId` (the helper already supports it).
  - Just before `notify`, re-read the latest profile version and protocol revision and refuse to send if they changed.
  - Keep superseded actions whose delivery is `unknown` in a ledger, so they can still be reconciled.

## Verification

- `node extra-checks.mjs` includes a check that blocked sends use no attempt, and that re-approval or a reload does not reset the budget: two calls in total, never a third.
- A Playwright script (kept outside the project) drove A, B, B2 and both changed conditions in Chromium. It compared the UI state against the mock's own call and delivery records, and all 14 checks passed:
  - A: blocked send = 0 provider calls; approved send = 1 request, 1 delivery, `receipt-1`.
  - B: 2 requests, 1 delivery, the same key, the original receipt.
  - B2: 2 requests maximum, `needs_reconciliation`.
  - No console errors.
- The SHA-256 shim matched `node:crypto` on 8 inputs, including UTF-8 text and padding boundaries.
- Stage-1 `node run.mjs` gives 6/6 and `node extra-checks.mjs` passes in this folder.

## Handoff note

- **Total time spent:** approx. 80 min of active stage-2 work (split across sessions, as allowed): ~15 min reading the brief and clarifications, ~35 min setup, running and checking the scenarios, ~20 min recording, ~10 min notes. Breaks and waiting for clarification are not counted.
- **Trade-off:** I reused `handle()` unchanged and wrapped the tools, instead of rewriting the workflow for the UI. Every on-screen state is real executed state, but the UI can only show what `handle()` already records. For example, there is no history of superseded actions.
- **Remaining limitations:**
  - There is no per-action ledger.
  - The protocol revision is not part of the action identity.
  - There is no send-time precondition check.
  - Review and handoff are conceptual only.
  - There is no automated UI test inside the repository; the Playwright script was run separately.
  - The layout targets a desktop browser.
- **AI tools used:** Claude (a coding agent) wrote the UI, the server, the shim and this README from my brief and stage-1 code. I personally verified, by running it on my own machine (Windows, VS Code, Node 24): `node run.mjs` gives 6/6 and `node extra-checks.mjs` passes. In scenario A, the send with approval withheld showed "no tool calls". In scenario B, the trace showed 2 `notify` calls with the same idempotency key, while the provider panel showed only 1 delivery and the state ended `sent` with `receipt-1`.
