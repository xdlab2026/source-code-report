import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  COMPLEXITIES,
  RISK_FLAGS,
  SIZES,
  buildClassifyUserPrompt,
  classificationSchema,
  classifyUnit,
  loadClassificationSchemaDocument,
  type LlmClient,
} from "../src/classifier.js";
import { repoRoot } from "../src/config.js";
import { createCostTracker } from "../src/cost.js";
import type { ChangeUnit } from "../src/units.js";

const unit: ChangeUnit = {
  id: "github:XDLAB-AI/api#12",
  type: "pull_request",
  title: "Fix a null deref in the permission check",
  description: "A missing user crashed the check.",
  url: "https://github.com/XDLAB-AI/api/pull/12",
  source: "github",
  projectId: "github:XDLAB-AI/api",
  projectName: "api",
  personId: "xiaodong-zhou",
  displayName: "Xiaodong Zhou",
  unmapped: false,
  toolOnly: false,
  authors: [],
  commits: ["abc"],
  files: [],
  meaningfulLines: 12,
  rawLines: 12,
  diff: "x".repeat(20_000),
};

function client(responses: string[]): LlmClient & { calls: number } {
  return {
    calls: 0,
    async complete() {
      const text = responses[this.calls] ?? responses[responses.length - 1];
      this.calls += 1;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
  };
}

const valid = {
  category: "bugfix",
  size: "S",
  complexity: "high",
  risk_flags: ["auth/data touched"],
  summary: "Fixes a crash in the permission check.",
};

describe("classifier", () => {
  it("accepts a small high-complexity label and rejects an unknown category", () => {
    expect(classificationSchema.parse(valid)).toMatchObject({ size: "S", complexity: "high" });
    expect(() => classificationSchema.parse({ ...valid, category: "chore" })).toThrow();
    expect(() => classificationSchema.parse({ ...valid, summary: "line\nbreak" })).toThrow();
  });

  it("keeps the checked-in JSON schema in sync", () => {
    const document = loadClassificationSchemaDocument() as {
      properties: {
        category: { enum: string[] };
        size: { enum: string[] };
        complexity: { enum: string[] };
        risk_flags: { items: { enum: string[] } };
      };
    };
    expect(document.properties.category.enum).toEqual([...CATEGORIES]);
    expect(document.properties.size.enum).toEqual([...SIZES]);
    expect(document.properties.complexity.enum).toEqual([...COMPLEXITIES]);
    expect(document.properties.risk_flags.items.enum).toEqual([...RISK_FLAGS]);
  });

  it("trims an oversized diff and still classifies", () => {
    const prompt = buildClassifyUserPrompt(unit, 800);
    expect(prompt).toContain("[diff trimmed]");
    expect(prompt.length).toBeLessThan(unit.diff.length);
    expect(prompt).toContain(unit.title);
  });

  it("retries invalid JSON once and then marks the unit failed", async () => {
    const cost = createCostTracker({ inputPerMillion: 3, outputPerMillion: 15 });
    const flaky = client(["not json", JSON.stringify(valid)]);
    const classified = await classifyUnit(unit, flaky, {
      system: "return json",
      model: "test-model",
      maxInputChars: 1000,
      maxOutputTokens: 200,
      maxRetries: 1,
      cost,
    });
    expect(flaky.calls).toBe(2);
    expect(classified.classificationStatus).toBe("ok");
    expect(classified.classification?.complexity).toBe("high");
    expect(cost.calls).toBe(2);
    expect(cost.estimatedUsd).toBeGreaterThan(0);

    const broken = client(["nope", "still nope"]);
    const failed = await classifyUnit(unit, broken, {
      system: "return json",
      model: "test-model",
      maxInputChars: 1000,
      maxOutputTokens: 200,
      maxRetries: 1,
      cost,
    });
    expect(broken.calls).toBe(2);
    expect(failed.classificationStatus).toBe("failed");
    expect(failed.classification).toBeNull();
  });

  it("asks the narrative to name standout work without a leaderboard", () => {
    const prompt = readFileSync(path.join(repoRoot(), "prompts", "narrative.md"), "utf8").toLowerCase();
    expect(prompt).toContain("leaderboard");
    expect(prompt).toContain("standout");
    expect(prompt).toContain("past 24 hours");
    expect(prompt).toContain("last week");
    expect(prompt).not.toContain("do not rank");
  });
});
