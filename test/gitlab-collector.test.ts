import { describe, expect, it } from "vitest";
import { collectGitlab } from "../src/collectors/gitlab.js";
import { CollectorError } from "../src/errors.js";
import { json, recorded } from "./helpers.js";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-21T10:00:00.000Z");
const since = new Date(now.getTime() - day);

function glCommit(input: { id: string; message: string; email: string; name: string; parents?: string[] }) {
  return {
    id: input.id,
    message: input.message,
    title: input.message.split("\n")[0],
    author_name: input.name,
    author_email: input.email,
    committed_date: "2026-11-21T09:00:00Z",
    parent_ids: input.parents ?? ["base"],
    diff: [{ old_path: "src/app.ts", new_path: "src/app.ts", diff: "@@\n+hello\n-old\n" }],
  };
}

describe("GitLab collector", () => {
  it("pages the group including subgroups, dedupes SHAs, and links merge requests", async () => {
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/groups/") && parsed.pathname.endsWith("/projects")) {
        expect(parsed.searchParams.get("include_subgroups")).toBe("true");
        const page = parsed.searchParams.get("page") ?? "1";
        if (page === "1") {
          return json(
            [{ id: 1, name: "app", path_with_namespace: "vgh-code/XdLabsAI-G42/app", web_url: "https://gitlab.com/g/app", default_branch: "main" }],
            200,
            { "x-next-page": "2" },
          );
        }
        return json([
          { id: 2, name: "nested", path_with_namespace: "vgh-code/XdLabsAI-G42/nested/app", web_url: "https://gitlab.com/g/nested", default_branch: "main" },
        ]);
      }
      if (parsed.pathname.endsWith("/repository/branches")) {
        return json([
          { name: "main", commit: { committed_date: "2026-01-01T00:00:00Z", author_email: "a@b.c" } },
          { name: "release/1.2.3", commit: { committed_date: "2026-01-01T00:00:00Z", author_email: "a@b.c" } },
          { name: "feature/skip", commit: { committed_date: "2026-11-21T09:00:00Z" } },
        ]);
      }
      if (parsed.pathname.endsWith("/repository/commits") && parsed.searchParams.has("ref_name")) {
        const branch = parsed.searchParams.get("ref_name");
        const project = parsed.pathname.split("/")[4];
        if (branch === "feature/skip") return json([glCommit({ id: "nope", message: "nope", email: "a@b.c", name: "A" })]);
        if (project === "2") return json([glCommit({ id: "nested1", message: "feat: nested", email: "ada@example.com", name: "Ada" })]);
        if (branch === "release/1.2.3") return json([glCommit({ id: "same", message: "feat: shared", email: "ada@example.com", name: "Ada" })]);
        return json([
          glCommit({ id: "same", message: "feat: shared", email: "ada@example.com", name: "Ada" }),
          glCommit({ id: "merge1", message: "Merge branch 'x' into 'main'", email: "ada@example.com", name: "Ada", parents: ["a", "b"] }),
          glCommit({ id: "bot1", message: "bump lock", email: "dependabot@example.com", name: "dependabot" }),
        ]);
      }
      if (parsed.pathname.includes("/commits/") && parsed.pathname.endsWith("/merge_requests")) {
        if (parsed.pathname.includes("/same/")) {
          return json([{ iid: 8, title: "Share the helper", description: "MR body", web_url: "https://gitlab.com/g/app/-/merge_requests/8", author: { username: "ada" } }]);
        }
        return json([]);
      }
      if (parsed.pathname.endsWith("/merge_requests")) return json([]);
      throw new Error(`unexpected ${url}`);
    });

    const { commits, releases } = await collectGitlab({
      http,
      token: "gl",
      baseUrl: "https://gitlab.com",
      group: "vgh-code/XdLabsAI-G42",
      since,
      until: now,
    });
    expect(http.urls.some((url) => url.includes("include_subgroups=true"))).toBe(true);
    expect(http.urls.some((url) => new URL(url).searchParams.get("ref_name") === "feature/skip")).toBe(false);
    const shared = commits.filter((commit) => commit.sha === "same");
    expect(shared).toHaveLength(1);
    expect(shared[0].branches.sort()).toEqual(["main", "release/1.2.3"]);
    expect(shared[0].mergeRequest?.iid).toBe(8);
    expect(shared[0].authorEmail).toBe("ada@example.com");
    expect(shared[0].files[0].additions).toBe(1);
    expect(shared[0].files[0].deletions).toBe(1);
    expect(commits.map((commit) => commit.sha).sort()).toEqual(["nested1", "same"]);
    expect(releases).toEqual([]);
  });

  it("counts release/x.y.z branches created or merged in the window", async () => {
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/groups/")) {
        return json([{ id: 7, name: "app", path_with_namespace: "vgh-code/XdLabsAI-G42/app", web_url: "https://gitlab.com/g/app", default_branch: "main" }]);
      }
      if (parsed.pathname.endsWith("/repository/branches")) {
        return json([
          { name: "main", commit: { committed_date: "2026-01-01T00:00:00Z", author_email: "old@example.com", author_name: "Old" } },
          { name: "release/1.2.3", web_url: "https://gitlab.com/g/app/-/tree/release/1.2.3", commit: { committed_date: "2026-11-21T08:00:00Z", author_email: "cut@example.com", author_name: "Cutter" } },
          { name: "release/0.1.0", commit: { committed_date: "2026-01-01T00:00:00Z", author_email: "old@example.com", author_name: "Old" } },
          { name: "release/1.2.3-rc1", commit: { committed_date: "2026-11-21T08:00:00Z", author_email: "rc@example.com" } },
          { name: "release/1.2", commit: { committed_date: "2026-11-21T08:00:00Z" } },
        ]);
      }
      if (parsed.pathname.endsWith("/repository/commits")) return json([]);
      if (parsed.pathname.endsWith("/merge_requests")) {
        return json([
          {
            iid: 3,
            title: "Ship 9.9.9",
            source_branch: "release/9.9.9",
            target_branch: "main",
            merged_at: "2026-11-21T09:30:00Z",
            web_url: "https://gitlab.com/g/app/-/merge_requests/3",
            merged_by: { username: "sam", name: "Sam" },
            author: { username: "sam" },
          },
          {
            iid: 4,
            title: "Old release",
            source_branch: "release/0.1.0",
            target_branch: "main",
            merged_at: "2026-01-02T00:00:00Z",
            merged_by: { username: "sam" },
          },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const { releases } = await collectGitlab({
      http,
      token: "gl",
      baseUrl: "https://gitlab.com",
      group: "vgh-code/XdLabsAI-G42",
      since,
      until: now,
    });
    const versions = releases.map((release) => release.version).sort();
    expect(versions).toEqual(["1.2.3", "9.9.9"]);
    const cut = releases.find((release) => release.version === "1.2.3");
    const merged = releases.find((release) => release.version === "9.9.9");
    expect(cut?.authorEmail).toBe("cut@example.com");
    expect(cut?.branch).toBe("release/1.2.3");
    expect(cut?.projectId).toBe("gitlab:vgh-code/XdLabsAI-G42/app");
    expect(merged?.gitlabUsername).toBe("sam");
    expect(merged?.timestamp).toBe("2026-11-21T09:30:00Z");
  });

  it("passes 24h and 7d since values and surfaces auth failures", async () => {
    const seen: string[] = [];
    const http = recorded((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/groups/")) {
        return json([{ id: 7, name: "app", path_with_namespace: "group/app", web_url: "https://gitlab.com/group/app", default_branch: "main" }]);
      }
      if (parsed.pathname.endsWith("/branches")) return json([{ name: "main", commit: {} }]);
      if (parsed.pathname.endsWith("/repository/commits")) {
        seen.push(parsed.searchParams.get("since") ?? "");
        return json([]);
      }
      if (parsed.pathname.endsWith("/merge_requests")) return json([]);
      throw new Error(`unexpected ${url}`);
    });
    const base = { http, token: "gl", baseUrl: "https://gitlab.com", group: "vgh-code/XdLabsAI-G42" };
    await collectGitlab({ ...base, since, until: now });
    await collectGitlab({ ...base, since: new Date(now.getTime() - 7 * day), until: now });
    expect(seen[0]).toBe(since.toISOString());
    expect(seen[1]).toBe(new Date(now.getTime() - 7 * day).toISOString());

    const denied = recorded(() => json({ message: "401 Unauthorized" }, 401));
    await expect(collectGitlab({ ...base, http: denied, since, until: now })).rejects.toBeInstanceOf(CollectorError);
    await expect(collectGitlab({ ...base, http: denied, since, until: now })).rejects.toThrow(/not an empty window/i);

    const missing = recorded(() => json({ message: "404 Group Not Found" }, 404));
    await expect(collectGitlab({ ...base, http: missing, since, until: now })).rejects.toThrow(/not an empty window/i);
  });
});
