import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const personSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  emails: z.array(z.string()).default([]),
  github_logins: z.array(z.string()).default([]),
  gitlab_usernames: z.array(z.string()).default([]),
});

const fileSchema = z.object({
  people: z.array(personSchema),
});

export interface Person {
  id: string;
  displayName: string;
  emails: string[];
  githubLogins: string[];
  gitlabUsernames: string[];
}

export interface AuthorRef {
  email?: string | null;
  githubLogin?: string | null;
  gitlabUsername?: string | null;
  name?: string | null;
}

export type MatchKind = "email" | "github" | "gitlab";

export interface ResolvedIdentity {
  personId: string;
  displayName: string;
  unmapped: boolean;
  matchedBy: MatchKind | null;
}

export type CreditVia =
  | "alias-email"
  | "alias-github"
  | "alias-gitlab"
  | "tool-coauthor"
  | "tool-pr"
  | "tool-mr"
  | "unmapped"
  | "tool-uncredited";

export interface CreditInput {
  authorName: string;
  authorEmail: string;
  githubLogin: string | null;
  gitlabUsername: string | null;
  message: string;
  pullRequest: { authorLogin: string | null } | null;
  mergeRequest: { authorUsername: string | null } | null;
}

export interface Credit {
  personId: string;
  displayName: string;
  unmapped: boolean;
  matchedBy: MatchKind | null;
  toolOnly: boolean;
  via: CreditVia;
  rawName: string;
  rawEmail: string;
  rawLogin: string;
  rawGitlab: string;
  creditedName: string;
  creditedEmail: string;
  creditedLogin: string;
  creditedGitlab: string;
}

export interface AppliedRow {
  seen: string;
  via: string;
  commits: number;
}

export interface AppliedGroup {
  personId: string;
  displayName: string;
  rows: AppliedRow[];
}

export interface UnmappedIdentity {
  personId: string;
  displayName: string;
  emails: string[];
  githubLogins: string[];
  gitlabUsernames: string[];
  projects: string[];
  commits: number;
  tool: boolean;
  snippet: string;
}

export interface IdentityMapping {
  applied: AppliedGroup[];
  unmapped: UnmappedIdentity[];
}

