import { CollectorError } from "../errors.js";
import type { HttpClient } from "../http.js";
import { asArray, asRecord, num, shortBody, str } from "../json.js";
import type { CollectedCommit, FileChange, PullRef } from "../model.js";
import { releaseVersion } from "../model.js";
import { githubNextLink, isBotIdentity, isMergeCommit, unionBranches } from "./shared.js";

export interface GithubCollectInput {
  http: HttpClient;
  token: string;
  org: string;
  apiBase: string;
  since: Date;
  until: Date;
}

interface GithubRepo {
  fullName: string;
  name: string;
  url: string;
  defaultBranch: string | null;
}

export async function collectGithub(input: GithubCollectInput): Promise<CollectedCommit[]> {
  const repos = await listRepos(input);
  const commits = new Map<string, CollectedCommit>();
  for (const repo of repos) {
    const branches = await listBranchNames(input, repo.fullName);
    const wanted = new Set<string>();
    if (repo.defaultBranch) wanted.add(repo.defaultBranch);
    for (const branch of branches) {
      if (releaseVersion(branch)) wanted.add(branch);
    }
    const ordered = [...wanted].sort((left, right) => {
      if (left === repo.defaultBranch) return -1;
      if (right === repo.defaultBranch) return 1;
      return left.localeCompare(right);
    });
    for (const branch of ordered) {
      const listed = await listCommits(input, repo.fullName, branch);
      for (const item of listed) {
        const record = asRecord(item);
        if (!record) continue;
        const sha = str(record.sha);
        if (!sha) continue;
        const message = str(asRecord(record.commit)?.message);
        const parents = asArray(record.parents);
        const author = asRecord(record.author);
        const gitAuthor = asRecord(asRecord(record.commit)?.author);
        if (
          isMergeCommit({ parentCount: parents.length, message }) ||
          isBotIdentity({
            login: str(author?.login) || null,
            email: str(gitAuthor?.email) || null,
            name: str(gitAuthor?.name) || null,
            type: str(author?.type) || null,
          })
        ) {
          continue;
        }
        const key = `${repo.fullName}:${sha}`;
        const existing = commits.get(key);
        if (existing) {
          existing.branches = unionBranches(existing.branches, [branch]);
          continue;
        }
        const detail = await fetchCommitDetail(input, repo.fullName, sha, record);
        const pullRequest = await fetchPullRequest(input, repo.fullName, sha);
        commits.set(key, normalizeCommit(repo, branch, detail, pullRequest));
      }
    }
  }
  return [...commits.values()];
}

