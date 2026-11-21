import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAnthropicClient } from "./anthropic.js";
import { classifyAll, loadClassificationSchemaDocument } from "./classifier.js";
import { collectGithub } from "./collectors/github.js";
import { collectGitlab } from "./collectors/gitlab.js";
import {
  loadConfig,
  readSecrets,
  repoRoot,
  requireAnthropic,
  requireCollectorSecrets,
  resolveFromRoot,
  type WindowPreset,
} from "./config.js";
import { assertWithinBudget, createCostTracker, type CostSnapshot, type CostTracker } from "./cost.js";
import { renderCsv } from "./csv.js";
import type { HttpClient } from "./http.js";
import { createFetchClient } from "./http.js";
import { loadAliases } from "./identity.js";
import { acquireRunLock } from "./lock.js";
import { attributeReleases, rollup, scoreCommits } from "./metrics.js";
import { writeNarrative } from "./narrative.js";
import { compileDenyList, loadDenyList } from "./noise.js";
import { hasReceipt, rememberReceipt } from "./receipts.js";
import { buildReport, renderMarkdown, type Report } from "./report.js";
import { deliverSlack, findExistingDelivery } from "./slack.js";
import { buildChangeUnits } from "./units.js";
import { hourBucket, resolveWindow, shouldRunScheduled, type TimeWindow } from "./window.js";

export interface RunOptions {
  configPath?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  scheduled?: boolean;
  deliver?: boolean;
  window?: WindowPreset;
  since?: string;
  until?: string;
  force?: boolean;
  stateDir?: string;
  outDir?: string;
}

export interface RunLog {
  status: "success" | "skipped" | "failed";
  reason?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timezone: string;
  window?: { preset: string; since: string; until: string; phrase: string };
  destination?: { type: string; id: string };
  llm: CostSnapshot;
  delivered: boolean;
  duplicate: boolean;
  counts?: { githubCommits: number; gitlabCommits: number; releases: number; changeUnits: number };
  error?: string;
}

export interface RunResult {
  status: "success" | "skipped";
  reason?: string;
  report?: Report;
  log: RunLog;
}

export function makeRunKey(input: {
  preset: string;
  since: Date;
  until: Date;
  timezone: string;
  destination: string;
  destinationId: string;
  bucket: boolean;
}): string {
  const windowPart = input.bucket
    ? hourBucket(input.until, input.timezone)
    : `${input.since.toISOString()}_${input.until.toISOString()}`;
  return `${input.preset}|${windowPart}|${input.destination}|${input.destinationId}`;
}

