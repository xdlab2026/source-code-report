# Engineering activity report

Weekly digest of what shipped across the **XDLAB-AI** GitHub org and the **XdLabsAI-G42** GitLab group. A run collects commits, drops merge and bot commits, maps authors to people, counts raw lines beside meaningful lines, classifies each pull request or merge request (or a lone commit), and posts a short Slack summary with a PDF.

v1 is for one reader. The default posts a DM to Slack user `U0AFYENA7UJ`. The PDF names standout projects and people in the overview. It does not include a leaderboard. Dashboards and email are out of scope.

## Setup

Node 22 or newer.

```bash
npm ci
cp .env.example .env
```

Fill `.env` locally. Do not commit it. In GitHub Actions, add the same values as repository secrets (names below). This repo never stores token values.

Check the project without a network call to GitHub, GitLab, or Anthropic:

```bash
npm test
npm run typecheck
npm run eval
```

`npm run check` runs all three. The tests and the eval harness use fixtures. They do not need an API key.

## Configuration

Defaults live in [`config/default.yaml`](config/default.yaml). These keys are the v1 surface:

| Key | Default | Also allowed |
| --- | --- | --- |
| `report.window` | `7d` (last week) | `24h` (past 24 hours) |
| `report.cadence` | `weekly` | `daily` |
| `slack.destination` | `dm` | `channel` |
| `slack.user_id` | `U0AFYENA7UJ` | any Slack user id |
| `slack.channel_id` | empty | required when destination is `channel` |

The checked-in defaults are a weekly run covering the last week. Switching the window to `24h`, the cadence to `daily`, or the destination to a channel is a config edit. Collectors, the classifier, and the report builder do not need code changes.

Other keys you will actually touch:

- `report.timezone` is `Europe/Malta`. Windows are durations ending at run time, not calendar days. The timezone is used for the digest clock, the weekly weekday, and the idempotency hour.
- `report.weekly_weekday` is `Mon`. A scheduled weekly run posts only on that weekday in `report.timezone`.
- `llm.model` is the Anthropic API model id (`claude-sonnet-5-5`, Claude Sonnet 5.5).
- `llm.max_cost_usd` is `null`, so there is no cap. Set a number to abort before Slack if the estimated cost is higher. The prices in config are estimates for the log, not an invoice.
- Prompts are [`prompts/classify.md`](prompts/classify.md) and [`prompts/narrative.md`](prompts/narrative.md).

## Secrets

Tokens are read from the environment only.

| GitHub Actions secret | Environment variable | What it needs |
| --- | --- | --- |
| `GH_READONLY_TOKEN` | `GH_READONLY_TOKEN` | Read-only access to every repo in the **XDLAB-AI** org. Fine-grained: Contents Read, Metadata Read, Pull requests Read. Classic: `public_repo`, or `repo` if any repo is private. Actions rejects secret names that start with `GITHUB_`, so this is not named `GITHUB_TOKEN`. |
| `GITLAB_TOKEN` | `GITLAB_TOKEN` | Optional. Group access token or PAT for `vgh-code/XdLabsAI-G42`, including subgroups. Scopes `read_api` and `read_repository`. Role Reporter is enough. If this secret is unset or empty, the run skips GitLab and says so in the digest. |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Access to `llm.model`. |
| `SLACK_BOT_TOKEN` | `SLACK_BOT_TOKEN` | Bot token with `chat:write`, `files:write`, `im:write`, `im:history`, and `channels:history`. |

Do not use the automatic Actions `GITHUB_TOKEN` for collection. It can only see this repository, and a secret cannot start with `GITHUB_`. The workflow passes `secrets.GH_READONLY_TOKEN` through as `GH_READONLY_TOKEN`. Locally, `GITHUB_TOKEN` is accepted only if `GH_READONLY_TOKEN` is unset.

Auth failures and rate limits abort the run. They are not reported as an empty window.

GitLab is optional. An unset or blank `GITLAB_TOKEN` skips that collector, and the digest and run log say GitLab wasn't included because there was no token. A token that is present and then fails authentication still aborts the run.

## People

[`people/aliases.yaml`](people/aliases.yaml) maps emails, GitHub logins, and GitLab usernames onto one id and display name. Matching is case-insensitive. GitHub login wins, then GitLab username, then email.

