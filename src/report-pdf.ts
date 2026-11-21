import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClassifiedUnit } from "./classifier.js";
import { repoRoot } from "./config.js";
import { formatMix, type PersonRow, type ProjectRow, type Report } from "./report.js";

export interface EffortSlice {
  projectId: string;
  projectName: string;
  commits: number;
  meaningfulLines: number;
  rawLines: number;
  share: number;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value): value is string => Boolean(value));

export function findChrome(): string | undefined {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
}

export function personEffort(report: Report, personId: string): EffortSlice[] {
  return slices(
    report.changeUnits.filter((unit) => unit.personId === personId),
    (unit) => unit.projectId,
    (unit) => ({ id: unit.projectId, name: unit.projectName }),
  );
}

export function projectContributors(report: Report, projectId: string): Array<EffortSlice & { personId: string; displayName: string }> {
  const units = report.changeUnits.filter((unit) => unit.projectId === projectId);
  const byPerson = new Map<string, { name: string; commits: number; meaningfulLines: number; rawLines: number }>();
  for (const unit of units) {
    const current = byPerson.get(unit.personId) ?? { name: unit.displayName, commits: 0, meaningfulLines: 0, rawLines: 0 };
    current.commits += unit.commits.length;
    current.meaningfulLines += unit.meaningfulLines;
    current.rawLines += unit.rawLines;
    byPerson.set(unit.personId, current);
  }
  const totalLines = [...byPerson.values()].reduce((sum, row) => sum + row.meaningfulLines, 0);
  const totalCommits = [...byPerson.values()].reduce((sum, row) => sum + row.commits, 0);
  const rows = [...byPerson.entries()].map(([personId, row]) => ({
    personId,
    displayName: row.name,
    projectId,
    projectName: report.projects.find((project) => project.projectId === projectId)?.projectName ?? projectId,
    commits: row.commits,
    meaningfulLines: row.meaningfulLines,
    rawLines: row.rawLines,
    share: shareOf(row.meaningfulLines, totalLines, row.commits, totalCommits),
  }));
  roundShares(rows);
  return rows.sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }));
}

