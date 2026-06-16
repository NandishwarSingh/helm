import "server-only";
import { createOpenAI } from "@ai-sdk/openai";

import { env } from "@/env";

// OpenRouter speaks the OpenAI protocol; DeepSeek does the thinking.
export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
  headers: { "X-Title": "Helm" },
});

export const AGENT_MODEL = "deepseek/deepseek-v4-flash";
export const TRIAGE_MODEL = "deepseek/deepseek-v4-flash";
