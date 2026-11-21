import { resolveIdentity, type Person } from "./identity.js";
import type { ScoredCommit } from "./metrics.js";
import type { FileChange } from "./model.js";
import type { DenyMatch } from "./noise.js";

export interface ChangeUnit {
  id: string;
  type: "pull_request" | "merge_request" | "commit";
  title: string;
  description: string;
  url: string;
  source: "github" | "gitlab";
  projectId: string;
  projectName: string;
  personId: string;
  displayName: string;
  unmapped: boolean;
  commits: string[];
  files: FileChange[];
  meaningfulLines: number;
  rawLines: number;
  diff: string;
}

export function buildChangeUnits(
  commits: ScoredCommit[],
  people: Person[],
  deny: (filePath: string) => DenyMatch,
): ChangeUnit[] {
  const groups = new Map<string, ScoredCommit[]>();
  for (const commit of commits) {
    const key = groupKey(commit);
    const list = groups.get(key) ?? [];
    list.push(commit);
    groups.set(key, list);
  }
  const units: ChangeUnit[] = [];
  for (const list of groups.values()) {
    list.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sha.localeCompare(right.sha));
    const head = list[0];
    const pull = head.pullRequest;
    const merge = head.mergeRequest;
    const identity = unitIdentity(list, people);
    const files = list.flatMap((commit) => commit.files);
    const diff = files
      .filter((file) => !deny(file.path).denied && file.patch)
      .map((file) => `diff -- ${file.path}\n${file.patch}`)
      .join("\n");
    const type = pull ? "pull_request" : merge ? "merge_request" : "commit";
    const title = pull?.title || merge?.title || head.message.split("\n")[0] || head.sha.slice(0, 7);
    const description = pull?.description || merge?.description || head.message.split("\n").slice(1).join("\n").trim();
    const url = pull?.url || merge?.url || `${head.projectUrl}/-/commit/${head.sha}`;
    const id = pull
      ? `${head.projectId}#${pull.number}`
      : merge
        ? `${head.projectId}!${merge.iid}`
        : `${head.projectId}@${head.sha}`;
    units.push({
      id,
      type,
      title,
      description,
      url,
      source: head.source,
      projectId: head.projectId,
      projectName: head.projectName,
      personId: identity.personId,
      displayName: identity.displayName,
      unmapped: identity.unmapped,
      commits: list.map((commit) => commit.sha),
      files,
      meaningfulLines: list.reduce((sum, commit) => sum + commit.meaningfulLines, 0),
      rawLines: list.reduce((sum, commit) => sum + commit.rawLines, 0),
      diff,
    });
  }
  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function groupKey(commit: ScoredCommit): string {
  if (commit.pullRequest) return `${commit.projectId}:pr:${commit.pullRequest.number}`;
  if (commit.mergeRequest) return `${commit.projectId}:mr:${commit.mergeRequest.iid}`;
  return `${commit.projectId}:commit:${commit.sha}`;
}

function unitIdentity(list: ScoredCommit[], people: Person[]) {
  const head = list[0];
  if (head.pullRequest?.authorLogin) {
    return resolveIdentity(people, { githubLogin: head.pullRequest.authorLogin, name: head.pullRequest.authorLogin });
  }
  if (head.mergeRequest?.authorUsername) {
    return resolveIdentity(people, {
      gitlabUsername: head.mergeRequest.authorUsername,
      name: head.mergeRequest.authorUsername,
    });
  }
  const counts = new Map<string, { count: number; commit: ScoredCommit }>();
  for (const commit of list) {
    const current = counts.get(commit.personId) ?? { count: 0, commit };
    current.count += 1;
    counts.set(commit.personId, current);
  }
  const winner = [...counts.values()].sort(
    (left, right) => right.count - left.count || left.commit.personId.localeCompare(right.commit.personId),
  )[0];
  return { personId: winner.commit.personId, displayName: winner.commit.displayName, unmapped: winner.commit.unmapped };
}
