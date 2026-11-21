import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import {
  aliasSnippet,
  creditAuthor,
  formatIdentityLog,
  identityMapping,
  loadAliases,
  resolveIdentity,
  type Credit,
} from "../src/identity.js";
import { scoreCommits } from "../src/metrics.js";
import { compileDenyList, loadDenyList } from "../src/noise.js";
import { buildChangeUnits } from "../src/units.js";
import { commit } from "./helpers.js";

describe("aliases", () => {
  const people = loadAliases(path.join(repoRoot(), "people", "aliases.yaml"));
  const deny = compileDenyList(loadDenyList(path.join(repoRoot(), "config", "noise-deny.yaml")));

  it("maps Xiaodong's GitHub login and noreply email to one id", () => {
    const byLogin = resolveIdentity(people, { githubLogin: "XDLab2026", email: "other@example.com" });
    const byEmail = resolveIdentity(people, { email: "262348385+xdlab2026@users.noreply.github.com" });
    expect(byLogin).toEqual({ personId: "xiaodong-zhou", displayName: "Xiaodong Zhou", unmapped: false, matchedBy: "github" });
    expect(byEmail.personId).toBe("xiaodong-zhou");
    expect(byEmail.matchedBy).toBe("email");
  });

  it("maps Xiaodong's second login, presight email, and Watson X machine emails", () => {
    expect(resolveIdentity(people, { githubLogin: "xiaodong-zhou", email: "someone@example.com" }).personId).toBe("xiaodong-zhou");
    expect(resolveIdentity(people, { email: "Xiaodong.Zhou@Presight.ai", name: "Xiaodong Zhou" }).personId).toBe("xiaodong-zhou");
    expect(resolveIdentity(people, { email: "watsonx@localhost", name: "Watson X" }).personId).toBe("xiaodong-zhou");
    expect(resolveIdentity(people, { email: "watsonx@Watsons-Mac-Studio-3.local", name: "Watson X" }).personId).toBe("xiaodong-zhou");
  });

  it("does not fuzzy-merge a new Watson X email", () => {
    const resolved = resolveIdentity(people, { email: "watsonx@other.local", name: "Watson X" });
    expect(resolved.unmapped).toBe(true);
    expect(resolved.personId).toBe("unmapped:email:watsonx@other.local");
  });

  it("maps taolu's emails and login, and Sharon's email and GitLab username", () => {
    expect(resolveIdentity(people, { email: "treklife@126.com", name: "taolu" }).personId).toBe("taolu");
    expect(resolveIdentity(people, { email: "tao.l@xdlab.ai", githubLogin: "taolu-ai" }).personId).toBe("taolu");
    expect(resolveIdentity(people, { githubLogin: "taolu-ai", email: "other@example.com" }).personId).toBe("taolu");
    expect(resolveIdentity(people, { email: "sharon@Sharons-MacBook-Pro.local", name: "Sharon" }).personId).toBe("sharon");
    expect(resolveIdentity(people, { gitlabUsername: "Sharon-L", email: "other@example.com" }).personId).toBe("sharon");
  });

  it("keeps an unknown author as a distinct flagged identity keyed by email", () => {
    const resolved = resolveIdentity(people, { email: "nobody@example.com", githubLogin: "nobody", name: "Nobody" });
    expect(resolved.unmapped).toBe(true);
    expect(resolved.personId).toBe("unmapped:email:nobody@example.com");
    expect(resolved.displayName).toBe("Nobody");
  });

  it("prefers an email alias over a conflicting GitLab username", () => {
    const resolved = resolveIdentity(
      [
        { id: "email-person", displayName: "Email Person", emails: ["shared@example.com"], githubLogins: [], gitlabUsernames: [] },
        { id: "gitlab-person", displayName: "GitLab Person", emails: [], githubLogins: [], gitlabUsernames: ["sam"] },
      ],
      { email: "shared@example.com", gitlabUsername: "sam" },
    );
    expect(resolved.personId).toBe("email-person");
    expect(resolved.matchedBy).toBe("email");
  });

  it("matches a GitLab username when the email is not aliased", () => {
    const resolved = resolveIdentity(
      [{ id: "gitlab-person", displayName: "GitLab Person", emails: [], githubLogins: [], gitlabUsernames: ["sam"] }],
      { email: "sam@example.com", gitlabUsername: "Sam" },
    );
    expect(resolved.personId).toBe("gitlab-person");
    expect(resolved.matchedBy).toBe("gitlab");
  });

  it("credits a tool commit to the first human co-author", () => {
    const credit = creditAuthor(people, {
      authorName: "Claude",
      authorEmail: "noreply@anthropic.com",
      githubLogin: "claude",
      gitlabUsername: null,
      message: "docs\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Sharon <sharon@Sharons-MacBook-Pro.local>",
      pullRequest: { authorLogin: "taolu-ai" },
      mergeRequest: null,
    });
    expect(credit.personId).toBe("sharon");
    expect(credit.toolOnly).toBe(false);
    expect(credit.via).toBe("tool-coauthor");
  });

  it("credits a tool with no human trailer to the pull request author", () => {
    const credit = creditAuthor(people, {
      authorName: "Claude",
      authorEmail: "noreply@anthropic.com",
      githubLogin: "claude",
      gitlabUsername: null,
      message: "docs\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
      pullRequest: { authorLogin: "xdlab2026" },
      mergeRequest: null,
    });
    expect(credit.personId).toBe("xiaodong-zhou");
    expect(credit.via).toBe("tool-pr");
    expect(credit.toolOnly).toBe(false);
  });

  it("leaves Claude and AppBuilder Bot uncredited when no human is available", () => {
    const claude = creditAuthor(people, {
      authorName: "Claude",
      authorEmail: "noreply@anthropic.com",
      githubLogin: "claude",
      gitlabUsername: null,
      message: "docs\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
      pullRequest: null,
      mergeRequest: null,
    });
    const bot = creditAuthor(people, {
      authorName: "AppBuilder Bot",
      authorEmail: "bot@xdlab.ai",
      githubLogin: null,
      gitlabUsername: null,
      message: "feat\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      pullRequest: null,
      mergeRequest: null,
    });
    expect(claude.toolOnly).toBe(true);
    expect(claude.personId).toBe("unmapped:tool:noreply@anthropic.com");
    expect(bot.toolOnly).toBe(true);
    expect(bot.personId).toBe("unmapped:tool:bot@xdlab.ai");
    expect(bot.personId).not.toBe("xiaodong-zhou");
  });

  it("prints applied aliases and a paste-ready snippet for a new identity", () => {
    const mapped = scoredCredit(
      commit({
        sha: "wx",
        authorName: "Watson X",
        authorEmail: "watsonx@localhost",
        githubLogin: null,
        projectName: "people-wiki",
      }),
      people,
      deny,
    );
    const tool = scoredCredit(
      commit({
        sha: "bot",
        authorName: "AppBuilder Bot",
        authorEmail: "bot@xdlab.ai",
        githubLogin: null,
        message: "feat\n\nCo-authored-by: Claude <noreply@anthropic.com>",
        projectName: "simple-calculator-appbuilder-demo02",
      }),
      people,
      deny,
    );
    const mapping = identityMapping([mapped, tool]);
    expect(mapping.applied.map((group) => group.displayName)).toEqual(["Xiaodong Zhou"]);
    expect(mapping.applied[0].rows[0]).toMatchObject({
      seen: "Watson X <watsonx@localhost>",
      via: "email alias",
      commits: 1,
    });
    expect(mapping.unmapped).toHaveLength(1);
    expect(mapping.unmapped[0].tool).toBe(true);
    expect(mapping.unmapped[0].projects).toEqual(["simple-calculator-appbuilder-demo02"]);
    expect(mapping.unmapped[0].snippet).toBe(
      aliasSnippet({
        displayName: "AppBuilder Bot",
        emails: ["bot@xdlab.ai"],
        githubLogins: [],
        gitlabUsernames: [],
      }),
    );
    const log = formatIdentityLog(mapping);
    expect(log).toContain("Watson X <watsonx@localhost> → Xiaodong Zhou — 1 commit (email alias)");
    expect(log).toContain("Not credited to a person.");
    expect(log).toContain("  - id: appbuilder-bot");
    expect(log).toContain("      - bot@xdlab.ai");
  });

  it("keeps the commit author when the pull request was opened by someone else", () => {
    const scored = scoreCommits(
      [
        commit({
          sha: "sharon",
          authorName: "Sharon",
          authorEmail: "sharon@Sharons-MacBook-Pro.local",
          githubLogin: null,
          pullRequest: {
            number: 5,
            title: "Port",
            description: "",
            url: "https://example.com/5",
            authorLogin: "taolu-ai",
          },
        }),
      ],
      people,
      deny,
    );
    const units = buildChangeUnits(scored, deny);
    expect(scored[0].personId).toBe("sharon");
    expect(units[0].personId).toBe("sharon");
    expect(units[0].authors[0].personId).toBe("sharon");
  });
});

function scoredCredit(sample: ReturnType<typeof commit>, people: ReturnType<typeof loadAliases>, deny: ReturnType<typeof compileDenyList>): Credit & { projectName: string } {
  const [scored] = scoreCommits([sample], people, deny);
  return scored;
}
