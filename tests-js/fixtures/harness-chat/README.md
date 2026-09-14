# Native paper-conversation fixture

This fixture registers one deterministic, keyless model in an isolated Harness
profile. It produces an ordinary assistant message through the native agent
loop. The adapter has no network, credential or tool-call implementation.
An authenticated, test-only route returns session/agent presence booleans and
the adapter generation count, making cold-session and retry checks observable.

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

Checks cover one-paper session reuse, distinct papers, cold creation and native
prompt adoption, quoted annotation page context, real assistant history,
idempotent prompt retries, native PDF feedback persistence and repeated saves,
and unauthenticated access rejection. These are integration checks, not an
evaluation of model quality or a real-library memory benchmark.
