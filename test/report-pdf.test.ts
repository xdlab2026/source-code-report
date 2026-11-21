import { describe, expect, it } from "vitest";
import type { ClassifiedUnit } from "../src/classifier.js";
import { emptyIdentityMapping } from "../src/identity.js";
import { emptyMix, GITLAB_OMITTED_NOTE, type Report } from "../src/report.js";
import { personEffort, projectContributors, renderPdf, renderReportHtml } from "../src/report-pdf.js";

function unit(partial: Partial<ClassifiedUnit> & Pick<ClassifiedUnit, "id" | "title" | "personId" | "displayName" | "projectId" | "projectName" | "meaningfulLines">): ClassifiedUnit {
  return {
    type: "pull_request",
    description: "",
    url: "https://github.com/XDLAB-AI/api/pull/1",
    source: "github",
    unmapped: false,
    toolOnly: false,
    authors: [],
    commits: ["abc"],
    files: [],
    rawLines: partial.meaningfulLines,
    diff: "",
    classification: {
      category: "feature",
      size: "M",
      complexity: "med",
      risk_flags: partial.title === "Auth" ? ["auth/data touched"] : [],
      summary: "Shipped the change.",
    },
    classificationStatus: "ok",
    classificationError: null,
    ...partial,
  };
}

function report(): Report {
  const units = [
    unit({ id: "pr-1", title: "Auth", personId: "ada", displayName: "Ada", projectId: "github:XDLAB-AI/api", projectName: "api", meaningfulLines: 30, rawLines: 40 }),
    unit({ id: "pr-2", title: "Docs", personId: "ada", displayName: "Ada", projectId: "github:XDLAB-AI/web", projectName: "web", meaningfulLines: 10, rawLines: 10, type: "commit" }),
  ];
  const mix = { ...emptyMix(), feature: 1 };
  return {
    window: "7d",
    windowPhrase: "last week",
    timezone: "Europe/Malta",
    since: "2026-11-14T06:00:00.000Z",
    until: "2026-11-21T06:00:00.000Z",
    sinceLabel: "14/11/2026, 07:00",
    untilLabel: "21/11/2026, 07:00",
    destination: "dm",
    destinationId: "U0AFYENA7UJ",
    narrative: "The api project took the auth work.",
    runKey: "7d|2026-11-21T06|dm|U0AFYENA7UJ",
    notes: [GITLAB_OMITTED_NOTE],
    identityMapping: emptyIdentityMapping(),
    markdown: "",
    llm: { calls: 2, inputTokens: 10, outputTokens: 4, estimatedUsd: 0.01 },
    people: [
      {
        personId: "ada",
        displayName: "Ada",
        unmapped: false,
        projects: ["api", "web"],
        commits: 2,
        rawAdditions: 50,
        rawDeletions: 0,
        meaningfulAdditions: 40,
        meaningfulDeletions: 0,
        rawLines: 50,
        meaningfulLines: 40,
        releases: [],
        categoryMix: mix,
        highComplexity: 0,
      },
    ],
    projects: [
      {
        projectId: "github:XDLAB-AI/api",
        projectName: "api",
        source: "github",
        contributors: [{ personId: "ada", displayName: "Ada" }],
        commits: 1,
        rawAdditions: 40,
        rawDeletions: 0,
        meaningfulAdditions: 30,
        meaningfulDeletions: 0,
        rawLines: 40,
        meaningfulLines: 30,
        releaseCount: 0,
        releases: [],
        categoryMix: mix,
        risks: [{ unitId: "pr-1", title: "Auth", url: "https://example.com", flags: ["auth/data touched"] }],
      },
      {
        projectId: "github:XDLAB-AI/web",
        projectName: "web",
        source: "github",
        contributors: [{ personId: "ada", displayName: "Ada" }],
        commits: 1,
        rawAdditions: 10,
        rawDeletions: 0,
        meaningfulAdditions: 10,
        meaningfulDeletions: 0,
        rawLines: 10,
        meaningfulLines: 10,
        releaseCount: 0,
        releases: [],
        categoryMix: { ...emptyMix(), docs: 1 },
        risks: [],
      },
    ],
    changeUnits: units,
  };
}