const TOOL_EMAILS = new Set(["noreply@anthropic.com", "bot@xdlab.ai"]);
const TOOL_LOGINS = new Set(["claude", "cursor", "copilot"]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function loadAliases(file: string): Person[] {
  const parsed = fileSchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid alias file ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data.people.map((person) => ({
    id: person.id,
    displayName: person.display_name,
    emails: person.emails.map(normalizeEmail).filter(Boolean),
    githubLogins: person.github_logins.map((login) => login.trim().toLowerCase()).filter(Boolean),
    gitlabUsernames: person.gitlab_usernames.map((name) => name.trim().toLowerCase()).filter(Boolean),
  }));
}

export function resolveIdentity(people: Person[], author: AuthorRef): ResolvedIdentity {
  const email = author.email ? normalizeEmail(author.email) : "";
  const login = author.githubLogin?.trim().toLowerCase() ?? "";
  const gitlab = author.gitlabUsername?.trim().toLowerCase() ?? "";

  const byEmail = email ? people.find((person) => person.emails.includes(email)) : undefined;
  if (byEmail) return mapped(byEmail, "email");
  const byLogin = login ? people.find((person) => person.githubLogins.includes(login)) : undefined;
  if (byLogin) return mapped(byLogin, "github");
  const byGitlab = gitlab ? people.find((person) => person.gitlabUsernames.includes(gitlab)) : undefined;
  if (byGitlab) return mapped(byGitlab, "gitlab");

  const key = email || login || gitlab || author.name?.trim().toLowerCase() || "anonymous";
  const kind = email ? "email" : login ? "github" : gitlab ? "gitlab" : "name";
  return {
    personId: `unmapped:${kind}:${key}`,
    displayName: author.name?.trim() || email || login || gitlab || "Unknown author",
    unmapped: true,
    matchedBy: null,
  };
}

export function isToolAuthor(author: AuthorRef): boolean {
  const name = author.name?.trim().toLowerCase() ?? "";
  const email = author.email ? normalizeEmail(author.email) : "";
  const login = author.githubLogin?.trim().toLowerCase() ?? "";
  if (email && TOOL_EMAILS.has(email)) return true;
  if (login && TOOL_LOGINS.has(login)) return true;
  if (name === "claude" || name.startsWith("claude ")) return true;
  if (name === "cursor" || name.startsWith("cursor ")) return true;
  if (name === "copilot" || name.startsWith("copilot ") || name === "github copilot") return true;
  if (name === "appbuilder bot") return true;
  return false;
}

export function coAuthors(message: string): { name: string; email: string }[] {
  const found: { name: string; email: string }[] = [];
  for (const match of message.matchAll(/^co-authored-by:\s*(.+?)\s*<([^>]+)>/gim)) {
    found.push({ name: match[1].trim(), email: match[2].trim() });
  }
  return found;
}

export function creditAuthor(people: Person[], input: CreditInput): Credit {
  const raw = {
    rawName: input.authorName.trim(),
    rawEmail: input.authorEmail.trim(),
    rawLogin: (input.githubLogin ?? "").trim(),
    rawGitlab: (input.gitlabUsername ?? "").trim(),
  };
  const authorIsTool = isToolAuthor({
    name: input.authorName,
    email: input.authorEmail,
    githubLogin: input.githubLogin,
  });
  const authorAlias = resolveIdentity(people, {
    email: input.authorEmail,
    githubLogin: input.githubLogin,
    gitlabUsername: input.gitlabUsername,
    name: input.authorName,
  });

  if (authorIsTool && authorAlias.unmapped) {
    for (const coauthor of coAuthors(input.message)) {
      if (isToolAuthor({ name: coauthor.name, email: coauthor.email })) continue;
      const human = resolveIdentity(people, { email: coauthor.email, name: coauthor.name });
      return finish(human, "tool-coauthor", raw, {
        creditedName: coauthor.name,
        creditedEmail: coauthor.email,
        creditedLogin: "",
        creditedGitlab: "",
      }, false);
    }
    const pr = input.pullRequest?.authorLogin?.trim() ?? "";
    if (pr && !isToolAuthor({ githubLogin: pr, name: pr })) {
      const human = resolveIdentity(people, { githubLogin: pr, name: pr });
      return finish(human, "tool-pr", raw, {
        creditedName: pr,
        creditedEmail: "",
        creditedLogin: pr,
        creditedGitlab: "",
      }, false);
    }
    const mr = input.mergeRequest?.authorUsername?.trim() ?? "";
    if (mr && !isToolAuthor({ gitlabUsername: mr, name: mr })) {
      const human = resolveIdentity(people, { gitlabUsername: mr, name: mr });
      return finish(human, "tool-mr", raw, {
        creditedName: mr,
        creditedEmail: "",
        creditedLogin: "",
        creditedGitlab: mr,
      }, false);
    }
    const key = normalizeEmail(raw.rawEmail) || raw.rawLogin.toLowerCase() || raw.rawName.toLowerCase() || "anonymous";
    return finish(
      {
        personId: `unmapped:tool:${key}`,
        displayName: raw.rawName || raw.rawLogin || raw.rawEmail || "Unknown tool",
        unmapped: true,
        matchedBy: null,
      },
      "tool-uncredited",
      raw,
      { creditedName: "", creditedEmail: "", creditedLogin: "", creditedGitlab: "" },
      true,
    );
  }

  const via: CreditVia = authorAlias.unmapped
    ? "unmapped"
    : authorAlias.matchedBy === "email"
      ? "alias-email"
      : authorAlias.matchedBy === "github"
        ? "alias-github"
        : "alias-gitlab";
  return finish(authorAlias, via, raw, {
    creditedName: raw.rawName,
    creditedEmail: raw.rawEmail,
    creditedLogin: raw.rawLogin,
    creditedGitlab: raw.rawGitlab,
  }, false);
}

export function emptyIdentityMapping(): IdentityMapping {
  return { applied: [], unmapped: [] };
}

export function identityMapping(commits: Array<Credit & { projectName: string }>): IdentityMapping {
  const applied = new Map<string, { personId: string; displayName: string; rows: Map<string, AppliedRow> }>();
  const unmapped = new Map<string, UnmappedBucket>();

  for (const commit of commits) {
    if (isApplied(commit.via)) {
      const group = applied.get(commit.personId) ?? {
        personId: commit.personId,
        displayName: commit.displayName,
        rows: new Map(),
      };
      const seen = formatSeen(commit);
      const rowKey = `${seen}|${commit.via}`;
      const row = group.rows.get(rowKey) ?? { seen, via: viaLabel(commit.via), commits: 0 };
      row.commits += 1;
      group.rows.set(rowKey, row);
      applied.set(commit.personId, group);
    }
    if (commit.toolOnly) {
      const bucket = unmappedBucket(unmapped, commit.personId, commit.displayName, true);
      bucket.commits += 1;
      addToken(bucket.emails, commit.rawEmail, true);
      addToken(bucket.logins, commit.rawLogin, false);
      addToken(bucket.gitlabs, commit.rawGitlab, false);
      if (commit.projectName) bucket.projects.add(commit.projectName);
      continue;
    }
    if (commit.unmapped) {
      const bucket = unmappedBucket(unmapped, commit.personId, commit.displayName, false);
      bucket.commits += 1;
      addToken(bucket.emails, commit.creditedEmail, true);
      addToken(bucket.logins, commit.creditedLogin, false);
      addToken(bucket.gitlabs, commit.creditedGitlab, false);
      if (commit.projectName) bucket.projects.add(commit.projectName);
    }
  }

  return {
    applied: [...applied.values()]
      .map((group) => ({
        personId: group.personId,
        displayName: group.displayName,
        rows: [...group.rows.values()].sort((left, right) => left.seen.localeCompare(right.seen) || left.via.localeCompare(right.via)),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }) || left.personId.localeCompare(right.personId)),
    unmapped: [...unmapped.values()]
      .map((bucket) => ({
        personId: bucket.personId,
        displayName: bucket.displayName,
        emails: [...bucket.emails].sort(),
        githubLogins: [...bucket.logins].sort(),
        gitlabUsernames: [...bucket.gitlabs].sort(),
        projects: [...bucket.projects].sort(),
        commits: bucket.commits,
        tool: bucket.tool,
        snippet: aliasSnippet({
          displayName: bucket.displayName,
          emails: [...bucket.emails].sort(),
          githubLogins: [...bucket.logins].sort(),
          gitlabUsernames: [...bucket.gitlabs].sort(),
        }),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" }) || left.personId.localeCompare(right.personId)),
  };
}

export function aliasSnippet(entry: {
  displayName: string;
  emails: string[];
  githubLogins: string[];
  gitlabUsernames: string[];
}): string {
  const id = slug(entry.displayName || entry.emails[0] || entry.githubLogins[0] || entry.gitlabUsernames[0] || "person");
  return [
    `  - id: ${id}`,
    `    display_name: ${yamlScalar(entry.displayName || id)}`,
    yamlList("emails", entry.emails),
    yamlList("github_logins", entry.githubLogins),
    yamlList("gitlab_usernames", entry.gitlabUsernames),
  ].join("\n");
}

export function formatIdentityLog(mapping: IdentityMapping): string {
  const lines: string[] = ["Identity mapping", ""];
  lines.push("Aliases applied");
  if (mapping.applied.length === 0) {
    lines.push("No aliases were applied in this window.");
  }
  for (const group of mapping.applied) {
    lines.push(group.displayName);
    for (const row of group.rows) {
      lines.push(`  ${row.seen} → ${group.displayName} — ${commitPhrase(row.commits)} (${row.via})`);
    }
  }
  lines.push("");
  lines.push("New identities");
  if (mapping.unmapped.length === 0) {
    lines.push("No new identities.");
  } else {
    lines.push("Paste a snippet into people/aliases.yaml and set id and display_name to the real person.");
  }
  for (const entry of mapping.unmapped) {
    const where = entry.projects.length > 0 ? ` on ${entry.projects.join(", ")}` : "";
    const credit = entry.tool ? "not credited to a person" : "not in aliases.yaml";
    lines.push(`${entry.displayName} — ${commitPhrase(entry.commits)}${where}. ${sentence(credit)}.`);
    lines.push(entry.snippet);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatSeen(commit: Pick<Credit, "rawName" | "rawEmail" | "rawLogin" | "rawGitlab">): string {
  const parts: string[] = [];
  if (commit.rawName) parts.push(commit.rawName);
  if (commit.rawEmail) parts.push(`<${commit.rawEmail}>`);
  const handles = [
    commit.rawLogin ? `GitHub ${commit.rawLogin}` : "",
    commit.rawGitlab ? `GitLab ${commit.rawGitlab}` : "",
  ].filter(Boolean);
  const head = parts.join(" ");
  if (handles.length === 0) return head || "unknown";
  return head ? `${head} (${handles.join(", ")})` : handles.join(", ");
}

function mapped(person: Person, matchedBy: MatchKind): ResolvedIdentity {
  return { personId: person.id, displayName: person.displayName, unmapped: false, matchedBy };
}

function finish(
  identity: ResolvedIdentity,
  via: CreditVia,
  raw: Pick<Credit, "rawName" | "rawEmail" | "rawLogin" | "rawGitlab">,
  credited: Pick<Credit, "creditedName" | "creditedEmail" | "creditedLogin" | "creditedGitlab">,
  toolOnly: boolean,
): Credit {
  return { ...identity, ...raw, ...credited, via, toolOnly };
}

function isApplied(via: CreditVia): boolean {
  return via.startsWith("alias-") || via === "tool-coauthor" || via === "tool-pr" || via === "tool-mr";
}

function viaLabel(via: CreditVia): string {
  switch (via) {
    case "alias-email":
      return "email alias";
    case "alias-github":
      return "GitHub login alias";
    case "alias-gitlab":
      return "GitLab username alias";
    case "tool-coauthor":
      return "tool, credited through Co-authored-by";
    case "tool-pr":
      return "tool, credited through the pull request author";
    case "tool-mr":
      return "tool, credited through the merge request author";
    default:
      return via;
  }
}

interface UnmappedBucket {
  personId: string;
  displayName: string;
  emails: Set<string>;
  logins: Set<string>;
  gitlabs: Set<string>;
  projects: Set<string>;
  commits: number;
  tool: boolean;
}

function unmappedBucket(map: Map<string, UnmappedBucket>, personId: string, displayName: string, tool: boolean): UnmappedBucket {
  const existing = map.get(personId);
  if (existing) return existing;
  const created: UnmappedBucket = {
    personId,
    displayName,
    emails: new Set(),
    logins: new Set(),
    gitlabs: new Set(),
    projects: new Set(),
    commits: 0,
    tool,
  };
  map.set(personId, created);
  return created;
}

function addToken(set: Set<string>, value: string, email: boolean): void {
  const token = email ? normalizeEmail(value) : value.trim().toLowerCase();
  if (token) set.add(token);
}

function yamlList(name: string, values: string[]): string {
  if (values.length === 0) return `    ${name}: []`;
  return [`    ${name}:`, ...values.map((value) => `      - ${yamlScalar(value)}`)].join("\n");
}

function yamlScalar(value: string): string {
  if (value === "" || /[\n:#]/.test(value) || /^[&*!|>%@`"'\s[{]/.test(value) || /\s$/.test(value) || value === "[]") {
    return JSON.stringify(value);
  }
  return value;
}

function slug(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "person";
}

function commitPhrase(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
