import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import { loadAliases, resolveIdentity } from "../src/identity.js";

describe("aliases", () => {
  const people = loadAliases(path.join(repoRoot(), "people", "aliases.yaml"));

  it("maps Xiaodong's GitHub login and noreply email to one id", () => {
    const byLogin = resolveIdentity(people, { githubLogin: "XDLab2026", email: "other@example.com" });
    const byEmail = resolveIdentity(people, { email: "262348385+xdlab2026@users.noreply.github.com" });
    expect(byLogin).toEqual({ personId: "xiaodong-zhou", displayName: "Xiaodong Zhou", unmapped: false });
    expect(byEmail.personId).toBe("xiaodong-zhou");
    expect(byEmail.unmapped).toBe(false);
  });

  it("keeps an unknown author as a distinct flagged identity", () => {
    const resolved = resolveIdentity(people, { email: "nobody@example.com", name: "Nobody" });
    expect(resolved.unmapped).toBe(true);
    expect(resolved.personId).toBe("unmapped:email:nobody@example.com");
    expect(resolved.displayName).toBe("Nobody");
  });

  it("prefers a GitLab username over a conflicting email", () => {
    const resolved = resolveIdentity(
      [
        { id: "email-person", displayName: "Email Person", emails: ["shared@example.com"], githubLogins: [], gitlabUsernames: [] },
        { id: "gitlab-person", displayName: "GitLab Person", emails: [], githubLogins: [], gitlabUsernames: ["sam"] },
      ],
      { email: "shared@example.com", gitlabUsername: "sam" },
    );
    expect(resolved.personId).toBe("gitlab-person");
  });
});
