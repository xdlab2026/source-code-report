import { CollectorError } from "../errors.js";
import type { HttpClient } from "../http.js";
import { asArray, asRecord, num, shortBody, str } from "../json.js";
import type { CollectedCommit, FileChange, MergeRef, ReleaseRecord } from "../model.js";
import { releaseVersion } from "../model.js";
import { countUnifiedDiff } from "../noise.js";
import { inWindow } from "../window.js";
import { isBotIdentity, isMergeCommit, unionBranches } from "./shared.js";

export interface GitlabCollectInput {
  http: HttpClient;
  token: string;
  baseUrl: string;
  group: string;
  since: Date;
  until: Date;
}

interface GitlabProject {
  id: number;
  name: string;
  path: string;
  url: string;
  defaultBranch: string | null;
}

export interface GitlabCollection {
  commits: CollectedCommit[];
  releases: ReleaseRecord[];
}

export async function collectGitlab(input: GitlabCollectInput): Promise<GitlabCollection> {
  const projects = await listProjects(input);
  const commits = new Map<string, CollectedCommit>();
  const releases: ReleaseRecord[] = [];
  for (const project of projects) {
    const branches = await listBranches(input, project.id);
    const wanted = new Set<string>();
    if (project.defaultBranch) wanted.add(project.defaultBranch);
    for (const branch of branches) {
      if (releaseVersion(branch.name)) wanted.add(branch.name);
    }
    const ordered = [...wanted].sort((left, right) => {
      if (left === project.defaultBranch) return -1;
      if (right === project.defaultBranch) return 1;
      return left.localeCompare(right);
    });
    for (const branch of ordered) {
      const listed = await listCommits(input, project.id, branch);
      for (const item of listed) {
        const record = asRecord(item);
        if (!record) continue;
        const sha = str(record.id);
        if (!sha) continue;
        const message = str(record.message) || str(record.title);
        const parents = asArray(record.parent_ids);
        if (
          isMergeCommit({ parentCount: parents.length, message }) ||
          isBotIdentity({
            email: str(record.author_email) || null,
            name: str(record.author_name) || null,
          })
        ) {
          continue;
        }
        const key = `${project.path}:${sha}`;
        const existing = commits.get(key);
        if (existing) {
          existing.branches = unionBranches(existing.branches, [branch]);
          continue;
        }
        const files = await fetchDiff(input, project.id, sha, record);
        const mergeRequest = await fetchCommitMergeRequest(input, project.id, sha);
        commits.set(key, normalizeCommit(project, branch, record, files, mergeRequest));
      }
    }
    releases.push(...(await detectReleases(input, project, branches)));
  }
  return { commits: [...commits.values()], releases };
}

async function listProjects(input: GitlabCollectInput): Promise<GitlabProject[]> {
  const url = new URL(`${trimBase(input.baseUrl)}/api/v4/groups/${encodeURIComponent(input.group)}/projects`);
  url.searchParams.set("include_subgroups", "true");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("archived", "false");
  const rows = await gitlabPages(input, url.toString(), { missingGroupIsError: true });
  return rows.map((row) => {
    const record = asRecord(row) ?? {};
    return {
      id: num(record.id),
      name: str(record.name),
      path: str(record.path_with_namespace),
      url: str(record.web_url),
      defaultBranch: str(record.default_branch) || null,
    };
  }).filter((project) => project.id && project.path);
}

interface GitlabBranch {
  name: string;
  committedAt: string | null;
  authorName: string | null;
  authorEmail: string | null;
  url: string | null;
}

async function listBranches(input: GitlabCollectInput, projectId: number): Promise<GitlabBranch[]> {
  const url = new URL(`${trimBase(input.baseUrl)}/api/v4/projects/${projectId}/repository/branches`);
  url.searchParams.set("per_page", "100");
  const rows = await gitlabPages(input, url.toString());
  return rows.map((row) => {
    const record = asRecord(row) ?? {};
    const commit = asRecord(record.commit) ?? {};
    return {
      name: str(record.name),
      committedAt: str(commit.committed_date) || str(commit.authored_date) || str(commit.created_at) || null,
      authorName: str(commit.author_name) || null,
      authorEmail: str(commit.author_email) || null,
      url: str(record.web_url) || null,
    };
  }).filter((branch) => branch.name);
}

