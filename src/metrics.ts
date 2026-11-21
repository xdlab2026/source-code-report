import { isBotIdentity, isMergeCommit, unionBranches } from "./collectors/shared.js";
import { creditAuthor, resolveIdentity, type CreditVia, type MatchKind, type Person } from "./identity.js";
import type { CollectedCommit, ReleaseRecord } from "./model.js";
import { scoreFiles, type DenyMatch, type LineScore } from "./noise.js";

export interface ScoredCommit extends CollectedCommit, LineScore {
  personId: string;
  displayName: string;
  unmapped: boolean;
  toolOnly: boolean;
  via: CreditVia;
  matchedBy: MatchKind | null;
  rawName: string;
  rawEmail: string;
  rawLogin: string;
  rawGitlab: string;
  creditedName: string;
  creditedEmail: string;
  creditedLogin: string;
  creditedGitlab: string;
}

export interface AttributedRelease extends ReleaseRecord {
  personId: string;
  displayName: string;
  unmapped: boolean;
}

export interface PersonActivity {
  personId: string;
  displayName: string;
  unmapped: boolean;
  projects: string[];
  commits: number;
  rawAdditions: number;
  rawDeletions: number;
  meaningfulAdditions: number;
  meaningfulDeletions: number;
  rawLines: number;
  meaningfulLines: number;
  releases: { projectId: string; projectName: string; version: string }[];
}

export interface ProjectActivity {
  projectId: string;
  projectName: string;
  source: "github" | "gitlab";
  contributors: { personId: string; displayName: string }[];
  commits: number;
  rawAdditions: number;
  rawDeletions: number;
  meaningfulAdditions: number;
  meaningfulDeletions: number;
  rawLines: number;
  meaningfulLines: number;
  releaseCount: number;
  releases: { version: string; personId: string; displayName: string }[];
}

export function referencedSha(message: string): string | null {
  const match = message.match(/cherry picked from commit ([0-9a-f]{7,40})/i);
  return match ? match[1].toLowerCase() : null;
}

export function dedupeCommits<T extends CollectedCommit>(commits: T[]): T[] {
  const byProject = new Map<string, T[]>();
  for (const commit of commits) {
    const list = byProject.get(commit.projectId) ?? [];
    list.push(commit);
    byProject.set(commit.projectId, list);
  }
  return [...byProject.values()].flatMap((group) => dedupeProject(group));
}

function dedupeProject<T extends CollectedCommit>(commits: T[]): T[] {
  const shas = commits.map((commit) => commit.sha.toLowerCase());
  const keyFor = (commit: T): string => {
    const reference = referencedSha(commit.message);
    if (!reference) return commit.sha.toLowerCase();
    const matches = shas.filter((sha) => sha === reference || sha.startsWith(reference));
    return matches.length === 1 ? matches[0] : reference;
  };
  const byKey = new Map<string, T>();
  for (const commit of commits) {
    const key = keyFor(commit);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...commit, branches: [...commit.branches] });
      continue;
    }
    const branches = unionBranches(existing.branches, commit.branches);
    const existingIsSource = !referencedSha(existing.message);
    const incomingIsSource = !referencedSha(commit.message);
    if (!existingIsSource && incomingIsSource) byKey.set(key, { ...commit, branches });
    else existing.branches = branches;
  }
  return [...byKey.values()];
}

export function scoreCommits(
  commits: CollectedCommit[],
  people: Person[],
  deny: (filePath: string) => DenyMatch,
): ScoredCommit[] {
  const kept = dedupeCommits(commits).filter(
    (commit) =>
      !isMergeCommit({ parentCount: commit.parentCount, message: commit.message }) &&
      !isBotIdentity({
        login: commit.githubLogin,
        email: commit.authorEmail,
        name: commit.authorName,
        type: commit.authorType,
      }),
  );
  return kept.map((commit) => {
    const lines = scoreFiles(commit.files, deny);
    const credit = creditAuthor(people, {
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      githubLogin: commit.githubLogin,
      gitlabUsername: commit.gitlabUsername,
      message: commit.message,
      pullRequest: commit.pullRequest,
      mergeRequest: commit.mergeRequest,
    });
    return { ...commit, ...lines, ...credit };
  });
}

