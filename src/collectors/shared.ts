export function isBotIdentity(input: {
  login?: string | null;
  email?: string | null;
  name?: string | null;
  type?: string | null;
}): boolean {
  if (input.type === "Bot") return true;
  const blob = `${input.login ?? ""} ${input.email ?? ""} ${input.name ?? ""}`;
  if (/\[bot\]/i.test(blob)) return true;
  return /\b(dependabot|renovate|github-actions|semantic-release|snyk-bot|imgbot|pyup-bot)\b/i.test(blob);
}

export function isMergeCommit(input: { parentCount: number; message: string }): boolean {
  if (input.parentCount > 1) return true;
  return /^merge(\s+remote-tracking)?\s+(branch|pull request)\b/i.test(input.message.trim());
}

export function githubNextLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export function unionBranches(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}
