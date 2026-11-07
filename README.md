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