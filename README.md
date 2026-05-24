# Project Tick Github Actions

Welcome to Project Tick Github Actions.

This repository is the GitHub Actions side of the Foreman CI/CD bridge.
GitLab merge requests, pushes, and `bot, …` commands trigger reusable
workflows under `.github/workflows/`, which in turn report progress,
log chunks, job status, test results, and final outcomes back to
Foreman (https://builds.projecttick.net).

## Authoring a Foreman-aware workflow

Every reusable CI workflow in this repository follows the same
canonical pattern. The pattern is enforced by two composite actions:

- `.github/actions/foreman-job-wrapper` — drop as the FIRST step of
  each job. It starts log streaming, polls Foreman for a cancel
  request, emits a `running` job callback, and (optionally) parses
  the gate plan's quarantine list into `rspec_args` / `ctest_regex` /
  `gtest_filter` outputs.
- `.github/actions/foreman-job-finalize` — drop as the LAST step,
  guarded with `if: always()`. It uploads JUnit XML (when configured)
  and emits the terminal job callback (`success` / `failure` /
  `cancelled`).

A minimal job skeleton looks like this:

```yaml
jobs:
  my-job:
    runs-on: ubuntu-latest
    steps:
      - name: Foreman job init
        id: foreman
        uses: Project-Tick/Project-Tick/.github/actions/foreman-job-wrapper@master
        with:
          callback_url:      ${{ inputs.foreman-callback-url }}
          callback_token:    ${{ inputs.foreman-callback-token }}
          pipeline_id:       ${{ inputs.foreman-pipeline-id }}
          foreman_api_token: ${{ secrets.FOREMAN_API_TOKEN }}
          job_name:          ${{ github.job }}
          plan_json:         ${{ inputs.foreman-plan }}

      - name: Checkout
        uses: Project-Tick-Infrastructure/checkout@v2
        with:
          source-repository: ${{ inputs.source-repository || '' }}

      # ... your build / test steps ...
      # Use quarantine filters when running tests:
      # ctest -E "${{ steps.foreman.outputs.ctest_regex }}"

      - name: Foreman job finalize
        if: always()
        uses: Project-Tick/Project-Tick/.github/actions/foreman-job-finalize@master
        with:
          callback_url:      ${{ inputs.foreman-callback-url }}
          callback_token:    ${{ inputs.foreman-callback-token }}
          pipeline_id:       ${{ inputs.foreman-pipeline-id }}
          foreman_api_token: ${{ secrets.FOREMAN_API_TOKEN }}
          job_name:          ${{ github.job }}
          job_status:        ${{ job.status }}
          # Optional: upload JUnit results from this job before exiting.
          junit_path:        "build/junit-*.xml"
```

The reusable workflow's `workflow_call` block must declare these five
canonical inputs so Foreman can wire callback credentials through:

```yaml
on:
  workflow_call:
    inputs:
      source-repository:      { type: string, default: "" }
      foreman-pipeline-id:    { type: string, default: "" }
      foreman-plan:           { type: string, default: "" }
      foreman-callback-url:   { type: string, default: "" }
      foreman-callback-token: { type: string, default: "" }
```

## How the wrapper actions degrade

When a workflow runs outside a Foreman-dispatched pipeline (manual
`workflow_dispatch`, push to a fork, secrets unavailable), the wrapper
and finalize actions detect missing credentials and silently no-op
every Foreman sub-step. The build/test steps run normally. This means
the same workflow file works for:

- Foreman-orchestrated GitLab MR / push builds (full callback wiring).
- Native GitHub PRs against a mirror (admin-token fallback if
  `FOREMAN_API_TOKEN` is set, otherwise headless).
- Manual dispatch by a maintainer (headless unless they pass
  `callback_url` / `callback_token` directly).

## Secret-less execution guarantees

Every workflow in this repository is designed to **never fail a build
just because a secret is missing**. The contract is:

- **Foreman callbacks** (`FOREMAN_API_TOKEN`, `foreman-callback-*`):
  missing → wrappers no-op, gate falls back to a permissive local
  plan, status callbacks log a warning.
- **Deploy / publish credentials** (`FTP_*`, `AUR_SSH_PRIVATE_KEY`,
  `FLATPAK_*`, `CACHIX_AUTH_TOKEN`, `PPM_REGISTRY_SIGNING_KEY`,
  Maven/Gradle publish): missing → the specific publish step is
  guarded with `if: steps.creds.outputs.has_key == 'true'` and skipped
  with a `::warning::`. The job still reports `success`.
- **Code-signing credentials** (`GPG_PRIVATE_KEY`, `APPLE_CODESIGN_*`,
  `WINDOWS_CODESIGN_*`, `SPARKLE_ED25519_KEY`): handled by the
  per-platform package composite actions, which fall back to unsigned
  artifacts and surface a notice.
- **Optional polyrepo source clone token** (`PT_GITLAB_SOURCE_TOKEN`):
  missing → unauthenticated clone is attempted, which works for public
  upstream GitLab projects.

In other words: a fresh fork of this repository, with **zero secrets
configured**, can clone, run `ci.yml`, and finish with a green
verdict on the build/test stages.

## Composite action reference

| Action                            | Used by                  | Purpose                                                                 |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `foreman-job-wrapper`             | first step of every job  | log-collector + cancel-check + running callback + quarantine outputs    |
| `foreman-job-finalize`            | last step of every job   | JUnit upload + terminal job callback                                    |
| `foreman-prepare-callback`        | top-level orchestrators  | Resolve callback URL / token; register external pipeline if needed      |
| `foreman-send-callback`           | non-pipeline callbacks   | Send arbitrary `/callback/<endpoint>` payloads (e.g. release workflows) |
| `foreman-job-callback`            | (called by wrapper)      | Low-level job status callback. Prefer the wrapper for new code.         |
| `foreman-cancel-check`            | (called by wrapper)      | Heartbeat poll for server-side cancel.                                  |
| `foreman-exclude-patterns`        | (called by wrapper)      | Convert gate-plan quarantine list to test-runner CLI flags.             |
| `foreman-junit-upload`            | (called by finalize)     | Parse JUnit XML and POST cases to `/callback/test_results`.             |
| `foreman-runner-class`            | `ci.yml` only            | Cost-aware runner downgrade (`medium` → `latest`) based on gate plan.   |
| `log-collector`                   | (called by wrapper)      | Pre/main/post Node action streaming step logs to Foreman every 5s.     |
| `change-analysis`                 | reserved                 | Detect changed monorepo subdirs; not yet wired into reusable workflows. |

## Foreman endpoints touched by these actions

| Endpoint                                              | Action                              |
| ----------------------------------------------------- | ----------------------------------- |
| `POST /api/pipelines/external`                        | `foreman-prepare-callback`          |
| `POST /api/pipelines/:id/callback/jobs`               | `foreman-job-callback`              |
| `POST /api/pipelines/:id/callback/job_logs`           | `log-collector`                     |
| `POST /api/pipelines/:id/callback/test_results`       | `foreman-junit-upload`              |
| `GET  /api/pipelines/:id/cancel-check`                | `foreman-cancel-check`              |
| `POST /api/ci/github/gate-plan`                       | `ci.yml` (callback-start job)       |

Token-authenticated callbacks use the per-pipeline bearer Foreman
issued with the workflow dispatch. Admin-authenticated callbacks fall
back to `FOREMAN_API_TOKEN` and address the same endpoints under
`/api/pipelines/:id/admin-callback/<kind>`.
