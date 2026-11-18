import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

// Reads .env (if there is one) without touching process.env. Real environment
// variables win, so a one-off `DISCORD_WEBHOOK_URL= npm run clip` switches it off.
let cached;
export function loadEnv() {
  if (cached) return cached;
  const file = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};
  cached = {};
  for (const [key, value] of Object.entries({ ...file, ...process.env })) cached[key] = String(value).trim();
  return cached;
}