Add a person by appending an entry. Put every login they commit under on the same id, or the digest will split them.

An author who matches nothing is kept as `unmapped:<kind>:<key>` and marked unmapped. They are not dropped.

The checked-in file maps **Xiaodong Zhou** to GitHub login `xdlab2026` and the GitHub noreply address `262348385+xdlab2026@users.noreply.github.com`. His GitLab username is not filled in: it was not verified while this repo was created. Add it under `gitlab_usernames` when you know it, and add any other commit emails you see. GitLab commit objects usually have an email and not a username, so the email is what joins a GitLab commit to a person. Merge request authors and release mergers join on GitLab username.

## Noise filter

[`config/noise-deny.yaml`](config/noise-deny.yaml) lists lockfiles, generated paths, and vendored directories. A matching file still counts in **raw** additions and deletions. It is left out of **meaningful** lines. The classifier also omits those patches.

Globs: `*` stays inside one path segment, `**` crosses segments, matching is case-insensitive. To extend the list, add a rule:

```yaml
  - id: my-generated
    kind: generated # lockfile | generated | vendored
    pattern: "**/my-generated/**"
```

No code change. `dist/` and `build/` are treated as generated output. Delete those rules if a repo keeps real source there.

Merge commits and bot commits (Dependabot, Renovate, `github-actions`, logins ending in `[bot]`, and similar) are removed before either total. A human using a `users.noreply.github.com` address is not treated as a bot. The same SHA on a default branch and a `release/x.y.z` branch counts once. A cherry-pick whose message says `cherry picked from commit <sha>` counts once with the original when both are in the window.

## What a run collects

GitHub: every repo in `XDLAB-AI`, commits on the default branch and on branches named `release/x.y.z` (exactly three numeric parts, as in `release/1.2.3`). Pull requests are attached when GitHub links the commit.

GitLab: every project in the group, including nested groups. Same commit rules. A **production release** is a `release/x.y.z` branch whose tip landed in the window, or a merge request whose source or target is such a branch and whose `merged_at` is in the window. The record stores version, project, timestamp, and the cutter or merger when the payload includes them. GitHub `release/*` branches are collected as commits only. They are not counted as production releases.

Change units are pull requests or merge requests. A commit with no request is its own unit. Classification prefers that request (title, description, meaningful diff) and falls back to the commit.

## Classification

Each unit is sent to the Anthropic Messages API using `llm.model`. The response must match [`schema/classification.json`](schema/classification.json):

- `category`: feature, bugfix, refactor, test, docs, config/infra, dependency, release
- `size`: S, M, L, XL (meaningful diff, not lockfiles)
- `complexity`: low, med, high (difficulty, not size — a small change may be high)
- `risk_flags`: any of `auth/data touched`, `no tests`, `large untested change`
- `summary`: one line

Invalid JSON is retried (`llm.max_retries`, default 1) and then marked failed. It is not stored as a guess. Oversized diffs are trimmed to `llm.max_input_chars` and still classified. Token use and an estimated USD cost are written on the run log and at the bottom of the digest.

The narrative is a short factual paragraph: what shipped, where effort went, and anything worth a look. It may name standout projects and the people who did that work. It does not publish a leaderboard.

### Eval

[`eval/fixtures.json`](eval/fixtures.json) is a hand-labelled set of 30 pull requests and merge requests across both sources. `npm run eval` scores the checked-in `model_output` against `gold` with no API key. Category-and-complexity agreement on those recorded outputs is 90%. The three misses are written up in [`eval/gaps.md`](eval/gaps.md).

That score is not a live Anthropic measurement. A live pass still needs a key. Replace `model_output` with fresh responses, run `npm run eval`, and update `eval/gaps.md` if a new miss shows up. The test fails when a disagreement is undocumented.

## Run once

Dry-run is the default. It writes `out/report.md`, `out/report.pdf`, `out/report.csv`, `out/report.json`, and `out/run.json`. It does not post to Slack.

```bash
npm run report
npm run report -- --window 7d
npm run report -- --since 2026-11-01T00:00:00Z --until 2026-11-08T00:00:00Z
npm run report -- --deliver
npm run report -- --window 24h --deliver
```

