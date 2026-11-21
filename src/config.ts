import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

export const configSchema = z.object({
  report: z.object({
    window: z.enum(["24h", "7d"]),
    cadence: z.enum(["daily", "weekly"]),
    timezone: z.string().min(1).default("Europe/Malta"),
    weekly_weekday: weekday.default("Mon"),
  }),
  slack: z.object({
    destination: z.enum(["dm", "channel"]),
    user_id: z.string().default("U0AFYENA7UJ"),
    channel_id: z.string().default(""),
  }),
  llm: z.object({
    model: z.string().min(1),
    max_input_chars: z.number().int().positive().default(12_000),
    max_output_tokens: z.number().int().positive().default(800),
    max_retries: z.number().int().min(0).max(3).default(1),
    max_cost_usd: z.number().nonnegative().nullable().default(null),
    price_input_per_million: z.number().nonnegative().default(2),
    price_output_per_million: z.number().nonnegative().default(10),
  }),
  github: z.object({
    org: z.string().min(1),
    api_base: z.string().url().default("https://api.github.com"),
  }),
  gitlab: z.object({
    base_url: z.string().url(),
    group: z.string().min(1),
  }),
  paths: z.object({
    aliases: z.string().default("people/aliases.yaml"),
    deny_list: z.string().default("config/noise-deny.yaml"),
    classify_prompt: z.string().default("prompts/classify.md"),
    narrative_prompt: z.string().default("prompts/narrative.md"),
    state_dir: z.string().default("state"),
    out_dir: z.string().default("out"),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type WindowPreset = AppConfig["report"]["window"];

export interface Secrets {
  githubToken?: string;
  gitlabToken?: string;
  anthropicApiKey?: string;
  slackBotToken?: string;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveFromRoot(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

export function loadConfig(configPath?: string, root = repoRoot()): AppConfig {
  const file = configPath ?? path.join(root, "config", "default.yaml");
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read config ${file}: ${message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  const githubToken = env.GH_READONLY_TOKEN || env.GITHUB_TOKEN;
  return {
    githubToken: blankToUndefined(githubToken),
    gitlabToken: blankToUndefined(env.GITLAB_TOKEN),
    anthropicApiKey: blankToUndefined(env.ANTHROPIC_API_KEY),
    slackBotToken: blankToUndefined(env.SLACK_BOT_TOKEN),
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function requireCollectorSecrets(secrets: Secrets): { githubToken: string; gitlabToken?: string } {
  if (!secrets.githubToken) {
    throw new Error(
      "Missing GitHub token. Set GH_READONLY_TOKEN (repo secret of the same name). This is not an empty window.",
    );
  }
  return { githubToken: secrets.githubToken, gitlabToken: secrets.gitlabToken };
}

export function requireAnthropic(secrets: Secrets): string {
  if (!secrets.anthropicApiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY. Classification and the narrative were not run.");
  }
  return secrets.anthropicApiKey;
}
