import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassifiedUnit } from "../src/classifier.js";
import { repoRoot } from "../src/config.js";
import { renderCsv } from "../src/csv.js";
import { loadAliases } from "../src/identity.js";
import { scoreCommits } from "../src/metrics.js";
import { compileDenyList, loadDenyList } from "../src/noise.js";
import { buildReport, formatDigest } from "../src/report.js";
import { buildChangeUnits } from "../src/units.js";
import { resolveWindow } from "../src/window.js";
import { commit, file } from "./helpers.js";

const people = loadAliases(path.join(repoRoot(), "people", "aliases.yaml"));
const deny = compileDenyList(loadDenyList(path.join(repoRoot(), "config", "noise-deny.yaml")));
const now = new Date("2026-11-21T10:00:00Z");

function classified(partial: Partial<ClassifiedUnit> & Pick<ClassifiedUnit, "id" | "title" | "personId" | "displayName">): ClassifiedUnit {
  return {
    type: "commit",
    description: "",
    url: "https://example.com",
    source: "github",
    projectId: "github:XDLAB-AI/api",
    projectName: "api",
    unmapped: false,
    commits: ["abc"],
    files: [],
    meaningfulLines: 10,
    rawLines: 10,
    diff: "",
    classification: {
      category: "feature",
      size: "S",
      complexity: "low",
      risk_flags: [],
      summary: partial.title,
    },
    classificationStatus: "ok",
    classificationError: null,
    ...partial,
  };
}

