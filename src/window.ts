import type { WindowPreset } from "./config.js";

export interface TimeWindow {
  preset: WindowPreset | "custom";
  since: Date;
  until: Date;
  phrase: string;
}

const DURATION_MS: Record<WindowPreset, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function windowPhrase(preset: WindowPreset | "custom"): string {
  if (preset === "24h") return "past 24 hours";
  if (preset === "7d") return "last 7 days";
  return "the selected window";
}

export function resolveWindow(input: {
  preset: WindowPreset;
  now: Date;
  override?: WindowPreset;
  since?: string;
  until?: string;
}): TimeWindow {
  if (input.since || input.until) {
    if (!input.since || !input.until) {
      throw new Error("Both --since and --until are required for an explicit window.");
    }
    const since = new Date(input.since);
    const until = new Date(input.until);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      throw new Error("--since and --until must be ISO timestamps.");
    }
    if (since >= until) throw new Error("--since must be earlier than --until.");
    const preset = input.override ?? "custom";
    return { preset, since, until, phrase: windowPhrase(preset) };
  }
  const preset = input.override ?? input.preset;
  const until = input.now;
  const since = new Date(until.getTime() - DURATION_MS[preset]);
  return { preset, since, until, phrase: windowPhrase(preset) };
}

export function weekdayInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
}

export function formatInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(",", "");
}

export function hourBucket(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

export function shouldRunScheduled(input: {
  cadence: "daily" | "weekly";
  weeklyWeekday: string;
  timezone: string;
  now: Date;
}): { run: boolean; reason?: string } {
  if (input.cadence === "daily") return { run: true };
  const weekday = weekdayInTimeZone(input.now, input.timezone);
  if (weekday === input.weeklyWeekday) return { run: true };
  return {
    run: false,
    reason: `cadence is weekly; ${weekday} is not ${input.weeklyWeekday} in ${input.timezone}`,
  };
}

export function inWindow(iso: string | null | undefined, since: Date, until: Date): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return false;
  return time >= since.getTime() && time <= until.getTime();
}
