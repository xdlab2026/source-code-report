import { describe, expect, it } from "vitest";
import { collectGithub } from "../src/collectors/github.js";
import { CollectorError } from "../src/errors.js";
import { json, recorded } from "./helpers.js";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-21T10:00:00.000Z");

function ghCommit(input: {
  sha: string;
  message: string;
  login: string;
  email?: string;
  parents?: string[];
  type?: string;
  files?: { filename: string; additions: number; deletions: number; patch?: string }[];
}) {
  return {
    sha: input.sha,
    commit: {
      message: input.message,
      author: { name: input.login, email: input.email ?? `${input.login}@example.com`, date: "2026-11-21T09:00:00Z" },
      committer: { name: input.login, email: input.email ?? `${input.login}@example.com`, date: "2026-11-21T09:00:00Z" },
    },
    author: { login: input.login, type: input.type ?? "User" },
    committer: { login: input.login, type: input.type ?? "User" },
    parents: (input.parents ?? ["base"]).map((sha) => ({ sha })),
    files: input.files ?? [{ filename: "src/app.ts", additions: 3, deletions: 1, patch: "+app" }],
  };
}

describe("GitHub collector", () => {
  it("pages repos, collects default and release branches, and dedupes SHAs", async () => {
    const pulls: string[] = [];
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/orgs/XDLAB-AI/repos") {
        const page = parsed.searchParams.get("page") ?? "1";
        if (page === "1") {
          return json([{ full_name: "XDLAB-AI/api", name: "api", default_branch: "main", html_url: "https://github.com/XDLAB-AI/api" }], 200, {
            link: '<https://api.github.com/orgs/XDLAB-AI/repos?per_page=100&type=all&page=2>; rel="next"',
          });
        }
        return json([{ full_name: "XDLAB-AI/web", name: "web", default_branch: "main", html_url: "https://github.com/XDLAB-AI/web" }]);
      }
      if (parsed.pathname.endsWith("/branches")) {
        return json([{ name: "main" }, { name: "release/1.2.3" }, { name: "feature/not-this" }]);
      }
      if (parsed.pathname.endsWith("/commits") && parsed.searchParams.has("sha")) {
        const branch = parsed.searchParams.get("sha");
        const repo = parsed.pathname.split("/")[3];
        if (branch === "feature/not-this") return json([ghCommit({ sha: "should-not", message: "nope", login: "a" })]);
        if (repo === "web") return json([ghCommit({ sha: "web1", message: "feat: web", login: "ada", email: "ada@example.com" })]);
        if (branch === "release/1.2.3") return json([ghCommit({ sha: "same", message: "feat: shared", login: "ada", email: "ada@example.com" })]);
        return json([
          ghCommit({ sha: "same", message: "feat: shared", login: "ada", email: "ada@example.com" }),
          ghCommit({ sha: "merge1", message: "Merge pull request #4 from x", login: "ada", parents: ["a", "b"] }),
          ghCommit({ sha: "bot1", message: "bump", login: "dependabot[bot]", type: "Bot" }),
        ]);
      }
      if (parsed.pathname.endsWith("/pulls")) {
        pulls.push(parsed.pathname);
        if (parsed.pathname.includes("/same/")) {
          return json([{ number: 12, title: "Share the helper", body: "Used on main and release.", html_url: "https://github.com/XDLAB-AI/api/pull/12", user: { login: "ada" } }]);
        }
        return json([]);
      }
      throw new Error(`unexpected ${url}`);
    });

    const commits = await collectGithub({
      http,
      token: "token",
      org: "XDLAB-AI",
      apiBase: "https://api.github.com",
      since: new Date(now.getTime() - day),
      until: now,
    });
    expect(http.urls.some((url) => url.includes("include_subgroups"))).toBe(false);
    expect(http.urls.filter((url) => url.includes("/orgs/XDLAB-AI/repos"))).toHaveLength(2);
    expect(http.urls.some((url) => new URL(url).searchParams.get("sha") === "feature/not-this")).toBe(false);
    const shared = commits.filter((commit) => commit.sha === "same");
    expect(shared).toHaveLength(1);
    expect(shared[0].branches.sort()).toEqual(["main", "release/1.2.3"]);
    expect(shared[0].authorEmail).toBe("ada@example.com");
    expect(shared[0].githubLogin).toBe("ada");
    expect(shared[0].pullRequest?.number).toBe(12);
    expect(commits.map((commit) => commit.sha).sort()).toEqual(["same", "web1"]);
    expect(pulls.filter((path) => path.includes("/same/"))).toHaveLength(1);
    expect(commits.some((commit) => commit.sha === "merge1" || commit.sha === "bot1")).toBe(false);
  });

  it("passes a 24h since and a 7d since without code changes", async () => {
    const seen: string[] = [];
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/orgs/XDLAB-AI/repos") {
        return json([{ full_name: "XDLAB-AI/api", name: "api", default_branch: "main", html_url: "https://github.com/XDLAB-AI/api" }]);
      }
      if (parsed.pathname.endsWith("/branches")) return json([{ name: "main" }]);
      if (parsed.pathname.endsWith("/commits") && parsed.searchParams.has("since")) {
        seen.push(parsed.searchParams.get("since") ?? "");
        return json([]);
      }
      if (parsed.pathname.endsWith("/pulls")) return json([]);
      throw new Error(`unexpected ${url}`);
    });
    const base = { http, token: "token", org: "XDLAB-AI", apiBase: "https://api.github.com" };
    await collectGithub({ ...base, since: new Date(now.getTime() - day), until: now });
    await collectGithub({ ...base, since: new Date(now.getTime() - 7 * day), until: now });
    expect(seen[0]).toBe(new Date(now.getTime() - day).toISOString());
    expect(seen[1]).toBe(new Date(now.getTime() - 7 * day).toISOString());
  });

  it("throws on auth and rate limit instead of returning an empty window", async () => {
    const http = recorded(() => json({ message: "Bad credentials" }, 401));
    await expect(
      collectGithub({ http, token: "nope", org: "XDLAB-AI", apiBase: "https://api.github.com", since: now, until: now }),
    ).rejects.toBeInstanceOf(CollectorError);
    await expect(
      collectGithub({ http, token: "nope", org: "XDLAB-AI", apiBase: "https://api.github.com", since: now, until: now }),
    ).rejects.toThrow(/authentication failed/i);

    const limited = recorded(() => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }));
    await expect(
      collectGithub({ http: limited, token: "t", org: "XDLAB-AI", apiBase: "https://api.github.com", since: now, until: now }),
    ).rejects.toThrow(/rate limit/i);
  });

  it("treats an empty repository as no commits", async () => {
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/repos")) {
        return json([{ full_name: "XDLAB-AI/empty", name: "empty", default_branch: "main", html_url: "https://github.com/XDLAB-AI/empty" }]);
      }
      if (parsed.pathname.endsWith("/branches")) return json([{ name: "main" }]);
      if (parsed.pathname.endsWith("/commits")) return json({ message: "Git Repository is empty." }, 409);
      throw new Error(`unexpected ${url}`);
    });
    const commits = await collectGithub({
      http,
      token: "t",
      org: "XDLAB-AI",
      apiBase: "https://api.github.com",
      since: new Date(now.getTime() - day),
      until: now,
    });
    expect(commits).toEqual([]);
  });
});
