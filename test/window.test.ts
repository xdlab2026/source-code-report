import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock } from "../src/lock.js";
import { hourBucket, resolveWindow, shouldRunScheduled, weekdayInTimeZone } from "../src/window.js";

describe("window and cadence", () => {
  const now = new Date("2026-11-21T10:00:00Z");

  it("uses the past 24 hours or the last 7 days ending at run time", () => {
    const day = resolveWindow({ preset: "24h", now });
    const week = resolveWindow({ preset: "24h", now, override: "7d" });
    expect(day.until.getTime() - day.since.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(day.phrase).toBe("past 24 hours");
    expect(week.until.getTime() - week.since.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(week.phrase).toBe("last 7 days");
  });

  it("accepts an explicit since and until", () => {
    const window = resolveWindow({
      preset: "24h",
      now,
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-08T00:00:00Z",
    });
    expect(window.preset).toBe("custom");
    expect(window.phrase).toBe("the selected window");
    expect(window.since.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("runs a weekly cadence only on the configured weekday in Europe/Malta", () => {
    const monday = new Date("2026-11-16T06:30:00Z");
    const tuesday = new Date("2026-11-17T06:30:00Z");
    const sundayNightUtc = new Date("2026-11-15T23:30:00Z");
    expect(weekdayInTimeZone(sundayNightUtc, "Europe/Malta")).toBe("Mon");
    expect(shouldRunScheduled({ cadence: "daily", weeklyWeekday: "Mon", timezone: "Europe/Malta", now: tuesday }).run).toBe(true);
    expect(shouldRunScheduled({ cadence: "weekly", weeklyWeekday: "Mon", timezone: "Europe/Malta", now: monday }).run).toBe(true);
    expect(shouldRunScheduled({ cadence: "weekly", weeklyWeekday: "Mon", timezone: "Europe/Malta", now: tuesday }).run).toBe(false);
    expect(shouldRunScheduled({ cadence: "weekly", weeklyWeekday: "Mon", timezone: "Europe/Malta", now: sundayNightUtc }).run).toBe(true);
  });

  it("buckets a scheduled hour in Europe/Malta", () => {
    expect(hourBucket(new Date("2026-11-21T09:10:00Z"), "Europe/Malta")).toBe("2026-11-21T10");
    expect(hourBucket(new Date("2026-11-21T09:50:00Z"), "Europe/Malta")).toBe("2026-11-21T10");
    expect(hourBucket(new Date("2026-11-21T10:05:00Z"), "Europe/Malta")).toBe("2026-11-21T11");
  });

  it("refuses an overlapping run and allows a later one after release", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lock-"));
    const release = acquireRunLock(dir, "24h|dm|U0");
    expect(() => acquireRunLock(dir, "24h|dm|U0")).toThrow(/already in progress/i);
    release();
    const second = acquireRunLock(dir, "24h|dm|U0");
    second();
  });
});
