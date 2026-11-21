import { CATEGORIES, type ClassifiedUnit, type Classification } from "./classifier.js";
import type { CostSnapshot } from "./cost.js";
import type { PersonActivity, ProjectActivity } from "./metrics.js";
import { formatInTimeZone, type TimeWindow } from "./window.js";

export interface CategoryMix {
  feature: number;
  bugfix: number;
  refactor: number;
  test: number;
  docs: number;
  "config/infra": number;
  dependency: number;
  release: number;
}

export interface PersonRow extends PersonActivity {
  categoryMix: CategoryMix;
  highComplexity: number;
}

export interface RiskItem {
  unitId: string;
  title: string;
  url: string;
  flags: string[];
}

export interface ProjectRow extends ProjectActivity {
  categoryMix: CategoryMix;
  risks: RiskItem[];
}

export interface Report {
  window: TimeWindow["preset"];
  windowPhrase: string;
  timezone: string;
  since: string;
  until: string;
  sinceLabel: string;
  untilLabel: string;
  destination: "dm" | "channel";
  destinationId: string;
  narrative: string;
  runKey: string;
  people: PersonRow[];
  projects: ProjectRow[];
  changeUnits: ClassifiedUnit[];
  llm: CostSnapshot;
  markdown: string;
}

export function emptyMix(): CategoryMix {
  return {
    feature: 0,
    bugfix: 0,
    refactor: 0,
    test: 0,
    docs: 0,
    "config/infra": 0,
    dependency: 0,
    release: 0,
  };
}

export function formatMix(mix: CategoryMix): string {
  const parts = CATEGORIES.filter((category) => mix[category] > 0).map((category) => `${category} ${mix[category]}`);
  return parts.length > 0 ? parts.join(", ") : "unclassified";
}

export function buildReport(input: {
  window: TimeWindow;
  timezone: string;
  destination: "dm" | "channel";
  destinationId: string;
  narrative: string;
  runKey: string;
  people: PersonActivity[];
  projects: ProjectActivity[];
  units: ClassifiedUnit[];
  llm: CostSnapshot;
}): Report {
  const people = buildPeople(input.people, input.units);
  const projects = buildProjects(input.projects, input.units);
  const report: Report = {
    window: input.window.preset,
    windowPhrase: input.window.phrase,
    timezone: input.timezone,
    since: input.window.since.toISOString(),
    until: input.window.until.toISOString(),
    sinceLabel: formatInTimeZone(input.window.since, input.timezone),
    untilLabel: formatInTimeZone(input.window.until, input.timezone),
    destination: input.destination,
    destinationId: input.destinationId,
    narrative: input.narrative.trim(),
    runKey: input.runKey,
    people,
    projects,
    changeUnits: input.units,
    llm: input.llm,
    markdown: "",
  };
  report.markdown = renderMarkdown(report);
  return report;
}

function buildPeople(activity: PersonActivity[], units: ClassifiedUnit[]): PersonRow[] {
  const byId = new Map<string, PersonRow>();
  for (const person of activity) {
    byId.set(person.personId, { ...person, projects: [...person.projects], releases: [...person.releases], categoryMix: emptyMix(), highComplexity: 0 });
  }
  for (const unit of units) {
    const row = byId.get(unit.personId) ?? {
      personId: unit.personId,
      displayName: unit.displayName,
      unmapped: unit.unmapped,
      projects: [unit.projectId],
      commits: 0,
      rawAdditions: 0,
      rawDeletions: 0,
      meaningfulAdditions: 0,
      meaningfulDeletions: 0,
      rawLines: 0,
      meaningfulLines: 0,
      releases: [],
      categoryMix: emptyMix(),
      highComplexity: 0,
    };
    if (addMix(row.categoryMix, unit.classification)) row.highComplexity += 1;
    if (!row.projects.includes(unit.projectId)) row.projects.push(unit.projectId);
    byId.set(unit.personId, row);
  }
  return [...byId.values()]
    .filter((person) => person.commits > 0 || person.releases.length > 0 || totalMix(person.categoryMix) > 0)
    .map((person) => ({ ...person, projects: [...person.projects].sort((a, b) => a.localeCompare(b)) }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }) || left.personId.localeCompare(right.personId));
}

function buildProjects(activity: ProjectActivity[], units: ClassifiedUnit[]): ProjectRow[] {
  const byId = new Map<string, ProjectRow>();
  for (const project of activity) {
    byId.set(project.projectId, {
      ...project,
      contributors: [...project.contributors],
      releases: [...project.releases],
      categoryMix: emptyMix(),
      risks: [],
    });
  }
  for (const unit of units) {
    const row = byId.get(unit.projectId);
    if (!row) continue;
    addMix(row.categoryMix, unit.classification);
    if (unit.classification && unit.classification.risk_flags.length > 0) {
      row.risks.push({
        unitId: unit.id,
        title: unit.title,
        url: unit.url,
        flags: [...unit.classification.risk_flags],
      });
    }
  }
  for (const project of byId.values()) {
    project.risks.sort((left, right) => left.title.localeCompare(right.title));
    project.contributors.sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }));
    project.releases.sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
  }
  return [...byId.values()]
    .filter((project) => project.commits > 0 || project.releaseCount > 0)
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

function addMix(mix: CategoryMix, classification: Classification | null): boolean {
  if (!classification) return false;
  mix[classification.category] += 1;
  return classification.complexity === "high";
}

