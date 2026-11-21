import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STALE_MS = 6 * 60 * 60 * 1000;

export function acquireRunLock(dir: string, key: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitize(key)}.lock`);
  try {
    writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
  } catch (error) {
    if (!isExists(error)) throw error;
    const age = Date.now() - statSync(file).mtimeMs;
    if (age < STALE_MS) {
      throw new Error(`Another run is already in progress for ${key}. The digest was not posted again.`);
    }
    rmSync(file, { force: true });
    writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
  }
  return () => {
    rmSync(file, { force: true });
  };
}

export function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function isExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
