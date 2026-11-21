import type { LlmClient } from "./classifier.js";
import type { HttpClient } from "./http.js";
import { asArray, asRecord, num, shortBody, str } from "./json.js";

export function createAnthropicClient(http: HttpClient, apiKey: string): LlmClient {
  return {
    async complete(input) {
      const response = await http.request({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxTokens,
          system: input.system,
          messages: [{ role: "user", content: input.user }],
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Anthropic authentication failed (${response.status}). Check ANTHROPIC_API_KEY.`);
      }
      if (response.status === 429) throw new Error("Anthropic rate limit exceeded. The run did not finish.");
      if (response.status >= 300) {
        throw new Error(`Anthropic error ${response.status}: ${shortBody(response.body)}`);
      }
      const data = asRecord(JSON.parse(response.body) as unknown) ?? {};
      const text = asArray(data.content)
        .map((part) => str(asRecord(part)?.text))
        .join("");
      const usage = asRecord(data.usage) ?? {};
      return {
        text,
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
      };
    },
  };
}
