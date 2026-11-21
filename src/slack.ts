import { DeliveryError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { asArray, asRecord, str } from "./json.js";
import { formatDigest, type Report } from "./report.js";

export interface DeliveryResult {
  posted: boolean;
  duplicate: boolean;
  channelId: string;
}

export async function findExistingDelivery(input: {
  http: HttpClient;
  token: string;
  destination: "dm" | "channel";
  destinationId: string;
  runKey: string;
}): Promise<{ duplicate: boolean; channelId: string }> {
  const channelId = await resolveChannel(input.http, input.token, input.destination, input.destinationId);
  const history = await slack(input.http, input.token, "conversations.history", {
    method: "GET",
    query: { channel: channelId, limit: "100" },
  });
  const marker = `report-key:${input.runKey}`;
  const duplicate = asArray(asRecord(history)?.messages).some((message) => str(asRecord(message)?.text).includes(marker));
  return { duplicate, channelId };
}

export async function deliverSlack(input: {
  http: HttpClient;
  token: string | undefined;
  report: Report;
  pdf: Uint8Array;
  force?: boolean;
}): Promise<DeliveryResult> {
  if (!input.token) {
    throw new DeliveryError("Missing SLACK_BOT_TOKEN. The digest was not posted.");
  }
  const existing = await findExistingDelivery({
    http: input.http,
    token: input.token,
    destination: input.report.destination,
    destinationId: input.report.destinationId,
    runKey: input.report.runKey,
  });
  if (existing.duplicate && !input.force) {
    return { posted: false, duplicate: true, channelId: existing.channelId };
  }
  const text = formatDigest(input.report);
  await slack(input.http, input.token, "chat.postMessage", {
    json: { channel: existing.channelId, text, unfurl_links: false, unfurl_media: false },
  });
  await uploadPdf(input.http, input.token, existing.channelId, input.pdf, input.report);
  return { posted: true, duplicate: false, channelId: existing.channelId };
}

async function resolveChannel(
  http: HttpClient,
  token: string,
  destination: "dm" | "channel",
  destinationId: string,
): Promise<string> {
  if (!destinationId) {
    throw new DeliveryError(
      destination === "channel"
        ? "slack.channel_id is empty. Set it or switch slack.destination to dm. The digest was not posted."
        : "slack.user_id is empty. The digest was not posted.",
    );
  }
  if (destination === "channel") return destinationId;
  const opened = await slack(http, token, "conversations.open", { json: { users: destinationId } });
  const channel = str(asRecord(asRecord(opened)?.channel)?.id);
  if (!channel) throw new DeliveryError("Slack conversations.open did not return a DM channel. The digest was not posted.");
  return channel;
}

async function uploadPdf(http: HttpClient, token: string, channelId: string, pdf: Uint8Array, report: Report): Promise<void> {
  const filename = `engineering-activity-${report.until.slice(0, 10)}.pdf`;
  const slot = await slack(http, token, "files.getUploadURLExternal", {
    form: { filename, length: String(pdf.byteLength) },
  });
  const uploadUrl = str(asRecord(slot)?.upload_url);
  const fileId = str(asRecord(slot)?.file_id);
  if (!uploadUrl || !fileId) throw new DeliveryError("Slack did not return a file upload URL. The PDF was not attached.");
  const uploaded = await http.request({
    url: uploadUrl,
    method: "POST",
    headers: { "content-type": "application/pdf" },
    bytes: pdf,
  });
  if (uploaded.status >= 300) {
    throw new DeliveryError(`Slack file upload failed (${uploaded.status}). The digest may be missing its PDF.`);
  }
  await slack(http, token, "files.completeUploadExternal", {
    json: {
      files: [{ id: fileId, title: "Engineering activity" }],
      channel_id: channelId,
      initial_comment: "PDF for this digest.",
    },
  });
}

async function slack(
  http: HttpClient,
  token: string,
  method: string,
  body: { json?: unknown; form?: Record<string, string>; method?: "GET"; query?: Record<string, string> },
): Promise<unknown> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(body.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let payload: string | undefined;
  if (body.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body.form).toString();
  } else if (body.json) {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body.json);
  }
  const response = await http.request({ url: url.toString(), method: body.method ?? (payload ? "POST" : "GET"), headers, body: payload });
  let data: unknown;
  try {
    data = response.body ? (JSON.parse(response.body) as unknown) : {};
  } catch {
    throw new DeliveryError(`Slack ${method} returned a non-JSON response (${response.status}). The digest was not posted.`);
  }
  const record = asRecord(data);
  if (!record || record.ok !== true) {
    const error = str(record?.error) || `HTTP ${response.status}`;
    throw new DeliveryError(`Slack ${method} failed: ${error}. The digest was not posted.`);
  }
  return data;
}