async function listCommits(input: GitlabCollectInput, projectId: number, branch: string): Promise<unknown[]> {
  const url = new URL(`${trimBase(input.baseUrl)}/api/v4/projects/${projectId}/repository/commits`);
  url.searchParams.set("ref_name", branch);
  url.searchParams.set("since", input.since.toISOString());
  url.searchParams.set("until", input.until.toISOString());
  url.searchParams.set("per_page", "100");
  url.searchParams.set("with_stats", "true");
  return gitlabPages(input, url.toString(), { notFoundIsEmpty: true });
}

async function fetchDiff(
  input: GitlabCollectInput,
  projectId: number,
  sha: string,
  commit: Record<string, unknown>,
): Promise<FileChange[]> {
  const embedded = asArray(commit.diff);
  const rows = embedded.length > 0 ? embedded : await fetchDiffRows(input, projectId, sha);
  const files = rows.map((row) => {
    const record = asRecord(row) ?? {};
    const diff = str(record.diff);
    const counts = countUnifiedDiff(diff);
    return {
      path: str(record.new_path) || str(record.old_path),
      additions: counts.additions,
      deletions: counts.deletions,
      patch: diff || null,
    };
  }).filter((file) => file.path);
  if (files.length > 0) return files;
  const stats = asRecord(commit.stats);
  if (!stats) return [];
  return [
    {
      path: "<unspecified>",
      additions: num(stats.additions),
      deletions: num(stats.deletions),
      patch: null,
    },
  ];
}

async function fetchDiffRows(input: GitlabCollectInput, projectId: number, sha: string): Promise<unknown[]> {
  const url = `${trimBase(input.baseUrl)}/api/v4/projects/${projectId}/repository/commits/${sha}/diff`;
  const data = await gitlabJson(input, url, { notFoundIsEmpty: true });
  return asArray(data);
}

async function fetchCommitMergeRequest(
  input: GitlabCollectInput,
  projectId: number,
  sha: string,
): Promise<MergeRef | null> {
  const url = `${trimBase(input.baseUrl)}/api/v4/projects/${projectId}/repository/commits/${sha}/merge_requests`;
  const data = await gitlabJson(input, url, { notFoundIsEmpty: true });
  const first = asRecord(asArray(data)[0]);
  if (!first) return null;
  const iid = num(first.iid);
  if (!iid) return null;
  return {
    iid,
    title: str(first.title),
    description: str(first.description),
    url: str(first.web_url),
    authorUsername: str(asRecord(first.author)?.username) || null,
  };
}

async function detectReleases(
  input: GitlabCollectInput,
  project: GitlabProject,
  branches: GitlabBranch[],
): Promise<ReleaseRecord[]> {
  const byVersion = new Map<string, ReleaseRecord>();
  for (const branch of branches) {
    const version = releaseVersion(branch.name);
    if (!version || !inWindow(branch.committedAt, input.since, input.until)) continue;
    byVersion.set(version, {
      source: "gitlab",
      projectId: `gitlab:${project.path}`,
      projectName: project.name || project.path,
      version,
      branch: branch.name,
      timestamp: branch.committedAt ?? input.until.toISOString(),
      authorName: branch.authorName,
      authorEmail: branch.authorEmail,
      gitlabUsername: null,
      url: branch.url,
    });
  }
  const merged = await listMergedRequests(input, project.id);
  for (const row of merged) {
    const record = asRecord(row);
    if (!record) continue;
    const mergedAt = str(record.merged_at);
    if (!inWindow(mergedAt, input.since, input.until)) continue;
    const sourceBranch = str(record.source_branch);
    const targetBranch = str(record.target_branch);
    const branch = releaseVersion(sourceBranch) ? sourceBranch : releaseVersion(targetBranch) ? targetBranch : "";
    const version = branch ? releaseVersion(branch) : null;
    if (!version || !branch) continue;
    const merger = asRecord(record.merged_by);
    const author = asRecord(record.author);
    const existing = byVersion.get(version);
    byVersion.set(version, {
      source: "gitlab",
      projectId: `gitlab:${project.path}`,
      projectName: project.name || project.path,
      version,
      branch,
      timestamp: mergedAt,
      authorName: str(merger?.name) || existing?.authorName || null,
      authorEmail: existing?.authorEmail ?? null,
      gitlabUsername: str(merger?.username) || str(author?.username) || existing?.gitlabUsername || null,
      url: str(record.web_url) || existing?.url || null,
    });
  }
  return [...byVersion.values()];
}

