# Current-session model selection fixture

This isolated fixture exposes two selection-only models and creates one blank
session in its own temporary workspace through `workspaceRegistry.create` and
`sessionController.create`. Model generation deliberately fails before any
network request. No credentials or user profile settings are read.

First install the plugin into the fixture profile with the project installer:

```sh
node scripts/install-harness.mjs --home /private/tmp/dsh-paper-library-model-follow --profile paper-library-follow
```

Start an isolated host using the built Harness checkout. Launcher options must
precede web-app options: `--patch` comes before `--port` and `--no-open`.

```sh
DSH_HOME=/private/tmp/dsh-paper-library-model-follow \
DSH_PAPER_LIBRARY_DIR="$PWD/artifacts/capacity-2000-1000/library" \
node ../../deepseek-ai/deepseek-harness/apps/cli/lib/bin.js \
  --profile paper-library-follow \
  --patch "$PWD/tests-js/fixtures/harness-models/cordis.patch.yml" \
  --port 3092 --no-open
```

Set the CLI path to the actual checkout if its relative location differs. Open
the startup URL, choose `Paper Library Model QA` and its blank session, then open
the paper-library pane. Change the composer from QA Reader A to QA Reader B;
the reader must follow immediately while retaining an unsaved annotation draft.
Change reasoning effort and verify that the inherited route updates. The seed
is idempotent; repeated startup adopts the same session and workspace. Stop only
this test host after the walkthrough.
