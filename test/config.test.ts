import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, readSecrets, repoRoot } from "../src/config.js";

describe("config", () => {
  it("loads the checked-in defaults", () => {
    const config = loadConfig(path.join(repoRoot(), "config", "default.yaml"));
    expect(config.report.window).toBe("24h");
    expect(config.report.cadence).toBe("daily");
    expect(config.report.timezone).toBe("Europe/Malta");
    expect(config.slack.destination).toBe("dm");
    expect(config.slack.user_id).toBe("U0AFYENA7UJ");
    expect(config.github.org).toBe("XDLAB-AI");
    expect(config.gitlab.group).toBe("vgh-code/XdLabsAI-G42");
    expect(config.llm.model).toBe("claude-sonnet-5-5");
    expect(config.llm.price_input_per_million).toBe(2);
    expect(config.llm.price_output_per_million).toBe(10);
    expect(config.llm.max_cost_usd).toBeNull();
  });

  it("switches window and destination from config alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.yaml");
    const base = loadConfig(path.join(repoRoot(), "config", "default.yaml"));
    writeFileSync(
      file,
      `
report:
  window: 7d
  cadence: weekly
  timezone: Europe/Malta
  weekly_weekday: Mon
slack:
  destination: channel
  user_id: U0AFYENA7UJ
  channel_id: C012345
llm:
  model: ${base.llm.model}
  max_input_chars: 1000
  max_output_tokens: 200
  max_retries: 1
  max_cost_usd: 2
  price_input_per_million: 3
  price_output_per_million: 15
github:
  org: XDLAB-AI
  api_base: https://api.github.com
gitlab:
  base_url: https://gitlab.com
  group: vgh-code/XdLabsAI-G42
paths:
  aliases: people/aliases.yaml
  deny_list: config/noise-deny.yaml
  classify_prompt: prompts/classify.md
  narrative_prompt: prompts/narrative.md
  state_dir: state
  out_dir: out
`,
    );
    const config = loadConfig(file);
    expect(config.report.window).toBe("7d");
    expect(config.report.cadence).toBe("weekly");
    expect(config.slack.destination).toBe("channel");
    expect(config.slack.channel_id).toBe("C012345");
    expect(config.llm.max_cost_usd).toBe(2);
  });

  it("rejects a window that is not 24h or 7d", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.yaml");
    writeFileSync(file, "report:\n  window: 30d\n  cadence: daily\n");
    expect(() => loadConfig(file)).toThrow(/invalid config/i);
  });

  it("reads tokens from the environment and ignores blanks", () => {
    const secrets = readSecrets({
      GH_READONLY_TOKEN: " gh-read ",
      GITHUB_TOKEN: "should-not-win",
      GITLAB_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-test",
      SLACK_BOT_TOKEN: "xoxb-test",
    });
    expect(secrets.githubToken).toBe("gh-read");
    expect(secrets.gitlabToken).toBeUndefined();
    expect(secrets.anthropicApiKey).toBe("sk-test");
    expect(secrets.slackBotToken).toBe("xoxb-test");
  });
});
