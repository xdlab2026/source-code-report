import { describe, expect, it } from "vitest";
import { DeliveryError } from "../src/errors.js";
import type { Report } from "../src/report.js";
import { deliverSlack } from "../src/slack.js";
import { json, recorded } from "./helpers.js";

function report(overrides: Partial<Report> = {}): Report {
  return {
    window: "24h",
    windowPhrase: "past 24 hours",
    timezone: "Europe/Malta",
    since: "2026-11-20T10:00:00.000Z",
    until: "2026-11-21T10:00:00.000Z",
    sinceLabel: "20/11/2026 11:00",
    untilLabel: "21/11/2026 11:00",
    destination: "dm",
    destinationId: "U0AFYENA7UJ",
    narrative: "Shipped the billing export.",
    runKey: "24h|2026-11-21T11|dm|U0AFYENA7UJ",
    people: [],
    projects: [],
    changeUnits: [],
    llm: { inputTokens: 1, outputTokens: 1, calls: 1, estimatedUsd: 0 },
    markdown: "",
    ...overrides,
  };
}

describe("Slack delivery", () => {
  it("DMs Xiaodong and attaches the CSV", async () => {
    const calls: string[] = [];
    const http = recorded((url, init) => {
      calls.push(new URL(url).pathname + (init.method ?? "GET"));
      if (url.includes("conversations.open")) {
        expect(JSON.parse(init.body ?? "{}").users).toBe("U0AFYENA7UJ");
        return json({ ok: true, channel: { id: "D777" } });
      }
      if (url.includes("conversations.history")) return json({ ok: true, messages: [] });
      if (url.includes("chat.postMessage")) {
        const text = JSON.parse(init.body ?? "{}").text as string;
        expect(text.indexOf("*Narrative*")).toBeLessThan(text.indexOf("*People*"));
        expect(JSON.parse(init.body ?? "{}").channel).toBe("D777");
        return json({ ok: true });
      }
      if (url.includes("files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" });
      if (url.includes("files.slack.com")) return json("ok", 200);
      if (url.includes("files.completeUploadExternal")) return json({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
    const result = await deliverSlack({ http, token: "xoxb-test", report: report(), csv: "section,window\n" });
    expect(result.posted).toBe(true);
    expect(calls.some((call) => call.includes("conversations.open"))).toBe(true);
  });

  it("posts to a channel without opening a DM", async () => {
    const http = recorded((url, init) => {
      if (url.includes("conversations.open")) throw new Error("should not open a DM");
      if (url.includes("conversations.history")) {
        expect(new URL(url).searchParams.get("channel")).toBe("C999");
        return json({ ok: true, messages: [] });
      }
      if (url.includes("chat.postMessage")) {
        expect(JSON.parse(init.body ?? "{}").channel).toBe("C999");
        return json({ ok: true });
      }
      if (url.includes("files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" });
      if (url.includes("files.slack.com")) return json("ok", 200);
      if (url.includes("files.completeUploadExternal")) return json({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
    const result = await deliverSlack({
      http,
      token: "xoxb-test",
      report: report({ destination: "channel", destinationId: "C999", runKey: "24h|bucket|channel|C999" }),
      csv: "section\n",
    });
    expect(result.posted).toBe(true);
    expect(result.channelId).toBe("C999");
  });

  it("does not post again when the run key is already in the channel", async () => {
    const http = recorded((url) => {
      if (url.includes("conversations.open")) return json({ ok: true, channel: { id: "D777" } });
      if (url.includes("conversations.history")) {
        return json({ ok: true, messages: [{ text: "old\nreport-key:24h|2026-11-21T11|dm|U0AFYENA7UJ" }] });
      }
      if (url.includes("chat.postMessage")) throw new Error("double post");
      throw new Error(`unexpected ${url}`);
    });
    const result = await deliverSlack({ http, token: "xoxb-test", report: report(), csv: "x" });
    expect(result).toMatchObject({ posted: false, duplicate: true });
  });

  it("fails closed when the token is missing or Slack rejects the channel", async () => {
    const http = recorded(() => json({ ok: true }));
    await expect(deliverSlack({ http, token: undefined, report: report(), csv: "x" })).rejects.toBeInstanceOf(DeliveryError);
    const bad = recorded((url) => {
      if (url.includes("conversations.history") || url.includes("conversations.open")) {
        return json({ ok: false, error: "channel_not_found" });
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      deliverSlack({
        http: bad,
        token: "xoxb-test",
        report: report({ destination: "channel", destinationId: "C_MISSING" }),
        csv: "x",
      }),
    ).rejects.toThrow(/channel_not_found/);
  });
});
