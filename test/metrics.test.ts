import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import { loadAliases } from "../src/identity.js";
import { dedupeCommits, rollup, scoreCommits } from "../src/metrics.js";
import { compileDenyList, loadDenyList } from "../src/noise.js";
import { commit, file } from "./helpers.js";

const people = loadAliases(path.join(repoRoot(), "people", "aliases.yaml"));
const deny = compileDenyList(loadDenyList(path.join(repoRoot(), "config", "noise-deny.yaml")));

describe("activity metrics", () => {
  it("dedupes the same SHA on a default branch and a release branch", () => {
    const shared = commit({ sha: "abc123", branches: ["main"], files: [file("src/app.ts", 4, 1)] });
    const again = commit({ sha: "abc123", branches: ["release/1.2.0"], files: [file("src/app.ts", 4, 1)] });
    const scored = scoreCommits([shared, again], people, deny);
    expect(scored).toHaveLength(1);
    expect(scored[0].branches.sort()).toEqual(["main", "release/1.2.0"]);
    expect(scored[0].meaningfulLines).toBe(5);
  });

  it("dedupes a cherry-pick of the same change", () => {
    const original = commit({ sha: "abcdef0123456789", message: "fix: null check" });
    const picked = commit({
      sha: "9999ffff",
      message: "fix: null check\n\n(cherry picked from commit abcdef0)",
      branches: ["release/1.2.0"],
    });
    const scored = scoreCommits([original, picked], people, deny);
    expect(scored).toHaveLength(1);
    expect(dedupeCommits([original, picked])[0].sha).toBe("abcdef0123456789");
  });

  it("drops merge and bot commits from both totals", () => {
    const human = commit({ sha: "human", files: [file("src/app.ts", 3, 0)] });
    const merge = commit({
      sha: "merge",
      parentCount: 2,
      message: "Merge pull request #9 from feature",
      files: [file("src/app.ts", 5000, 0)],
    });
    const bot = commit({
      sha: "bot",
      githubLogin: "dependabot[bot]",
      authorType: "Bot",
      authorName: "dependabot[bot]",
      files: [file("src/app.ts", 80, 0)],
    });
    const scored = scoreCommits([human, merge, bot], people, deny);
    expect(scored.map((item) => item.sha)).toEqual(["human"]);
    const rolled = rollup(scored, []);
    expect(rolled.people[0].rawLines).toBe(3);
    expect(rolled.people[0].meaningfulLines).toBe(3);
  });

  it("keeps a human noreply email that is not a bot", () => {
    const scored = scoreCommits(
      [commit({ sha: "noreply", githubLogin: "someone", authorEmail: "123+someone@users.noreply.github.com", authorName: "Someone" })],
      people,
      deny,
    );
    expect(scored).toHaveLength(1);
    expect(scored[0].unmapped).toBe(true);
    expect(scored[0].personId).toContain("someone");
  });

  it("rolls an unmapped author up under a flagged identity", () => {
    const scored = scoreCommits(
      [
        commit({
          sha: "stranger",
          githubLogin: "stranger",
          authorEmail: "stranger@example.com",
          authorName: "Stranger",
          files: [file("src/app.ts", 2, 2)],
        }),
      ],
      people,
      deny,
    );
    const rolled = rollup(scored, []);
    expect(rolled.people).toHaveLength(1);
    expect(rolled.people[0].unmapped).toBe(true);
    expect(rolled.people[0].personId).toBe("unmapped:github:stranger");
    expect(rolled.people[0].commits).toBe(1);
    expect(rolled.projects[0].contributors[0].personId).toBe("unmapped:github:stranger");
  });

  it("attributes a GitLab release and does not double-count lines", () => {
    const scored = scoreCommits([commit({ sha: "once", files: [file("package-lock.json", 1000, 0), file("src/a.ts", 5, 0)] })], people, deny);
    const rolled = rollup(scored, [
      {
        source: "gitlab",
        projectId: "gitlab:vgh-code/XdLabsAI-G42-AppBuilder/app",
        projectName: "app",
        version: "1.2.0",
        branch: "release/1.2.0",
        timestamp: "2026-11-21T08:00:00Z",
        authorName: "Xiaodong Zhou",
        authorEmail: "262348385+xdlab2026@users.noreply.github.com",
        gitlabUsername: null,
        url: null,
        personId: "xiaodong-zhou",
        displayName: "Xiaodong Zhou",
        unmapped: false,
      },
    ]);
    const person = rolled.people.find((item) => item.personId === "xiaodong-zhou");
    expect(person?.meaningfulLines).toBe(5);
    expect(person?.rawLines).toBe(1005);
    expect(person?.releases.map((release) => release.version)).toEqual(["1.2.0"]);
    const project = rolled.projects.find((item) => item.projectId.startsWith("gitlab:"));
    expect(project?.releaseCount).toBe(1);
    expect(project?.source).toBe("gitlab");
  });
});
