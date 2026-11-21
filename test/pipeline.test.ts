import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import type { HttpRequest } from "../src/http.js";
import { runReport } from "../src/pipeline.js";
import { formatDigest, GITLAB_OMITTED_NOTE } from "../src/report.js";
import { json } from "./helpers.js";

const now = new Date("2026-11-21T10:00:00.000Z");

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "report-"));
}

function configFile(edit: (raw: string) => string): string {
  const dir = tempDir();
  const file = path.join(dir, "config.yaml");
  writeFileSync(file, edit(readFileSync(path.join(repoRoot(), "config", "default.yaml"), "utf8")));
  return file;
}

function anthropic(text: string) {
  return json({ content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } });
}

describe("pipeline", () => {
  it("fails before collection when a token is missing", async () => {
    await expect(
      runReport({
        now,
        env: {},
        stateDir: tempDir(),
        outDir: tempDir(),
        http: { request: () => Promise.reject(new Error("should not call the network")) },
      }),
    ).rejects.toThrow(/GH_READONLY_TOKEN/);
  });

  it("skips a weekly cadence on the wrong weekday without calling collectors", async () => {
    const result = await runReport({
      configPath: configFile((raw) => raw.replace("cadence: daily", "cadence: weekly")),
      scheduled: true,
      now: new Date("2026-11-17T10:00:00.000Z"),
      env: {},
      stateDir: tempDir(),
      outDir: tempDir(),
      http: { request: () => Promise.reject(new Error("should not call the network")) },
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/weekly/);
  });

  it("refuses to deliver when the estimated LLM cost exceeds the cap", async () => {
    const urls: string[] = [];
    const result = runReport({
      configPath: configFile((raw) => raw.replace("max_cost_usd: null", "max_cost_usd: 0")),
      now,
      deliver: true,
      env: {
        GH_READONLY_TOKEN: "gh",
        GITLAB_TOKEN: "gl",
        ANTHROPIC_API_KEY: "sk",
        SLACK_BOT_TOKEN: "xoxb",
      },
      stateDir: tempDir(),
      outDir: tempDir(),
      http: {
        request(input: HttpRequest) {
          urls.push(input.url);
          if (input.url.includes("conversations.open")) return Promise.resolve(json({ ok: true, channel: { id: "D1" } }));
          if (input.url.includes("conversations.history")) return Promise.resolve(json({ ok: true, messages: [] }));
          if (input.url.includes("/orgs/XDLAB-AI/repos")) return Promise.resolve(json([]));
          if (input.url.includes("/api/v4/groups/")) return Promise.resolve(json([]));
          if (input.url.includes("api.anthropic.com")) return Promise.resolve(anthropic("Nothing shipped."));
          if (input.url.includes("chat.postMessage")) return Promise.reject(new Error("posted anyway"));
          return Promise.reject(new Error(`unexpected ${input.url}`));
        },
      },
    });
    await expect(result).rejects.toThrow(/max_cost_usd/);
    expect(urls.some((url) => url.includes("chat.postMessage"))).toBe(false);
  });

  it("collects, classifies, and delivers once for a repeated window", async () => {
    const stateDir = tempDir();
    const outDir = tempDir();
    const messages: { text: string }[] = [];
    let anthropicCalls = 0;
    const http = {
      request(input: HttpRequest) {
        const url = input.url;
        const parsed = new URL(url);
        if (parsed.pathname === "/orgs/XDLAB-AI/repos") {
          return Promise.resolve(json([{ full_name: "XDLAB-AI/demo", name: "demo", default_branch: "main", html_url: "https://github.com/XDLAB-AI/demo" }]));
        }
        if (parsed.pathname === "/repos/XDLAB-AI/demo/branches") return Promise.resolve(json([{ name: "main" }]));
        if (parsed.pathname === "/repos/XDLAB-AI/demo/commits" && parsed.searchParams.has("sha")) {
          return Promise.resolve(
            json([
              {
                sha: "gh1",
                commit: {
                  message: "feat: add helper",
                  author: { name: "Xiaodong Zhou", email: "dev@example.com", date: "2026-11-21T09:00:00Z" },
                  committer: { name: "Xiaodong Zhou", email: "dev@example.com", date: "2026-11-21T09:00:00Z" },
                },
                author: { login: "xdlab2026", type: "User" },
                parents: [{ sha: "base" }],
                files: [
                  { filename: "src/a.ts", additions: 4, deletions: 1, patch: "+a" },
                  { filename: "package-lock.json", additions: 100, deletions: 0, patch: "+lock" },
                ],
              },
            ]),
          );
        }
        if (parsed.pathname.endsWith("/pulls")) return Promise.resolve(json([]));
        if (parsed.pathname.includes("/groups/") && parsed.pathname.endsWith("/projects")) {
          return Promise.resolve(
            json([{ id: 7, name: "app", path_with_namespace: "vgh-code/XdLabsAI-G42/app", web_url: "https://gitlab.com/g/app", default_branch: "main" }]),
          );
        }
        if (parsed.pathname === "/api/v4/projects/7/repository/branches") {
          return Promise.resolve(
            json([
              { name: "main", commit: { committed_date: "2026-01-01T00:00:00Z", author_email: "old@example.com" } },
              {
                name: "release/1.2.0",
                web_url: "https://gitlab.com/g/app/-/tree/release/1.2.0",
                commit: { committed_date: "2026-11-21T08:00:00Z", author_email: "262348385+xdlab2026@users.noreply.github.com", author_name: "Xiaodong Zhou" },
              },
            ]),
          );
        }
        if (parsed.pathname === "/api/v4/projects/7/repository/commits") {
          if (parsed.searchParams.get("ref_name") === "release/1.2.0") return Promise.resolve(json([]));
          return Promise.resolve(
            json([
              {
                id: "gl1",
                message: "fix: empty state",
                author_name: "Xiaodong Zhou",
                author_email: "262348385+xdlab2026@users.noreply.github.com",
                committed_date: "2026-11-21T09:30:00Z",
                parent_ids: ["base"],
                diff: [{ new_path: "src/view.ts", old_path: "src/view.ts", diff: "@@\n+line\n" }],
              },
            ]),
          );
        }
        if (parsed.pathname.includes("/merge_requests")) return Promise.resolve(json([]));
        if (url.includes("api.anthropic.com")) {
          anthropicCalls += 1;
          const user = JSON.parse(input.body ?? "{}").messages[0].content as string;
          if (user.includes("NARRATIVE_DATA")) return Promise.resolve(anthropic("In the past 24 hours the team shipped a helper and cut release 1.2.0."));
          return Promise.resolve(
            anthropic(JSON.stringify({ category: "feature", size: "S", complexity: "low", risk_flags: [], summary: "Ships a small change." })),
          );
        }
        if (url.includes("conversations.open")) return Promise.resolve(json({ ok: true, channel: { id: "D777" } }));
        if (url.includes("conversations.history")) return Promise.resolve(json({ ok: true, messages }));
        if (url.includes("chat.postMessage")) {
          const text = JSON.parse(input.body ?? "{}").text as string;
          messages.push({ text });
          return Promise.resolve(json({ ok: true }));
        }
        if (url.includes("files.getUploadURLExternal")) {
          return Promise.resolve(json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" }));
        }
        if (url.includes("files.slack.com")) return Promise.resolve(json("ok", 200));
        if (url.includes("files.completeUploadExternal")) return Promise.resolve(json({ ok: true }));
        return Promise.reject(new Error(`unexpected ${url}`));
      },
    };
    const env = {
      GH_READONLY_TOKEN: "gh",
      GITLAB_TOKEN: "gl",
      ANTHROPIC_API_KEY: "sk",
      SLACK_BOT_TOKEN: "xoxb",
    };
    const first = await runReport({ now, deliver: true, env, http, stateDir, outDir });
    expect(first.status).toBe("success");
    expect(first.report?.windowPhrase).toBe("past 24 hours");
    expect(first.report?.people.map((person) => person.personId)).toEqual(["xiaodong-zhou"]);
    const person = first.report!.people[0];
    expect(person.unmapped).toBe(false);
    expect(person.meaningfulLines).toBeLessThan(person.rawLines);
    expect(person.releases.map((release) => release.version)).toEqual(["1.2.0"]);
    expect(first.report?.markdown).toContain("## Narrative");
    expect(first.log.llm.calls).toBe(3);
    expect(first.log.llm.estimatedUsd).toBeGreaterThan(0);
    expect(first.log.delivered).toBe(true);
    expect(first.log.durationMs).toBeGreaterThanOrEqual(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].text.indexOf("*Narrative*")).toBeLessThan(messages[0].text.indexOf("*People*"));
    expect(readFileSync(path.join(outDir, "report.csv"), "utf8")).toContain("change_unit");

    const callsAfter = anthropicCalls;
    const second = await runReport({ now, deliver: true, env, http, stateDir, outDir });
    expect(second.status).toBe("skipped");
    expect(second.log.duplicate).toBe(true);
    expect(anthropicCalls).toBe(callsAfter);
    expect(messages).toHaveLength(1);
    expect(first.log.notes).toEqual([]);
    expect(messages[0].text).not.toContain(GITLAB_OMITTED_NOTE);
  });

  it("skips GitLab when the token is unset or blank and notes the digest and run log", async () => {
    const urls: string[] = [];
    const outDir = tempDir();
    const http = {
      request(input: HttpRequest) {
        urls.push(input.url);
        if (input.url.includes("/orgs/XDLAB-AI/repos")) return Promise.resolve(json([]));
        if (input.url.includes("api.anthropic.com")) return Promise.resolve(anthropic("Nothing shipped."));
        return Promise.reject(new Error(`unexpected ${input.url}`));
      },
    };
    const shared = {
      now,
      stateDir: tempDir(),
      outDir,
      http,
    };
    const blank = await runReport({
      ...shared,
      env: { GH_READONLY_TOKEN: "gh", GITLAB_TOKEN: "  ", ANTHROPIC_API_KEY: "sk" },
    });
    expect(blank.status).toBe("success");
    expect(urls.some((url) => url.includes("gitlab") || url.includes("/api/v4/"))).toBe(false);
    expect(blank.log.notes).toEqual([GITLAB_OMITTED_NOTE]);
    expect(blank.report?.markdown).toContain(GITLAB_OMITTED_NOTE);
    expect(formatDigest(blank.report!)).toContain(GITLAB_OMITTED_NOTE);
    expect(readFileSync(path.join(outDir, "run.json"), "utf8")).toContain(GITLAB_OMITTED_NOTE);

    urls.length = 0;
    const unset = await runReport({
      ...shared,
      stateDir: tempDir(),
      outDir: tempDir(),
      env: { GH_READONLY_TOKEN: "gh", ANTHROPIC_API_KEY: "sk" },
    });
    expect(unset.status).toBe("success");
    expect(unset.log.notes).toEqual([GITLAB_OMITTED_NOTE]);
    expect(urls.some((url) => url.includes("/api/v4/"))).toBe(false);
  });

  it("fails the run when a present GitLab token is rejected", async () => {
    await expect(
      runReport({
        now,
        env: { GH_READONLY_TOKEN: "gh", GITLAB_TOKEN: "gl", ANTHROPIC_API_KEY: "sk" },
        stateDir: tempDir(),
        outDir: tempDir(),
        http: {
          request(input: HttpRequest) {
            if (input.url.includes("/orgs/XDLAB-AI/repos")) return Promise.resolve(json([]));
            if (input.url.includes("/api/v4/groups/")) return Promise.resolve(json({ message: "401 Unauthorized" }, 401));
            return Promise.reject(new Error(`unexpected ${input.url}`));
          },
        },
      }),
    ).rejects.toThrow(/GitLab authentication failed \(401\)/);
  });
});
