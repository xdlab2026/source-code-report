import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { FileChange } from "./model.js";

const denySchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["lockfile", "generated", "vendored"]),
      pattern: z.string().min(1),
    }),
  ),
});

export interface DenyRule {
  id: string;
  kind: "lockfile" | "generated" | "vendored";
  pattern: string;
}

export interface DenyMatch {
  denied: boolean;
  ruleId?: string;
  kind?: DenyRule["kind"];
}

export interface LineScore {
  rawAdditions: number;
  rawDeletions: number;
  meaningfulAdditions: number;
  meaningfulDeletions: number;
  rawLines: number;
  meaningfulLines: number;
}

export function loadDenyList(file: string): DenyRule[] {
  const parsed = denySchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid deny list ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data.rules;
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source, "i");
}

export function compileDenyList(rules: DenyRule[]): (filePath: string) => DenyMatch {
  const compiled = rules.map((rule) => ({ rule, expression: globToRegExp(rule.pattern) }));
  return (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    for (const item of compiled) {
      if (item.expression.test(normalized)) {
        return { denied: true, ruleId: item.rule.id, kind: item.rule.kind };
      }
    }
    return { denied: false };
  };
}

export function scoreFiles(files: FileChange[], deny: (filePath: string) => DenyMatch): LineScore {
  let rawAdditions = 0;
  let rawDeletions = 0;
  let meaningfulAdditions = 0;
  let meaningfulDeletions = 0;
  for (const file of files) {
    rawAdditions += file.additions;
    rawDeletions += file.deletions;
    if (!deny(file.path).denied) {
      meaningfulAdditions += file.additions;
      meaningfulDeletions += file.deletions;
    }
  }
  return {
    rawAdditions,
    rawDeletions,
    meaningfulAdditions,
    meaningfulDeletions,
    rawLines: rawAdditions + rawDeletions,
    meaningfulLines: meaningfulAdditions + meaningfulDeletions,
  };
}

export function countUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
