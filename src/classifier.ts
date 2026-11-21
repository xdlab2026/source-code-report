import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CostTracker } from "./cost.js";
import { asRecord } from "./json.js";
import type { ChangeUnit } from "./units.js";

export const CATEGORIES = ["feature", "bugfix", "refactor", "test", "docs", "config/infra", "dependency", "release"] as const;
export const SIZES = ["S", "M", "L", "XL"] as const;
export const COMPLEXITIES = ["low", "med", "high"] as const;
export const RISK_FLAGS = ["auth/data touched", "no tests", "large untested change"] as const;

export const classificationSchema = z.object({
  category: z.enum(CATEGORIES),
  size: z.enum(SIZES),
  complexity: z.enum(COMPLEXITIES),
  risk_flags: z.array(z.enum(RISK_FLAGS)),
  summary: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => !value.includes("\n") && !value.includes("\r"), "summary must be one line"),
});

export type Classification = z.infer<typeof classificationSchema>;

export interface ClassifiedUnit extends ChangeUnit {
  classification: Classification | null;
  classificationStatus: "ok" | "failed";
  classificationError: string | null;
}

export interface LlmMessage {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(input: LlmMessage): Promise<LlmResult>;
}

export function loadClassificationSchemaDocument(): unknown {
  return JSON.parse(readFileSync(new URL("../schema/classification.json", import.meta.url), "utf8"));
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model response did not contain a JSON object");
  return JSON.parse(raw.slice(start, end + 1)) as unknown;
}

export function trimDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, Math.max(0, maxChars))}\n[diff trimmed]`;
}

export function buildClassifyUserPrompt(unit: ChangeUnit, maxInputChars: number): string {
  const diffBudget = Math.max(500, maxInputChars);
  const diff = trimDiff(unit.diff, diffBudget);
  return [
    "CHANGE_UNIT",
    `id: ${unit.id}`,
    `type: ${unit.type}`,
    `project: ${unit.projectName}`,
    `meaningful_lines: ${unit.meaningfulLines}`,
    `raw_lines: ${unit.rawLines}`,
    `title: ${unit.title}`,
    "description:",
    unit.description || "(none)",
    "diff:",
    diff || "(no meaningful diff)",
  ].join("\n");
}

export async function classifyUnit(
  unit: ChangeUnit,
  client: LlmClient,
  options: {
    system: string;
    model: string;
    maxInputChars: number;
    maxOutputTokens: number;
    maxRetries: number;
    cost: CostTracker;
  },
): Promise<ClassifiedUnit> {
  const base = buildClassifyUserPrompt(unit, options.maxInputChars);
  let lastError = "invalid response";
  const attempts = options.maxRetries + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const user =
      attempt === 0
        ? base
        : `${base}\n\nThe previous response failed validation: ${lastError}\nReturn only a JSON object matching the schema.`;
    const response = await client.complete({
      system: options.system,
      user,
      model: options.model,
      maxTokens: options.maxOutputTokens,
    });
    options.cost.add(response.inputTokens, response.outputTokens);
    try {
      const parsed = normalizeClassification(extractJson(response.text));
      return { ...unit, classification: parsed, classificationStatus: "ok", classificationError: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ...unit, classification: null, classificationStatus: "failed", classificationError: lastError };
}

export function normalizeClassification(value: unknown): Classification {
  const record = asRecord(value);
  if (record && typeof record.summary === "string") record.summary = record.summary.trim();
  if (record && Array.isArray(record.risk_flags)) {
    record.risk_flags = [...new Set(record.risk_flags)];
  }
  return classificationSchema.parse(record ?? value);
}

export async function classifyAll(
  units: ChangeUnit[],
  client: LlmClient,
  options: {
    system: string;
    model: string;
    maxInputChars: number;
    maxOutputTokens: number;
    maxRetries: number;
    cost: CostTracker;
  },
): Promise<ClassifiedUnit[]> {
  const classified: ClassifiedUnit[] = [];
  for (const unit of units) classified.push(await classifyUnit(unit, client, options));
  return classified;
}