async function listRepos(input: GithubCollectInput): Promise<GithubRepo[]> {
  const url = new URL(`${trimBase(input.apiBase)}/orgs/${encodeURIComponent(input.org)}/repos`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("type", "all");
  const rows = await githubPages(input, url.toString());
  return rows.map((row) => {
    const record = asRecord(row) ?? {};
    return {
      fullName: str(record.full_name),
      name: str(record.name),
      url: str(record.html_url),
      defaultBranch: str(record.default_branch) || null,
    };
  }).filter((repo) => repo.fullName);
}

async function listBranchNames(input: GithubCollectInput, fullName: string): Promise<string[]> {
  const url = new URL(`${trimBase(input.apiBase)}/repos/${fullName}/branches`);
  url.searchParams.set("per_page", "100");
  const rows = await githubPages(input, url.toString());
  return rows.map((row) => str(asRecord(row)?.name)).filter(Boolean);
}

async function listCommits(input: GithubCollectInput, fullName: string, branch: string): Promise<unknown[]> {
  const url = new URL(`${trimBase(input.apiBase)}/repos/${fullName}/commits`);
  url.searchParams.set("sha", branch);
  url.searchParams.set("since", input.since.toISOString());
  url.searchParams.set("until", input.until.toISOString());
  url.searchParams.set("per_page", "100");
  try {
    return await githubPages(input, url.toString());
  } catch (error) {
    if (error instanceof CollectorError && error.status === 409 && /empty/i.test(error.message)) return [];
    throw error;
  }
}

async function fetchCommitDetail(
  input: GithubCollectInput,
  fullName: string,
  sha: string,
  listed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (asArray(listed.files).length > 0) return listed;
  const url = `${trimBase(input.apiBase)}/repos/${fullName}/commits/${sha}`;
  const data = await githubJson(input, url);
  const record = asRecord(data);
  if (!record) throw new CollectorError("api", `GitHub commit ${sha} was not an object.`, 200);
  return record;
}

async function fetchPullRequest(input: GithubCollectInput, fullName: string, sha: string): Promise<PullRef | null> {
  const url = `${trimBase(input.apiBase)}/repos/${fullName}/commits/${sha}/pulls`;
  let data: unknown;
  try {
    data = await githubJson(input, url, { allowStatuses: [404, 422] });
  } catch (error) {
    if (error instanceof CollectorError && (error.status === 404 || error.status === 422)) return null;
    throw error;
  }
  const first = asRecord(asArray(data)[0]);
  if (!first) return null;
  const number = num(first.number);
  if (!number) return null;
  return {
    number,
    title: str(first.title),
    description: str(first.body),
    url: str(first.html_url),
    authorLogin: str(asRecord(first.user)?.login) || null,
  };
}

function normalizeCommit(
  repo: GithubRepo,
  branch: string,
  detail: Record<string, unknown>,
  pullRequest: PullRef | null,
): CollectedCommit {
  const commit = asRecord(detail.commit) ?? {};
  const author = asRecord(commit.author) ?? {};
  const githubAuthor = asRecord(detail.author);
  const files = asArray(detail.files).map(normalizeFile).filter((file) => file.path);
  return {
    source: "github",
    sha: str(detail.sha),
    projectId: `github:${repo.fullName}`,
    projectName: repo.name || repo.fullName,
    projectUrl: repo.url,
    timestamp: str(asRecord(commit.committer)?.date) || str(author.date),
    message: str(commit.message),
    authorName: str(author.name),
    authorEmail: str(author.email),
    githubLogin: str(githubAuthor?.login) || null,
    gitlabUsername: null,
    authorType: str(githubAuthor?.type) || null,
    parentCount: asArray(detail.parents).length,
    branches: [branch],
    files,
    pullRequest,
    mergeRequest: null,
  };
}

function normalizeFile(value: unknown): FileChange {
  const record = asRecord(value) ?? {};
  return {
    path: str(record.filename) || str(record.path),
    additions: num(record.additions),
    deletions: num(record.deletions),
    patch: typeof record.patch === "string" ? record.patch : null,
  };
}

async function githubPages(input: GithubCollectInput, firstUrl: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let next: string | null = firstUrl;
  const seen = new Set<string>();
  while (next) {
    if (seen.has(next)) break;
    seen.add(next);
    const { data, link } = await githubJsonWithHeaders(input, next);
    if (!Array.isArray(data)) {
      throw new CollectorError("api", `GitHub list endpoint did not return a list: ${next}`, 200);
    }
    items.push(...data);
    next = githubNextLink(link);
  }
  return items;
}

async function githubJson(input: GithubCollectInput, url: string, options?: { allowStatuses?: number[] }): Promise<unknown> {
  const { data } = await githubJsonWithHeaders(input, url, options);
  return data;
}

async function githubJsonWithHeaders(
  input: GithubCollectInput,
  url: string,
  options?: { allowStatuses?: number[] },
): Promise<{ data: unknown; link?: string }> {
  const response = await input.http.request({
    url,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "User-Agent": "source-code-report",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const allowed = options?.allowStatuses ?? [];
  if (allowed.includes(response.status)) {
    return { data: [], link: response.headers.link };
  }
  if (response.status === 401) {
    throw new CollectorError(
      "auth",
      "GitHub authentication failed (401). Check the GITHUB_TOKEN_READONLY secret. This is not an empty window.",
      401,
    );
  }
  const remaining = response.headers["x-ratelimit-remaining"];
  const rateLimited = /rate limit/i.test(response.body);
  if (response.status === 429 || (response.status === 403 && (rateLimited || remaining === "0"))) {
    throw new CollectorError(
      "rate_limit",
      "GitHub rate limit exceeded. Nothing from this window was treated as empty activity.",
      response.status,
    );
  }
  if (response.status === 403) {
    throw new CollectorError(
      "auth",
      `GitHub authorization failed (403): ${shortBody(response.body)}. This is not an empty window.`,
      403,
    );
  }
  if (response.status === 409 && /empty/i.test(response.body)) {
    throw new CollectorError("api", shortBody(response.body) || "GitHub repository is empty.", 409);
  }
  if (response.status >= 300) {
    throw new CollectorError("api", `GitHub API ${response.status} for ${url}: ${shortBody(response.body)}`, response.status);
  }
  const data = response.body ? (JSON.parse(response.body) as unknown) : [];
  return { data, link: response.headers.link };
}

function trimBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "");
}
