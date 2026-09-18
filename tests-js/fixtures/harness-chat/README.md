# Native paper-conversation fixture

This fixture registers one deterministic, keyless model in an isolated Harness
profile. It produces an ordinary assistant message through the native agent
loop. The adapter has no network, credential or tool-call implementation.
An authenticated, test-only route returns session/agent presence booleans, the
adapter generation count, the board references the model received (board id,
snapshot id, body hash and text) and the tool names the host offered, making
cold-session, retry and tool-exposure checks observable. Recording an offered
tool name is not a tool call.

From the plugin repository, install the isolated profile once, then run the
smoke against a built Harness checkout:

```sh
node scripts/install-harness.mjs --home "$PWD/.local/paper-chat-test-home" --profile paper-chat-test
node tests-js/paper-chat-harness-smoke.mjs
```

`DSH_CHECKOUT` can select a different built checkout. `DSH_TEST_HOME` must stay
inside this repository's ignored `.local` directory; `DSH_TEST_PROFILE` can
select another isolated profile. No user profile is modified by the smoke.
Each run creates fresh synthetic PDFs and a managed library under its own
`runs/` subdirectory, then stops only the host it started. Source documents,
host logs, cookies, session IDs and absolute paths stay out of the public
receipt at `docs/validation/paper-chat-harness.json`.

The current run has 13 checks and two deterministic generations, with zero
external model requests. It covers one-paper Session reuse, distinct papers,
cold creation and native prompt adoption, real annotation pages, assistant
history, idempotent retries and PDF reply provenance. Reference-specific
checks prepare a snapshot without marking it sent, edit the PDF afterward,
and confirm that the native model still receives the frozen original source.
The native logged projection then distinguishes the edited annotation's new
version. A second prompt goes directly through the main native admission path
with a plain persisted token, proving that reference resolution and sent status
do not depend on the plugin's send button. Unauthenticated reads are refused.

The fixture uses real `createUserMessage`, Host pre-step processing and native
Session persistence. Exact source text is logged in a generic `Paper Library`
plugin context; snapshot identity, annotation versions and body hash stay in
the source envelope. Browser chip rendering, keyboard interaction and narrow
layout are verified separately. These integration checks do not evaluate model
quality, a real library or total application memory.