export async function runReport(options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const root = repoRoot();
  const config = loadConfig(options.configPath, root);
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const stateDir = options.stateDir ?? resolveFromRoot(root, config.paths.state_dir);
  const outDir = options.outDir ?? resolveFromRoot(root, config.paths.out_dir);
  const timezone = config.report.timezone;
  const cost = createCostTracker({
    inputPerMillion: config.llm.price_input_per_million,
    outputPerMillion: config.llm.price_output_per_million,
  });

  const finish = (partial: Omit<RunLog, "startedAt" | "finishedAt" | "durationMs" | "timezone" | "llm"> & { llm?: CostSnapshot }): RunLog => {
    const log: RunLog = {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      timezone,
      llm: partial.llm ?? snapshotCost(cost),
      ...partial,
    };
    writeJson(path.join(outDir, "run.json"), log);
    return log;
  };

  if (options.scheduled) {
    const gate = shouldRunScheduled({
      cadence: config.report.cadence,
      weeklyWeekday: config.report.weekly_weekday,
      timezone,
      now,
    });
    if (!gate.run) {
      return { status: "skipped", reason: gate.reason, log: finish({ status: "skipped", reason: gate.reason, delivered: false, duplicate: false }) };
    }
  }

  const timeWindow = resolveWindow({
    preset: config.report.window,
    now,
    override: options.window,
    since: options.since,
    until: options.until,
  });
  const destination = resolveDestination(config.slack.destination, config.slack.user_id, config.slack.channel_id);
  const runKey = makeRunKey({
    preset: timeWindow.preset,
    since: timeWindow.since,
    until: timeWindow.until,
    timezone,
    destination: destination.type,
    destinationId: destination.id,
    bucket: !options.since && !options.until,
  });
  const release = acquireRunLock(stateDir, runKey);
  try {
    if (options.deliver && !options.force && hasReceipt(stateDir, runKey)) {
      return {
        status: "skipped",
        reason: "already delivered for this window",
        log: finish({
          status: "skipped",
          reason: "already delivered for this window",
          delivered: false,
          duplicate: true,
          window: windowLog(timeWindow),
          destination,
        }),
      };
    }
    const http = options.http ?? createFetchClient();
    const secrets = readSecrets(env);
    if (options.deliver && !options.force) {
      if (!secrets.slackBotToken) {
        throw new Error("Missing SLACK_BOT_TOKEN. The digest was not posted.");
      }
      const existing = await findExistingDelivery({
        http,
        token: secrets.slackBotToken,
        destination: destination.type,
        destinationId: destination.id,
        runKey,
      });
      if (existing.duplicate) {
        rememberReceipt(stateDir, runKey);
        return {
          status: "skipped",
          reason: "already delivered for this window",
          log: finish({
            status: "skipped",
            reason: "already delivered for this window",
            delivered: false,
            duplicate: true,
            window: windowLog(timeWindow),
            destination,
          }),
        };
      }
    }

    const tokens = requireCollectorSecrets(secrets);
    const apiKey = requireAnthropic(secrets);
    const [githubCommits, gitlab] = await Promise.all([
      collectGithub({
        http,
        token: tokens.githubToken,
        org: config.github.org,
        apiBase: config.github.api_base,
        since: timeWindow.since,
        until: timeWindow.until,
      }),
      collectGitlab({
        http,
        token: tokens.gitlabToken,
        baseUrl: config.gitlab.base_url,
        group: config.gitlab.group,
        since: timeWindow.since,
        until: timeWindow.until,
      }),
    ]);
    const aliases = loadAliases(resolveFromRoot(root, config.paths.aliases));
    const deny = compileDenyList(loadDenyList(resolveFromRoot(root, config.paths.deny_list)));
    const scored = scoreCommits([...githubCommits, ...gitlab.commits], aliases, deny);
    const releases = attributeReleases(gitlab.releases, aliases);
    const activity = rollup(scored, releases);
    const units = buildChangeUnits(scored, aliases, deny);
    const classifyPrompt = readPrompt(resolveFromRoot(root, config.paths.classify_prompt));
    const system = `${classifyPrompt}\n\nJSON schema:\n${JSON.stringify(loadClassificationSchemaDocument())}`;
    const client = createAnthropicClient(http, apiKey);
    const classified = await classifyAll(units, client, {
      system,
      model: config.llm.model,
      maxInputChars: config.llm.max_input_chars,
      maxOutputTokens: config.llm.max_output_tokens,
      maxRetries: config.llm.max_retries,
      cost,
    });
    const draft = buildReport({
      window: timeWindow,
      timezone,
      destination: destination.type,
      destinationId: destination.id,
      narrative: "",
      runKey,
      people: activity.people,
      projects: activity.projects,
      units: classified,
      llm: cost,
    });
    const narrative = await writeNarrative(draft, client, {
      system: readPrompt(resolveFromRoot(root, config.paths.narrative_prompt)),
      model: config.llm.model,
      maxTokens: config.llm.max_output_tokens,
      cost,
    });
    assertWithinBudget(cost, config.llm.max_cost_usd);
    draft.narrative = narrative;
    draft.llm = { ...cost };
    draft.markdown = renderMarkdown(draft);
    const csv = renderCsv(draft);
    writeArtifacts(outDir, draft, csv);
    let delivered = false;
    if (options.deliver) {
      const result = await deliverSlack({ http, token: secrets.slackBotToken, report: draft, csv, force: options.force });
      if (result.duplicate && !result.posted) {
        rememberReceipt(stateDir, runKey);
        return {
          status: "skipped",
          reason: "already delivered for this window",
          report: draft,
          log: finish({
            status: "skipped",
            reason: "already delivered for this window",
            delivered: false,
            duplicate: true,
            window: windowLog(timeWindow),
            destination,
            counts: {
              githubCommits: githubCommits.length,
              gitlabCommits: gitlab.commits.length,
              releases: releases.length,
              changeUnits: classified.length,
            },
            llm: { ...cost },
          }),
        };
      }
      delivered = result.posted;
      if (result.posted) rememberReceipt(stateDir, runKey);
    }
    const counts = {
      githubCommits: githubCommits.length,
      gitlabCommits: gitlab.commits.length,
      releases: releases.length,
      changeUnits: classified.length,
    };
    return {
      status: "success",
      report: draft,
      log: finish({
        status: "success",
        delivered,
        duplicate: false,
        window: windowLog(timeWindow),
        destination,
        counts,
        llm: { ...cost },
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish({
      status: "failed",
      error: message,
      delivered: false,
      duplicate: false,
      window: windowLog(timeWindow),
      destination,
    });
    throw error;
  } finally {
    release();
  }
}

function resolveDestination(type: "dm" | "channel", userId: string, channelId: string): { type: "dm" | "channel"; id: string } {
  if (type === "channel") {
    if (!channelId) throw new Error("slack.destination is channel but slack.channel_id is empty.");
    return { type, id: channelId };
  }
  if (!userId) throw new Error("slack.destination is dm but slack.user_id is empty.");
  return { type: "dm", id: userId };
}

function windowLog(window: TimeWindow): { preset: string; since: string; until: string; phrase: string } {
  return { preset: window.preset, since: window.since.toISOString(), until: window.until.toISOString(), phrase: window.phrase };
}

function snapshotCost(cost: CostTracker): CostSnapshot {
  return {
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    calls: cost.calls,
    estimatedUsd: cost.estimatedUsd,
  };
}

function readPrompt(file: string): string {
  return readFileSync(file, "utf8");
}

function writeArtifacts(dir: string, report: Report, csv: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.md"), report.markdown);
  writeFileSync(path.join(dir, "report.csv"), csv);
  writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(serializeReport(report), null, 2)}\n`);
}

function serializeReport(report: Report): unknown {
  return {
    ...report,
    changeUnits: report.changeUnits.map((unit) => ({
      ...unit,
      diff: undefined,
      files: unit.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    })),
  };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
