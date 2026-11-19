// The Claude helper from video-pipeline (src/claude.mjs), trimmed for clipping:
// one streamed turn with structured output and a cost line.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "./env.mjs";

export const MODEL = "claude-opus-5-5";

let client;
export const claudeConfigured = () => Boolean(loadEnv().ANTHROPIC_API_KEY);

// Prompts live in src/prompts/*.md so they can be tuned without touching code.
export function prompt(name, vars = {}) {
  const text = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompts/${name}.md uses {{${key}}}, which wasn't provided`);
    return vars[key];
  });
}

// Opus 5.5 list prices (USD), for a rough cost line after each call.
const PRICE = { input: 4e-6, cacheWrite: 5e-6, cacheRead: 0.2e-6, output: 20e-6 };
let spent = 0;
export const totalSpent = () => spent;

function logUsage(label, usage) {
  const cost =
    usage.input_tokens * PRICE.input +
    (usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
    usage.output_tokens * PRICE.output;
  spent += cost;
  const n = (x) => x.toLocaleString("en-US");
  console.log(`  ${label}: ${n(usage.input_tokens)} tokens in, ${n(usage.output_tokens)} out, about $${cost.toFixed(2)}`);
}

/**
 * One streamed Claude turn; returns the text Claude wrote. Server-side fallback is
 * on, so a safety decline is retried on Anthropic's recommended fallback model.
 */
export async function ask({ label, system, user, format, effort = "medium", maxTokens = 32000 }) {
  client ??= new Anthropic({ apiKey: loadEnv().ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, ...(format && { format }) },
  });
  const message = await stream.finalMessage();
  logUsage(label, message.usage);
  if (message.stop_reason === "refusal") {
    const { category, explanation } = message.stop_details ?? {};
    throw new Error(`${label}: Claude declined (${category ?? "no category"}). ${explanation ?? ""}`);
  }
  if (message.stop_reason === "max_tokens") throw new Error(`${label}: ran out of output tokens before finishing.`);
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
