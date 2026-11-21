import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function receiptPath(dir: string): string {
  return path.join(dir, "delivered.json");
}

export function hasReceipt(dir: string, key: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(dir), "utf8")) as unknown;
    return Array.isArray(parsed) && parsed.includes(key);
  } catch {
    return false;
  }
}

export function rememberReceipt(dir: string, key: string): void {
  mkdirSync(dir, { recursive: true });
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(dir), "utf8")) as unknown;
    if (Array.isArray(parsed)) keys = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    keys = [];
  }
  if (!keys.includes(key)) keys.push(key);
  writeFileSync(receiptPath(dir), `${JSON.stringify(keys, null, 2)}\n`);
}
