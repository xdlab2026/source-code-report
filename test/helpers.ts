import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { CollectedCommit, FileChange } from "../src/model.js";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
}

export function recorded(handler: (url: string, init: HttpRequest) => HttpResponse): {
  urls: string[];
  request: (input: HttpRequest) => Promise<HttpResponse>;
} {
  const urls: string[] = [];
  return {
    urls,
    request(input) {
      urls.push(input.url);
      return Promise.resolve(handler(input.url, input));
    },
  };
}

export function file(path: string, additions: number, deletions = 0): FileChange {
  return { path, additions, deletions, patch: `+${path}` };
}

export function commit(overrides: Partial<CollectedCommit> & Pick<CollectedCommit, "sha">): CollectedCommit {
  return {
    source: "github",
    projectId: "github:XDLAB-AI/api",
    projectName: "api",
    projectUrl: "https://github.com/XDLAB-AI/api",
    timestamp: "2026-11-21T09:00:00Z",
    message: "feat: add a helper",
    authorName: "Xiaodong Zhou",
    authorEmail: "262348385+xdlab2026@users.noreply.github.com",
    githubLogin: "xdlab2026",
    gitlabUsername: null,
    authorType: "User",
    parentCount: 1,
    branches: ["main"],
    files: [file("src/app.ts", 10, 1)],
    pullRequest: null,
    mergeRequest: null,
    ...overrides,
  };
}