export function attributeReleases(releases: ReleaseRecord[], people: Person[]): AttributedRelease[] {
  return releases.map((release) => ({
    ...release,
    ...resolveIdentity(people, {
      email: release.authorEmail,
      gitlabUsername: release.gitlabUsername,
      name: release.authorName,
    }),
  }));
}

export function rollup(commits: ScoredCommit[], releases: AttributedRelease[]): {
  people: PersonActivity[];
  projects: ProjectActivity[];
} {
  const people = new Map<string, PersonActivity>();
  const projects = new Map<string, ProjectActivity>();

  const personOf = (id: string, name: string, unmapped: boolean): PersonActivity => {
    const existing = people.get(id);
    if (existing) return existing;
    const created: PersonActivity = {
      personId: id,
      displayName: name,
      unmapped,
      projects: [],
      commits: 0,
      rawAdditions: 0,
      rawDeletions: 0,
      meaningfulAdditions: 0,
      meaningfulDeletions: 0,
      rawLines: 0,
      meaningfulLines: 0,
      releases: [],
    };
    people.set(id, created);
    return created;
  };

  const projectOf = (commitOrRelease: { projectId: string; projectName: string; source: "github" | "gitlab" }): ProjectActivity => {
    const existing = projects.get(commitOrRelease.projectId);
    if (existing) return existing;
    const created: ProjectActivity = {
      projectId: commitOrRelease.projectId,
      projectName: commitOrRelease.projectName,
      source: commitOrRelease.source,
      contributors: [],
      commits: 0,
      rawAdditions: 0,
      rawDeletions: 0,
      meaningfulAdditions: 0,
      meaningfulDeletions: 0,
      rawLines: 0,
      meaningfulLines: 0,
      releaseCount: 0,
      releases: [],
    };
    projects.set(commitOrRelease.projectId, created);
    return created;
  };

  for (const commit of commits) {
    if (commit.toolOnly) continue;
    const person = personOf(commit.personId, commit.displayName, commit.unmapped);
    person.commits += 1;
    person.rawAdditions += commit.rawAdditions;
    person.rawDeletions += commit.rawDeletions;
    person.meaningfulAdditions += commit.meaningfulAdditions;
    person.meaningfulDeletions += commit.meaningfulDeletions;
    person.rawLines += commit.rawLines;
    person.meaningfulLines += commit.meaningfulLines;
    if (!person.projects.includes(commit.projectId)) person.projects.push(commit.projectId);

    const project = projectOf(commit);
    project.commits += 1;
    project.rawAdditions += commit.rawAdditions;
    project.rawDeletions += commit.rawDeletions;
    project.meaningfulAdditions += commit.meaningfulAdditions;
    project.meaningfulDeletions += commit.meaningfulDeletions;
    project.rawLines += commit.rawLines;
    project.meaningfulLines += commit.meaningfulLines;
    if (!project.contributors.some((contributor) => contributor.personId === commit.personId)) {
      project.contributors.push({ personId: commit.personId, displayName: commit.displayName });
    }
  }

  for (const release of releases) {
    const person = personOf(release.personId, release.displayName, release.unmapped);
    person.releases.push({ projectId: release.projectId, projectName: release.projectName, version: release.version });
    if (!person.projects.includes(release.projectId)) person.projects.push(release.projectId);
    const project = projectOf(release);
    project.releaseCount += 1;
    project.releases.push({ version: release.version, personId: release.personId, displayName: release.displayName });
    if (!project.contributors.some((contributor) => contributor.personId === release.personId)) {
      project.contributors.push({ personId: release.personId, displayName: release.displayName });
    }
  }

  for (const person of people.values()) person.projects.sort((a, b) => a.localeCompare(b));
  return { people: [...people.values()], projects: [...projects.values()] };
}