describe("report builder", () => {
  it("groups pull requests ahead of bare commits and drops lockfile diffs", () => {
    const shared = {
      pullRequest: {
        number: 4,
        title: "Add export",
        description: "CSV export",
        url: "https://github.com/XDLAB-AI/api/pull/4",
        authorLogin: "xdlab2026",
      },
    };
    const scored = scoreCommits(
      [
        commit({ sha: "a", message: "wip", files: [file("src/a.ts", 4, 0), { path: "package-lock.json", additions: 100, deletions: 0, patch: "+lock" }], ...shared }),
        commit({ sha: "b", message: "wip 2", files: [file("src/b.ts", 2, 0)], ...shared }),
        commit({
          sha: "c",
          message: "docs: readme\n\nMore detail",
          files: [file("README.md", 3, 0)],
          pullRequest: null,
          githubLogin: "stranger",
          authorEmail: "stranger@example.com",
          authorName: "Stranger",
        }),
      ],
      people,
      deny,
    );
    const units = buildChangeUnits(scored, people, deny);
    expect(units).toHaveLength(2);
    const pull = units.find((unit) => unit.type === "pull_request");
    expect(pull?.title).toBe("Add export");
    expect(pull?.commits).toHaveLength(2);
    expect(pull?.diff).not.toContain("+lock");
    expect(pull?.diff).toContain("src/a.ts");
    expect(pull?.personId).toBe("xiaodong-zhou");
    const bare = units.find((unit) => unit.type === "commit");
    expect(bare?.title).toBe("docs: readme");
    expect(bare?.unmapped).toBe(true);
  });

  it("builds alphabetical per-person and per-project sections for both windows", () => {
    const amy = commit({
      sha: "amy",
      githubLogin: "amy",
      authorName: "Amy Zee",
      authorEmail: "amy@example.com",
      projectId: "github:XDLAB-AI/web",
      projectName: "web",
      files: [file("src/web.ts", 1, 0)],
    });
    const zara = commit({
      sha: "zara",
      githubLogin: "zara",
      authorName: "Zara Zee",
      authorEmail: "zara@example.com",
      files: [file("src/api.ts", 40, 0)],
    });
    const scored = scoreCommits([amy, zara], people, deny);
    const units: ClassifiedUnit[] = [
      classified({
        id: "github:XDLAB-AI/web@amy",
        title: "Amy's change",
        personId: scored.find((item) => item.authorName === "Amy Zee")!.personId,
        displayName: "Amy Zee",
        projectId: "github:XDLAB-AI/web",
        projectName: "web",
        source: "github",
        classification: { category: "docs", size: "S", complexity: "low", risk_flags: [], summary: "Docs." },
      }),
      classified({
        id: "github:XDLAB-AI/api@zara",
        title: "Touch auth",
        personId: scored.find((item) => item.authorName === "Zara Zee")!.personId,
        displayName: "Zara Zee",
        classification: { category: "bugfix", size: "M", complexity: "high", risk_flags: ["auth/data touched"], summary: "Fixes auth." },
      }),
    ];
    const activityPeople = [
      {
        personId: "unmapped:github:amy",
        displayName: "Amy Zee",
        unmapped: true,
        projects: ["github:XDLAB-AI/web"],
        commits: 1,
        rawAdditions: 1,
        rawDeletions: 0,
        meaningfulAdditions: 1,
        meaningfulDeletions: 0,
        rawLines: 1,
        meaningfulLines: 1,
        releases: [],
      },
      {
        personId: "unmapped:github:zara",
        displayName: "Zara Zee",
        unmapped: true,
        projects: ["github:XDLAB-AI/api"],
        commits: 50,
        rawAdditions: 40,
        rawDeletions: 0,
        meaningfulAdditions: 40,
        meaningfulDeletions: 0,
        rawLines: 40,
        meaningfulLines: 40,
        releases: [{ projectId: "gitlab:group/app", projectName: "app", version: "1.2.0" }],
      },
    ];
    const projects = [
      {
        projectId: "github:XDLAB-AI/api",
        projectName: "api",
        source: "github" as const,
        contributors: [{ personId: "unmapped:github:zara", displayName: "Zara Zee" }],
        commits: 50,
        rawAdditions: 40,
        rawDeletions: 0,
        meaningfulAdditions: 40,
        meaningfulDeletions: 0,
        rawLines: 40,
        meaningfulLines: 40,
        releaseCount: 0,
        releases: [],
      },
      {
        projectId: "github:XDLAB-AI/web",
        projectName: "web",
        source: "github" as const,
        contributors: [{ personId: "unmapped:github:amy", displayName: "Amy Zee" }],
        commits: 1,
        rawAdditions: 1,
        rawDeletions: 0,
        meaningfulAdditions: 1,
        meaningfulDeletions: 0,
        rawLines: 1,
        meaningfulLines: 1,
        releaseCount: 0,
        releases: [],
      },
      {
        projectId: "gitlab:group/app",
        projectName: "app",
        source: "gitlab" as const,
        contributors: [{ personId: "unmapped:github:zara", displayName: "Zara Zee" }],
        commits: 0,
        rawAdditions: 0,
        rawDeletions: 0,
        meaningfulAdditions: 0,
        meaningfulDeletions: 0,
        rawLines: 0,
        meaningfulLines: 0,
        releaseCount: 1,
        releases: [{ version: "1.2.0", personId: "unmapped:github:zara", displayName: "Zara Zee" }],
      },
    ];
    const report = buildReport({
      window: resolveWindow({ preset: "24h", now }),
      timezone: "Europe/Malta",
      destination: "dm",
      destinationId: "U0AFYENA7UJ",
      narrative: "The API auth bug was fixed and a release was cut.",
      runKey: "24h|2026-11-21T11|dm|U0AFYENA7UJ",
      people: activityPeople,
      projects,
      units,
      llm: { inputTokens: 10, outputTokens: 5, calls: 1, estimatedUsd: 0.0001 },
    });
    expect(report.people.map((person) => person.displayName)).toEqual(["Amy Zee", "Zara Zee"]);
    expect(report.people[1].commits).toBe(50);
    expect(report.people[1].highComplexity).toBe(1);
    expect(report.people[1].releases[0].version).toBe("1.2.0");
    expect(report.people[1].categoryMix.bugfix).toBe(1);
    expect(report.projects.find((project) => project.source === "gitlab")?.releaseCount).toBe(1);
    expect(report.projects.find((project) => project.projectId === "github:XDLAB-AI/api")?.risks[0].flags).toEqual(["auth/data touched"]);
    expect(report.markdown).toContain("past 24 hours");
    expect(report.markdown).toContain("## Narrative");
    expect(report.markdown.toLowerCase()).not.toContain("leaderboard");
    const week = buildReport({
      window: resolveWindow({ preset: "7d", now }),
      timezone: "Europe/Malta",
      destination: "channel",
      destinationId: "C123",
      narrative: "A quiet week.",
      runKey: "7d|bucket|channel|C123",
      people: [],
      projects: [],
      units: [],
      llm: { inputTokens: 0, outputTokens: 0, calls: 0, estimatedUsd: 0 },
    });
    expect(week.windowPhrase).toBe("last week");
    expect(week.markdown).toContain("last week");
    expect(week.people).toEqual([]);

    const digest = formatDigest(report);
    expect(digest).toContain("past 24 hours");
    expect(digest).toContain("The PDF has the overview");
    expect(digest).not.toContain("*People*");
    expect(digest).toContain("report-key:");

    const csv = renderCsv(report);
    expect(csv.split("\n")[0]).toContain("meaningful_lines");
    expect(csv).toContain("change_unit");
    expect(csv).toContain("person");
    expect(csv).toContain("project");
    expect(csv).toContain("bugfix");
    expect(csv).toContain("auth/data touched");
  });
});