function totalMix(mix: CategoryMix): number {
  return CATEGORIES.reduce((sum, category) => sum + mix[category], 0);
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Engineering activity — ${report.windowPhrase}`);
  lines.push("");
  lines.push(`Window: ${report.sinceLabel} → ${report.untilLabel} (${report.timezone})`);
  lines.push(`Destination: ${report.destination} ${report.destinationId}`);
  lines.push("");
  lines.push("## Narrative");
  lines.push("");
  lines.push(report.narrative || "_No narrative._");
  lines.push("");
  lines.push("## People");
  lines.push("");
  if (report.people.length === 0) lines.push("No activity in this window.");
  for (const person of report.people) {
    const unmapped = person.unmapped ? " (unmapped)" : "";
    lines.push(`### ${person.displayName}${unmapped}`);
    lines.push("");
    lines.push(`- Projects: ${person.projects.join(", ") || "—"}`);
    lines.push(`- Commits: ${person.commits}`);
    lines.push(`- Lines: ${person.meaningfulLines} meaningful (${person.rawLines} raw)`);
    lines.push(`- Categories: ${formatMix(person.categoryMix)}`);
    lines.push(`- High complexity: ${person.highComplexity}`);
    lines.push(
      `- Releases: ${
        person.releases.length > 0 ? person.releases.map((release) => `${release.projectName} ${release.version}`).join(", ") : "—"
      }`,
    );
    lines.push("");
  }
  lines.push("## Projects");
  lines.push("");
  if (report.projects.length === 0) lines.push("No project activity in this window.");
  for (const project of report.projects) {
    lines.push(`### ${project.projectId}`);
    lines.push("");
    lines.push(`- Contributors: ${project.contributors.map((person) => person.displayName).join(", ") || "—"}`);
    lines.push(`- Commits: ${project.commits}`);
    lines.push(`- Lines: ${project.meaningfulLines} meaningful (${project.rawLines} raw)`);
    lines.push(`- Categories: ${formatMix(project.categoryMix)}`);
    lines.push(
      `- Releases: ${
        project.source === "gitlab" && project.releases.length > 0
          ? project.releases.map((release) => release.version).join(", ")
          : "—"
      }`,
    );
    if (project.risks.length === 0) {
      lines.push("- Risk flags: —");
    } else {
      lines.push("- Risk flags:");
      for (const risk of project.risks) lines.push(`  - ${risk.title} — ${risk.flags.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatDigest(report: Report, maxChars = 3500): string {
  const full = digestLines(report, report.people, report.projects);
  if (full.length <= maxChars) return full;
  return digestLines(report, report.people.slice(0, 15), report.projects.slice(0, 15), true);
}

function digestLines(report: Report, people: PersonRow[], projects: ProjectRow[], truncated = false): string {
  const lines: string[] = [];
  lines.push(`*Engineering activity — ${report.windowPhrase}*`);
  lines.push(`_${report.sinceLabel} → ${report.untilLabel} (${report.timezone})_`);
  lines.push("");
  lines.push("*Narrative*");
  lines.push(truncate(report.narrative, 1200));
  lines.push("");
  lines.push("*People*");
  if (people.length === 0) lines.push("_No activity in this window._");
  for (const person of people) {
    const unmapped = person.unmapped ? " _(unmapped)_" : "";
    const releases =
      person.releases.length > 0 ? ` · releases ${person.releases.map((release) => release.version).join(", ")}` : "";
    lines.push(
      `• *${person.displayName}*${unmapped} — ${person.commits} commits · ${person.meaningfulLines} meaningful lines (${person.rawLines} raw) · ${person.projects.join(", ") || "—"} · ${formatMix(person.categoryMix)} · high complexity ${person.highComplexity}${releases}`,
    );
  }
  if (truncated && report.people.length > people.length) {
    lines.push(`_…and ${report.people.length - people.length} more people in the CSV._`);
  }
  lines.push("");
  lines.push("*Projects*");
  if (projects.length === 0) lines.push("_No project activity in this window._");
  for (const project of projects) {
    const releases =
      project.source === "gitlab" && project.releases.length > 0
        ? ` · releases ${project.releases.map((release) => release.version).join(", ")}`
        : "";
    const risks =
      project.risks.length > 0 ? ` · risks: ${project.risks.map((risk) => risk.flags.join(", ")).join("; ")}` : "";
    lines.push(
      `• *${project.projectName}* (${project.source}) — ${project.contributors.length} people · ${project.commits} commits · ${project.meaningfulLines} meaningful lines (${project.rawLines} raw) · ${formatMix(project.categoryMix)}${releases}${risks}`,
    );
  }
  if (truncated && report.projects.length > projects.length) {
    lines.push(`_…and ${report.projects.length - projects.length} more projects in the CSV._`);
  }
  lines.push("");
  lines.push(`_LLM calls ${report.llm.calls}, estimated cost $${report.llm.estimatedUsd.toFixed(4)}_`);
  lines.push(`report-key:${report.runKey}`);
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function narrativePayload(report: Pick<Report, "windowPhrase" | "people" | "projects" | "changeUnits">): unknown {
  return {
    window_phrase: report.windowPhrase,
    people: report.people.map((person) => ({
      name: person.displayName,
      unmapped: person.unmapped,
      commits: person.commits,
      meaningful_lines: person.meaningfulLines,
      raw_lines: person.rawLines,
      projects: person.projects,
      categories: person.categoryMix,
      high_complexity: person.highComplexity,
      releases: person.releases.map((release) => release.version),
    })),
    projects: report.projects.map((project) => ({
      name: project.projectName,
      source: project.source,
      commits: project.commits,
      meaningful_lines: project.meaningfulLines,
      categories: project.categoryMix,
      releases: project.releases.map((release) => release.version),
      risks: project.risks.map((risk) => ({ title: risk.title, flags: risk.flags })),
    })),
    summaries: report.changeUnits
      .filter((unit) => unit.classification)
      .map((unit) => unit.classification?.summary),
  };
}
