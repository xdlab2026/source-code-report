import type { CostTracker } from "./cost.js";
import type { LlmClient } from "./classifier.js";
import { narrativePayload, type Report } from "./report.js";

export async function writeNarrative(
  report: Pick<Report, "windowPhrase" | "people" | "projects" | "changeUnits">,
  client: LlmClient,
  options: { system: string; model: string; maxTokens: number; cost: CostTracker },
): Promise<string> {
  const response = await client.complete({
    system: options.system,
    user: `Window phrase: ${report.windowPhrase}\n\nNARRATIVE_DATA\n${JSON.stringify(narrativePayload(report))}`,
    model: options.model,
    maxTokens: options.maxTokens,
  });
  options.cost.add(response.inputTokens, response.outputTokens);
  const text = response.text.trim();
  if (!text) throw new Error("The narrative model returned an empty response. The digest was not posted.");
  return text;
}
