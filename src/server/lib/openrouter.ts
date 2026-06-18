import "server-only";
import { createOpenAI } from "@ai-sdk/openai";

import { env } from "@/env";

/**
 * OpenRouter speaks the OpenAI protocol; DeepSeek does the thinking.
 *
 * We pin the upstream to DeepSeek's own deployment (`order` only — fallbacks stay
 * on, so a DeepSeek blip still answers) so its automatic prompt cache stays warm
 * across the agent loop's many steps. Without this, OpenRouter can re-route each
 * step to a different provider and cold-start the cache every time — the single
 * biggest source of the agent's latency, since each step re-sends the full,
 * growing prompt. Injected on the raw body so it rides every request, including
 * each step of a multi-step `streamText` run.
 */
export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
  headers: { "X-Title": "Helm" },
  fetch: async (input, init) => {
    if (init && typeof init.body === "string") {
      try {
        const json = JSON.parse(init.body) as Record<string, unknown>;
        json.provider = { order: ["deepseek"] };
        init = { ...init, body: JSON.stringify(json) };
      } catch {
        // Non-JSON body — forward it untouched.
      }
    }
    return fetch(input, init);
  },
});

export const AGENT_MODEL = "deepseek/deepseek-v4-flash";
export const TRIAGE_MODEL = "deepseek/deepseek-v4-flash";
