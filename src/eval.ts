import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { classificationSchema } from "./classifier.js";
import { repoRoot } from "./config.js";

const fixtureSchema = z.object({
  id: z.string(),
  source: z.enum(["github", "gitlab"]),
  kind: z.enum(["pull_request", "merge_request", "commit"]),
  title: z.string(),
  description: z.string(),
  diff: z.string(),
  meaningfulLines: z.number().int().nonnegative(),
  gold: classificationSchema,
  model_output: classificationSchema,
});

export type EvalFixture = z.infer<typeof fixtureSchema>;

export interface EvalScore {
  items: number;
  categoryAgreed: number;
  complexityAgreed: number;
  bothAgreed: number;
  categoryAgreement: number;
  complexityAgreement: number;
  bothAgreement: number;
  failures: { id: string; goldCategory: string; predictedCategory: string; goldComplexity: string; predictedComplexity: string }[];
  sources: string[];
  categories: string[];
  sizes: string[];
  hasSmallHighComplexity: boolean;
}

export function loadFixtures(file = path.join(repoRoot(), "eval", "fixtures.json")): EvalFixture[] {
  const parsed = z.array(fixtureSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  return parsed;
}

export function scoreFixtures(fixtures: EvalFixture[]): EvalScore {
  let categoryAgreed = 0;
  let complexityAgreed = 0;
  let bothAgreed = 0;
  const failures: EvalScore["failures"] = [];
  for (const fixture of fixtures) {
    const category = fixture.gold.category === fixture.model_output.category;
    const complexity = fixture.gold.complexity === fixture.model_output.complexity;
    if (category) categoryAgreed += 1;
    if (complexity) complexityAgreed += 1;
    if (category && complexity) bothAgreed += 1;
    else {
      failures.push({
        id: fixture.id,
        goldCategory: fixture.gold.category,
        predictedCategory: fixture.model_output.category,
        goldComplexity: fixture.gold.complexity,
        predictedComplexity: fixture.model_output.complexity,
      });
    }
  }
  const items = fixtures.length;
  return {
    items,
    categoryAgreed,
    complexityAgreed,
    bothAgreed,
    categoryAgreement: items === 0 ? 0 : categoryAgreed / items,
    complexityAgreement: items === 0 ? 0 : complexityAgreed / items,
    bothAgreement: items === 0 ? 0 : bothAgreed / items,
    failures,
    sources: [...new Set(fixtures.map((fixture) => fixture.source))],
    categories: [...new Set(fixtures.map((fixture) => fixture.gold.category))],
    sizes: [...new Set(fixtures.map((fixture) => fixture.gold.size))],
    hasSmallHighComplexity: fixtures.some((fixture) => fixture.gold.size === "S" && fixture.gold.complexity === "high"),
  };
}

export function formatScore(score: EvalScore): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `items: ${score.items}`,
    `category agreement: ${percent(score.categoryAgreement)} (${score.categoryAgreed}/${score.items})`,
    `complexity agreement: ${percent(score.complexityAgreement)} (${score.complexityAgreed}/${score.items})`,
    `both: ${percent(score.bothAgreement)} (${score.bothAgreed}/${score.items})`,
  ];
  if (score.failures.length === 0) {
    lines.push("gaps: none");
  } else {
    lines.push("gaps:");
    for (const failure of score.failures) {
      lines.push(
        `- ${failure.id} gold ${failure.goldCategory}/${failure.goldComplexity} predicted ${failure.predictedCategory}/${failure.predictedComplexity}`,
      );
    }
  }
  lines.push("note: model_output values are checked-in fixtures so this score runs without an API key. A live Anthropic score has not been recorded.");
  return lines.join("\n");
}