async function listMergedRequests(input: GitlabCollectInput, projectId: number): Promise<unknown[]> {
  const url = new URL(`${trimBase(input.baseUrl)}/api/v4/projects/${projectId}/merge_requests`);
  url.searchParams.set("state", "merged");
  url.searchParams.set("updated_after", input.since.toISOString());
  url.searchParams.set("per_page", "100");
  return gitlabPages(input, url.toString(), { notFoundIsEmpty: true });
}

function normalizeCommit(
  project: GitlabProject,
  branch: string,
  record: Record<string, unknown>,
  files: FileChange[],
  mergeRequest: MergeRef | null,
): CollectedCommit {
  return {
    source: "gitlab",
    sha: str(record.id),
    projectId: `gitlab:${project.path}`,
    projectName: project.name || project.path,
    projectUrl: project.url,
    timestamp: str(record.committed_date) || str(record.authored_date),
    message: str(record.message) || str(record.title),
    authorName: str(record.author_name),
    authorEmail: str(record.author_email),
    githubLogin: null,
    gitlabUsername: null,
    authorType: null,
    parentCount: asArray(record.parent_ids).length,
    branches: [branch],
    files,
    pullRequest: null,
    mergeRequest,
  };
}

async function gitlabPages(
  input: GitlabCollectInput,
  firstUrl: string,
  options?: { missingGroupIsError?: boolean; notFoundIsEmpty?: boolean },
): Promise<unknown[]> {
  const items: unknown[] = [];
  let next: string | null = firstUrl;
  const seen = new Set<string>();
  while (next) {
    if (seen.has(next)) break;
    seen.add(next);
    const page = await gitlabRequest(input, next, options);
    if (page.empty) break;
    if (!Array.isArray(page.data)) {
      throw new CollectorError("api", `GitLab list endpoint did not return a list: ${next}`, 200);
    }
    items.push(...page.data);
    if (!page.nextPage) break;
    next = withPage(next, page.nextPage);
  }
  return items;
}

async function gitlabJson(
  input: GitlabCollectInput,
  url: string,
  options?: { notFoundIsEmpty?: boolean },
): Promise<unknown> {
  const page = await gitlabRequest(input, url, options);
  return page.empty ? [] : page.data;
}

async function gitlabRequest(
  input: GitlabCollectInput,
  url: string,
  options?: { missingGroupIsError?: boolean; notFoundIsEmpty?: boolean },
): Promise<{ data: unknown; nextPage: string | null; empty: boolean }> {
  const response = await input.http.request({
    url,
    headers: {
      "PRIVATE-TOKEN": input.token,
      Accept: "application/json",
      "User-Agent": "source-code-report",
    },
  });
  if (response.status === 401) {
    throw new CollectorError(
      "auth",
      "GitLab authentication failed (401). Check the GITLAB_TOKEN secret. This is not an empty window.",
      401,
    );
  }
  if (response.status === 429 || (response.status === 403 && /rate limit/i.test(response.body))) {
    throw new CollectorError(
      "rate_limit",
      "GitLab rate limit exceeded. Nothing from this window was treated as empty activity.",
      response.status,
    );
  }
  if (response.status === 403) {
    throw new CollectorError(
      "auth",
      `GitLab authorization failed (403): ${shortBody(response.body)}. This is not an empty window.`,
      403,
    );
  }
  if (response.status === 404) {
    if (options?.missingGroupIsError) {
      throw new CollectorError(
        "api",
        `GitLab group ${input.group} was not found or is not visible to the token (404). This is not an empty window.`,
        404,
      );
    }
    if (options?.notFoundIsEmpty) return { data: [], nextPage: null, empty: true };
    throw new CollectorError("api", `GitLab API 404 for ${url}`, 404);
  }
  if (response.status >= 300) {
    throw new CollectorError("api", `GitLab API ${response.status} for ${url}: ${shortBody(response.body)}`, response.status);
  }
  const data = response.body ? (JSON.parse(response.body) as unknown) : [];
  const nextPage = response.headers["x-next-page"]?.trim() || null;
  return { data, nextPage, empty: false };
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function withPage(input: string, pageNumber: string): string {
  const parsed = new URL(input);
  parsed.searchParams.set("page", pageNumber);
  return parsed.toString();
}