describe("PDF report", () => {
  it("splits a person's effort by share and absolute lines", () => {
    const built = report();
    const effort = personEffort(built, "ada");
    expect(effort.map((slice) => [slice.projectName, slice.meaningfulLines, slice.share])).toEqual([
      ["api", 30, 0.75],
      ["web", 10, 0.25],
    ]);
    expect(projectContributors(built, "github:XDLAB-AI/api")[0]?.share).toBe(1);
  });

  it("rounds effort shares so they add up to 100 percent", () => {
    const built = report();
    built.changeUnits = [
      unit({ id: "a", title: "A", personId: "ada", displayName: "Ada", projectId: "github:XDLAB-AI/dx-portal", projectName: "dx-portal", meaningfulLines: 1578 }),
      unit({ id: "b", title: "B", personId: "ada", displayName: "Ada", projectId: "github:XDLAB-AI/eqwep", projectName: "eqwep-ai-insights", meaningfulLines: 3007 }),
      unit({ id: "c", title: "C", personId: "ada", displayName: "Ada", projectId: "github:XDLAB-AI/tessera", projectName: "tessera-build-aws", meaningfulLines: 15940 }),
    ];
    const percents = personEffort(built, "ada").map((slice) => Math.round(slice.share * 100));
    expect(percents).toEqual([8, 14, 78]);
    expect(percents.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("renders overview, every project, and every person without a change-unit table", () => {
    const html = renderReportHtml(report());
    expect(html).toContain("1. Overview");
    expect(html).toContain("2. Projects");
    expect(html).toContain("3. People");
    expect(html).toContain("4. Identity mapping");
    expect(html).toContain("No new identities.");
    expect(html).toContain("last week");
    expect(html).toContain(GITLAB_OMITTED_NOTE);
    expect(html).toContain("Standout projects");
    expect(html).toContain("Share of their lines");
    expect(html).toContain("75%");
    expect(html).toContain("Pull request");
    expect(html).toContain("auth/data touched");
    expect(html).toContain("INTELLIGENCE ENGINEERED");
    expect(html).not.toContain("change_unit");
    expect(html.toLowerCase()).not.toContain("leaderboard");
  });

  it("shows an applied alias and a paste-ready snippet for an uncredited tool", () => {
    const built = report();
    built.identityMapping = {
      applied: [
        {
          personId: "xiaodong-zhou",
          displayName: "Xiaodong Zhou",
          rows: [{ seen: "Watson X <watsonx@localhost>", via: "email alias", commits: 2 }],
        },
      ],
      unmapped: [
        {
          personId: "unmapped:tool:noreply@anthropic.com",
          displayName: "Claude",
          emails: ["noreply@anthropic.com"],
          githubLogins: ["claude"],
          gitlabUsernames: [],
          projects: ["people-wiki"],
          commits: 2,
          tool: true,
          snippet: "  - id: claude\n    display_name: Claude\n    emails:\n      - noreply@anthropic.com\n    github_logins:\n      - claude\n    gitlab_usernames: []",
        },
      ],
    };
    const html = renderReportHtml(built);
    expect(html).toContain("Aliases applied");
    expect(html).toContain("Watson X &lt;watsonx@localhost&gt;");
    expect(html).toContain("Xiaodong Zhou");
    expect(html).toContain("email alias");
    expect(html).toContain("New identities");
    expect(html).toContain("Not credited to a person.");
    expect(html).toContain("noreply@anthropic.com");
    expect(html).toContain("people-wiki");
  });

  it("prints a PDF with Chrome", async () => {
    const pdf = await renderPdf(renderReportHtml(report()));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
