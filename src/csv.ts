import type { Report } from "./report.js";
import { formatMix } from "./report.js";

const COLUMNS = [
  "section",
  "window",
  "source",
  "project",
  "unit_id",
  "unit_type",
  "title",
  "url",
  "person_id",
  "person_name",
  "unmapped",
  "commits",
  "raw_additions",
  "raw_deletions",
  "meaningful_additions",
  "meaningful_deletions",
  "raw_lines",
  "meaningful_lines",
  "category",
  "size",
  "complexity",
  "risk_flags",
  "summary",
  "classification_status",
  "projects",
  "contributors",
  "category_mix",
  "high_complexity",
  "release_count",
  "releases",
] as const;

export function renderCsv(report: Report): string {
  const window = `${report.since}/${report.until}`;
  const rows: Record<string, string | number>[] = [];
  for (const unit of report.changeUnits) {
    rows.push({
      section: "change_unit",
      window,
      source: unit.source,
      project: unit.projectId,
      unit_id: unit.id,
      unit_type: unit.type,
      title: unit.title,
      url: unit.url,
      person_id: unit.personId,
      person_name: unit.displayName,
      unmapped: String(unit.unmapped),
      commits: unit.commits.length,
      raw_lines: unit.rawLines,
      meaningful_lines: unit.meaningfulLines,
      category: unit.classification?.category ?? "",
      size: unit.classification?.size ?? "",
      complexity: unit.classification?.complexity ?? "",
      risk_flags: unit.classification?.risk_flags.join("|") ?? "",
      summary: unit.classification?.summary ?? "",
      classification_status: unit.classificationStatus,
    });
  }
  for (const person of report.people) {
    rows.push({
      section: "person",
      window,
      person_id: person.personId,
      person_name: person.displayName,
      unmapped: String(person.unmapped),
      commits: person.commits,
      raw_additions: person.rawAdditions,
      raw_deletions: person.rawDeletions,
      meaningful_additions: person.meaningfulAdditions,
      meaningful_deletions: person.meaningfulDeletions,
      raw_lines: person.rawLines,
      meaningful_lines: person.meaningfulLines,
      projects: person.projects.join("|"),
      category_mix: formatMix(person.categoryMix),
      high_complexity: person.highComplexity,
      releases: person.releases.map((release) => `${release.projectId}@${release.version}`).join("|"),
    });
  }
  for (const project of report.projects) {
    rows.push({
      section: "project",
      window,
      source: project.source,
      project: project.projectId,
      commits: project.commits,
      raw_additions: project.rawAdditions,
      raw_deletions: project.rawDeletions,
      meaningful_additions: project.meaningfulAdditions,
      meaningful_deletions: project.meaningfulDeletions,
      raw_lines: project.rawLines,
      meaningful_lines: project.meaningfulLines,
      contributors: project.contributors.map((person) => person.displayName).join("|"),
      category_mix: formatMix(project.categoryMix),
      release_count: project.releaseCount,
      releases: project.releases.map((release) => release.version).join("|"),
      risk_flags: project.risks.map((risk) => `${risk.title}: ${risk.flags.join(", ")}`).join("|"),
    });
  }
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((column) => csvCell(row[column] ?? "")).join(","));
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