export function renderReportHtml(report: Report): string {
  const logo = readFileSync(path.join(repoRoot(), "assets/brand/xdl-wordmark.svg"), "utf8");
  const commits = report.people.reduce((sum, person) => sum + person.commits, 0);
  const meaningful = report.people.reduce((sum, person) => sum + person.meaningfulLines, 0);
  const raw = report.people.reduce((sum, person) => sum + person.rawLines, 0);
  const releases = report.projects.reduce((sum, project) => sum + project.releaseCount, 0);
  const highComplexity = report.people.reduce((sum, person) => sum + person.highComplexity, 0);
  const notes = report.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Engineering activity — ${escapeHtml(report.windowPhrase)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, "Liberation Sans", sans-serif;
    font-size: 10.5pt;
    line-height: 1.4;
    color: #000000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  table.sheet { width: 100%; border-collapse: collapse; }
  table.sheet > thead { display: table-header-group; }
  table.sheet > tfoot { display: table-footer-group; }
  .brand {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    border-bottom: 0.6pt solid #8EA9DB;
    padding-bottom: 2mm;
  }
  .brand svg { height: 11mm; width: auto; }
  .running-title { color: #666666; font-size: 8pt; text-align: right; }
  .foot {
    border-top: 0.6pt solid #8EA9DB;
    color: #666666;
    font-size: 8pt;
    display: flex;
    justify-content: space-between;
    padding-top: 2mm;
  }
  h1 { margin: 4mm 0 2mm; color: #1F3864; font-size: 22pt; font-weight: 700; }
  .meta { margin: 0 0 4mm; color: #666666; font-size: 9pt; }
  .note { margin: 0 0 4mm; padding: 2mm 3mm; background: #F5F5F5; color: #1F3864; }
  h2.section {
    margin: 6mm 0 3mm;
    padding: 1.5mm 3mm;
    background: #1F3864;
    color: #ffffff;
    font-size: 14pt;
    font-weight: 700;
  }
  h3 { margin: 4mm 0 1.5mm; color: #2E75B6; font-size: 12pt; font-weight: 700; }
  p { margin: 0 0 2.5mm; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; font-size: 9pt; }
  th, td { border: 0.6pt solid #8EA9DB; padding: 1.2mm 1.8mm; text-align: left; vertical-align: top; }
  th { background: #2E75B6; color: #ffffff; font-weight: 700; }
  tr:nth-child(even) td { background: #EEF2F7; }
  .nums td { font-variant-numeric: tabular-nums; }
  ul.activities { margin: 0 0 3mm; padding-left: 4.5mm; }
  ul.activities li { margin: 0 0 1.2mm; }
  .kind { color: #1F3864; font-weight: 700; }
  a { color: #0563C1; text-decoration: none; }
  h3, table.nums { break-inside: avoid; page-break-inside: avoid; }
</style>
</head>
<body>
<table class="sheet">
<thead><tr><td>
  <div class="brand">
    ${logo}
    <div class="running-title">XDL – Engineering activity | Confidential</div>
  </div>
</td></tr></thead>
<tfoot><tr><td><div class="foot"><span>XDLAB</span><span>Confidential</span></div></td></tr></tfoot>
<tbody><tr><td>
  <h1>Engineering activity</h1>
  <p class="meta">${escapeHtml(report.windowPhrase)} · ${escapeHtml(report.sinceLabel)} → ${escapeHtml(report.untilLabel)} (${escapeHtml(report.timezone)})</p>
  ${notes}
  <h2 class="section">1. Overview</h2>
  <table class="nums">
    <thead><tr><th>Commits</th><th>Meaningful lines</th><th>Raw lines</th><th>People</th><th>Projects</th><th>Releases</th><th>High complexity</th></tr></thead>
    <tbody><tr>
      <td>${commits}</td><td>${formatNumber(meaningful)}</td><td>${formatNumber(raw)}</td>
      <td>${report.people.length}</td><td>${report.projects.length}</td><td>${releases}</td><td>${highComplexity}</td>
    </tr></tbody>
  </table>
  <p>${escapeHtml(report.narrative || "No narrative.")}</p>
  <p>${escapeHtml(highlights(report))}</p>
  <h2 class="section">2. Projects</h2>
  ${report.projects.length === 0 ? "<p>No project activity in this window.</p>" : report.projects.map(renderProject).join("")}
  <h2 class="section">3. People</h2>
  ${report.people.length === 0 ? "<p>No people with activity in this window.</p>" : report.people.map((person) => renderPerson(report, person)).join("")}
</td></tr></tbody>
</table>
</body>
</html>`;

  function renderProject(project: ProjectRow): string {
    const contributors = projectContributors(report, project.projectId);
    const activities = report.changeUnits
      .filter((unit) => unit.projectId === project.projectId)
      .sort((left, right) => left.title.localeCompare(right.title));
    const contributorRows =
      contributors.length === 0
        ? `<tr><td colspan="5">No attributed changes.</td></tr>`
        : contributors
            .map(
              (row) => `<tr><td>${escapeHtml(row.displayName)}</td><td>${row.commits}</td><td>${formatNumber(row.meaningfulLines)}</td><td>${formatNumber(row.rawLines)}</td><td>${formatShare(row.share)}</td></tr>`,
            )
            .join("");
    const activityList =
      activities.length === 0
        ? "<p>No classified changes.</p>"
        : `<ul class="activities">${activities.map(renderActivity).join("")}</ul>`;
    const risks =
      project.risks.length === 0
        ? "<p>Risk flags: none.</p>"
        : `<p>Risk flags:</p><ul class="activities">${project.risks
            .map((risk) => `<li>${escapeHtml(risk.title)} — ${escapeHtml(risk.flags.join(", "))}</li>`)
            .join("")}</ul>`;
    const releaseText =
      project.releases.length > 0 ? project.releases.map((release) => release.version).join(", ") : "none";
    return `<h3>${escapeHtml(project.projectName)} <span class="meta">(${escapeHtml(project.source)})</span></h3>
<p>${project.commits} commits · ${formatNumber(project.meaningfulLines)} meaningful lines (${formatNumber(project.rawLines)} raw) · ${escapeHtml(formatMix(project.categoryMix))} · releases ${escapeHtml(releaseText)}</p>
<table class="nums">
  <thead><tr><th>Contributor</th><th>Commits</th><th>Meaningful lines</th><th>Raw lines</th><th>Share of project</th></tr></thead>
  <tbody>${contributorRows}</tbody>
</table>
${activityList}
${risks}`;
  }
}

function renderPerson(report: Report, person: PersonRow): string {
  const effort = personEffort(report, person.personId);
  const rows =
    effort.length === 0
      ? `<tr><td colspan="5">No attributed changes.</td></tr>`
      : effort
          .map(
            (slice) =>
              `<tr><td>${escapeHtml(slice.projectName)}</td><td>${slice.commits}</td><td>${formatNumber(slice.meaningfulLines)}</td><td>${formatNumber(slice.rawLines)}</td><td>${formatShare(slice.share)}</td></tr>`,
          )
          .join("");
  const releaseText =
    person.releases.length > 0
      ? person.releases.map((release) => `${release.projectName} ${release.version}`).join(", ")
      : "none";
  return `<h3>${escapeHtml(person.displayName)}${person.unmapped ? " (unmapped)" : ""}</h3>
<p>${person.commits} commits · ${formatNumber(person.meaningfulLines)} meaningful lines (${formatNumber(person.rawLines)} raw) · ${escapeHtml(formatMix(person.categoryMix))} · high complexity ${person.highComplexity} · releases ${escapeHtml(releaseText)}</p>
<table class="nums">
  <thead><tr><th>Project</th><th>Commits</th><th>Meaningful lines</th><th>Raw lines</th><th>Share of their lines</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderActivity(unit: ClassifiedUnit): string {
  const kind = unit.type === "pull_request" ? "Pull request" : unit.type === "merge_request" ? "Merge request" : "Commit";
  const category = unit.classification?.category ?? "unclassified";
  const summary = unit.classification?.summary ? ` ${unit.classification.summary}` : "";
  return `<li><span class="kind">${kind}</span> · ${escapeHtml(category)} — ${escapeHtml(unit.title)}.${escapeHtml(summary)} <span class="meta">${escapeHtml(unit.displayName)}</span></li>`;
}

function highlights(report: Report): string {
  if (report.projects.length === 0 && report.people.length === 0) {
    return "Nothing landed in this window.";
  }
  const projects = [...report.projects]
    .sort((left, right) => right.meaningfulLines - left.meaningfulLines || right.commits - left.commits)
    .slice(0, 3);
  const people = [...report.people]
    .sort((left, right) => right.meaningfulLines - left.meaningfulLines || right.commits - left.commits)
    .slice(0, 3);
  const projectText = projects
    .map((project) => `${project.projectName} (${project.commits} commits, ${formatNumber(project.meaningfulLines)} meaningful lines)`)
    .join("; ");
  const peopleText = people
    .map((person) => `${person.displayName} (${person.commits} commits, ${formatNumber(person.meaningfulLines)} meaningful lines)`)
    .join("; ");
  const projectSentence = projects.length > 0 ? `Standout projects: ${projectText}.` : "";
  const peopleSentence = people.length > 0 ? ` Notable contributions: ${peopleText}.` : "";
  return `${projectSentence}${peopleSentence}`.trim();
}

function slices(
  units: ClassifiedUnit[],
  keyOf: (unit: ClassifiedUnit) => string,
  labelOf: (unit: ClassifiedUnit) => { id: string; name: string },
): EffortSlice[] {
  const grouped = new Map<string, EffortSlice>();
  for (const unit of units) {
    const key = keyOf(unit);
    const label = labelOf(unit);
    const current = grouped.get(key) ?? {
      projectId: label.id,
      projectName: label.name,
      commits: 0,
      meaningfulLines: 0,
      rawLines: 0,
      share: 0,
    };
    current.commits += unit.commits.length;
    current.meaningfulLines += unit.meaningfulLines;
    current.rawLines += unit.rawLines;
    grouped.set(key, current);
  }
  const rows = [...grouped.values()];
  const totalLines = rows.reduce((sum, row) => sum + row.meaningfulLines, 0);
  const totalCommits = rows.reduce((sum, row) => sum + row.commits, 0);
  for (const row of rows) row.share = shareOf(row.meaningfulLines, totalLines, row.commits, totalCommits);
  roundShares(rows);
  return rows.sort((left, right) => left.projectName.localeCompare(right.projectName));
}

function roundShares(rows: { share: number }[]): void {
  const total = rows.reduce((sum, row) => sum + row.share, 0);
  if (rows.length === 0 || total <= 0) return;
  const exact = rows.map((row) => (row.share / total) * 100);
  const floors = exact.map((value) => Math.floor(value + 1e-9));
  let leftover = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value + 1e-9) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  const percents = [...floors];
  for (const item of order) {
    if (leftover <= 0) break;
    percents[item.index] += 1;
    leftover -= 1;
  }
  rows.forEach((row, index) => {
    row.share = (percents[index] ?? 0) / 100;
  });
}

function shareOf(lines: number, totalLines: number, commits: number, totalCommits: number): number {
  if (totalLines > 0) return lines / totalLines;
  if (totalCommits > 0) return commits / totalCommits;
  return 0;
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function renderPdf(html: string): Promise<Buffer> {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("Chrome or Chromium is required to render the PDF. Set CHROME_PATH or install google-chrome.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "report-pdf-"));
  const htmlFile = path.join(dir, "report.html");
  const pdfFile = path.join(dir, "report.pdf");
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(htmlFile, html);
    await runChrome(chrome, htmlFile, pdfFile, dir);
    return readFileSync(pdfFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChrome(chrome: string, htmlFile: string, pdfFile: string, dir: string): Promise<void> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${path.join(dir, "profile")}`,
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfFile}`,
    `file://${htmlFile}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !existsSync(pdfFile)) {
        reject(new Error(`Chrome PDF render failed (${code ?? "no exit"}). ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });
  });
}
