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

export interface ResolvedIdentity {
  personId: string;
  displayName: string;
  unmapped: boolean;
}

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

  const byLogin = login ? people.find((person) => person.githubLogins.includes(login)) : undefined;
  if (byLogin) return mapped(byLogin);
  const byGitlab = gitlab ? people.find((person) => person.gitlabUsernames.includes(gitlab)) : undefined;
  if (byGitlab) return mapped(byGitlab);
  const byEmail = email ? people.find((person) => person.emails.includes(email)) : undefined;
  if (byEmail) return mapped(byEmail);

  const key = login || gitlab || email || author.name?.trim().toLowerCase() || "anonymous";
  const kind = login ? "github" : gitlab ? "gitlab" : email ? "email" : "name";
  return {
    personId: `unmapped:${kind}:${key}`,
    displayName: author.name?.trim() || login || gitlab || email || "Unknown author",
    unmapped: true,
  };
}

function mapped(person: Person): ResolvedIdentity {
  return { personId: person.id, displayName: person.displayName, unmapped: false };
}
