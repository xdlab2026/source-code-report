export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullRef {
  number: number;
  title: string;
  description: string;
  url: string;
  authorLogin: string | null;
}

export interface MergeRef {
  iid: number;
  title: string;
  description: string;
  url: string;
  authorUsername: string | null;
}

export interface CollectedCommit {
  source: "github" | "gitlab";
  sha: string;
  projectId: string;
  projectName: string;
  projectUrl: string;
  timestamp: string;
  message: string;
  authorName: string;
  authorEmail: string;
  githubLogin: string | null;
  gitlabUsername: string | null;
  authorType: string | null;
  parentCount: number;
  branches: string[];
  files: FileChange[];
  pullRequest: PullRef | null;
  mergeRequest: MergeRef | null;
}

export interface ReleaseRecord {
  source: "gitlab";
  projectId: string;
  projectName: string;
  version: string;
  branch: string;
  timestamp: string;
  authorName: string | null;
  authorEmail: string | null;
  gitlabUsername: string | null;
  url: string | null;
}

export const RELEASE_BRANCH = /^release\/(\d+\.\d+\.\d+)$/;

export function releaseVersion(branch: string): string | null {
  const match = RELEASE_BRANCH.exec(branch.trim());
  return match ? match[1] : null;
}
