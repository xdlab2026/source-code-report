import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import { compileDenyList, globToRegExp, loadDenyList, scoreFiles } from "../src/noise.js";
import { file } from "./helpers.js";

describe("noise filter", () => {
  const rules = loadDenyList(path.join(repoRoot(), "config", "noise-deny.yaml"));
  const deny = compileDenyList(rules);

  it("matches lockfiles, generated files, and vendored directories", () => {
    expect(deny("package-lock.json").kind).toBe("lockfile");
    expect(deny("apps/web/package-lock.json").denied).toBe(true);
    expect(deny("Cargo.lock").denied).toBe(true);
    expect(deny("go.sum").denied).toBe(true);
    expect(deny("src/app.min.js").kind).toBe("generated");
    expect(deny("src/generated/types.ts").denied).toBe(true);
    expect(deny("pkg/vendor/lib/a.go").kind).toBe("vendored");
    expect(deny("third_party/openssl/ssl.c").denied).toBe(true);
    expect(deny("node_modules/left-pad/index.js").denied).toBe(true);
    expect(deny("src/app.ts").denied).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(globToRegExp("**/package-lock.json").test("App/Package-Lock.JSON")).toBe(true);
  });

  it("extends by adding a rule, with no code change", () => {
    const extended = compileDenyList([...rules, { id: "custom-gen", kind: "generated", pattern: "**/custom-gen/**" }]);
    expect(extended("src/custom-gen/out.ts").denied).toBe(true);
    expect(extended("src/app.ts").denied).toBe(false);
  });

  it("counts a lockfile-only commit as raw lines and about zero meaningful lines", () => {
    const score = scoreFiles([file("package-lock.json", 2000, 100)], deny);
    expect(score.rawLines).toBe(2100);
    expect(score.meaningfulLines).toBe(0);
    expect(score.meaningfulAdditions).toBe(0);
  });

  it("keeps source lines when a commit also touches a lockfile", () => {
    const score = scoreFiles([file("package-lock.json", 2000, 0), file("src/app.ts", 8, 2)], deny);
    expect(score.rawLines).toBe(2010);
    expect(score.meaningfulLines).toBe(10);
  });
});