`--window` is `24h` or `7d` and ends at the current time. `7d` is described as last week. `24h` is the past 24 hours. `--since` and `--until` together are an explicit range (both required). `--deliver` posts. `--force` posts even if this window was already delivered. `--config path` loads another YAML file.

A manual run ignores `report.cadence`, so you can produce last week's digest on a Tuesday without waiting for Monday. `--scheduled` is what the weekly job passes so the cadence gate applies.

The PDF is the report. It has three sections:

1. **Overview** — the window, a short narrative, key numbers, and the projects and people who stood out.
2. **Projects** — every project that changed, the main changes, who contributed, and each person's share of that project's lines.
3. **People** — every person, with their effort split across projects as a share and as commits, meaningful lines, and raw lines.

Activities are pull requests, merge requests, and bare commits, with category and summary. The PDF does not list raw per-change line statistics. Aggregates stay on each project and person. Risk flags and the GitLab-skipped note appear when they apply. People are ordered by name. People with no commits, releases, or classified work are omitted.

The CSV stays in `out/` and in the Actions artifact. Slack does not attach it. Columns are unchanged:

- `change_unit` — one PR, MR, or commit, with raw and meaningful line counts and the AI labels
- `person` — projects, commits, raw and meaningful lines, category mix, high-complexity count, releases
- `project` — contributors, commits, lines, category mix, GitLab release count, risk flags

There is no email path.

The Slack message is a short summary: the window, the narrative, one line of counts, and a pointer to the PDF. The footer `report-key:…` is how a retry notices that this window was already posted.

## Weekly job

The job is a GitHub Actions workflow in this repo: [`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml). The file name is unchanged. The Actions title is **Weekly engineering report**.

- Cron `0 0 * * 1` UTC, Monday. That is **04:00 Asia/Dubai** (UTC+4, no daylight saving). In Europe/Malta it is 01:00 Monday in winter and 02:00 Monday in summer, so the weekly gate still opens.
- `report.cadence` is `weekly`, so a scheduled tick posts only on `report.weekly_weekday` (Monday) in Europe/Malta. `report.window` is `7d`.
- **Run workflow** in the Actions tab. The default window is `7d`. `24h` is still an option. A manual run does not wait for Monday.
- A concurrency group stops two hosted runs from overlapping. A second run for the same window sees the Slack `report-key` (last 100 messages) or `state/delivered.json` and does not post again. The workflow restores `state/` from the Actions cache as a backup. On a fresh runner the Slack history is the source of truth, which is why `im:history` and `channels:history` are required.
- If a post succeeds and the PDF upload then fails, a retry will see the key and skip. Re-send with `--force` if you need the file.
- A lock file under `state/` blocks a second local process for the same key. Locks older than six hours are treated as stale.
- Each run logs status, duration, and LLM token cost to stdout and to `out/run.json`. The workflow uploads `out/` as an artifact, including `report.pdf` and `report.csv`.

### Hosting and cost

Hosting decision: **GitHub Actions on `xdlab2026/source-code-report`**, schedule above. No separate server.

LLM budget: still open. `llm.max_cost_usd` is unset, so a run will not stop itself for cost. The digest prints the estimate. Set a cap in config when you have a number. A 24-hour run classifies one unit at a time, then writes one narrative, so cost tracks the number of pull requests and bare commits in the window. A 7-day window will be larger.

## Tests

| Area | File |
| --- | --- |
| Config defaults and secret env vars | `test/config.test.ts` |
| Alias mapping, including an unmapped author | `test/aliases.test.ts` |
| GitHub collector, mocked API | `test/github-collector.test.ts` |
| GitLab collector and `release/x.y.z` | `test/gitlab-collector.test.ts` |
| Noise filter | `test/noise.test.ts` |
| SHA dedupe, cherry-picks, rollups | `test/metrics.test.ts` |
| Classifier schema, retry, trim | `test/classifier.test.ts` |
| Report, digest, CSV | `test/report.test.ts` |
| PDF sections and effort shares | `test/report-pdf.test.ts` |
| Slack DM, channel, duplicate, failures | `test/slack.test.ts` |
| Window, Malta weekday, overlap lock | `test/window.test.ts` |
| Full pipeline on mocks | `test/pipeline.test.ts` |
| Eval set | `test/eval.test.ts`, `npm run eval` |
