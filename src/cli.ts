import { formatScore, loadFixtures, scoreFixtures } from "./eval.js";
import { runReport } from "./pipeline.js";
import type { WindowPreset } from "./config.js";

interface Flags {
  position: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string | true>();
  const position: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      position.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags.set(key, true);
    else {
      flags.set(key, next);
      index += 1;
    }
  }
  return { position, flags };
}

function flag(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const parsed = parseArgs(rest);
  if (command === "eval") {
    const score = scoreFixtures(loadFixtures(flag(parsed.flags, "fixtures")));
    process.stdout.write(`${formatScore(score)}\n`);
    if (score.bothAgreement < 0.8) process.exitCode = 1;
    return;
  }
  if (command !== "run") {
    throw new Error(`Unknown command ${command}. Use "run" or "eval".`);
  }
  if (parsed.flags.has("deliver") && parsed.flags.has("dry-run")) {
    throw new Error("Pass either --deliver or --dry-run, not both.");
  }
  const window = flag(parsed.flags, "window");
  if (window && window !== "24h" && window !== "7d") {
    throw new Error("--window must be 24h or 7d.");
  }
  const result = await runReport({
    configPath: flag(parsed.flags, "config"),
    scheduled: parsed.flags.has("scheduled"),
    deliver: parsed.flags.has("deliver"),
    window: window as WindowPreset | undefined,
    since: flag(parsed.flags, "since"),
    until: flag(parsed.flags, "until"),
    force: parsed.flags.has("force"),
  });
  process.stdout.write(`${JSON.stringify(result.log)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
  process.exitCode = 1;
});
