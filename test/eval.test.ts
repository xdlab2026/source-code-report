import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import { loadFixtures, scoreFixtures } from "../src/eval.js";

describe("eval fixtures", () => {
  const fixtures = loadFixtures();
  const score = scoreFixtures(fixtures);

  it("covers both sources, the category set, and sizes, including a small hard change", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(score.sources.sort()).toEqual(["github", "gitlab"]);
    for (const category of ["feature", "bugfix", "refactor", "test", "docs", "config/infra", "dependency", "release"]) {
      expect(score.categories).toContain(category);
    }
    expect(score.sizes.sort()).toEqual(["L", "M", "S", "XL"]);
    expect(score.hasSmallHighComplexity).toBe(true);
  });

  it("scores category and complexity agreement at or above 80% and documents every miss", () => {
    expect(score.bothAgreement).toBeGreaterThanOrEqual(0.8);
    expect(score.categoryAgreement).toBeGreaterThanOrEqual(0.8);
    expect(score.complexityAgreement).toBeGreaterThanOrEqual(0.8);
    const gaps = readFileSync(path.join(repoRoot(), "eval", "gaps.md"), "utf8");
    expect(score.failures.length).toBeGreaterThan(0);
    for (const failure of score.failures) expect(gaps).toContain(failure.id);
    expect(gaps.toLowerCase()).toContain("no live eval");
  });
});
