// After posting a clip: pings Discord with the Content Rewards submit link and a
// live countdown to the 30-minute deadline, pings again at 20 minutes, and logs the
// post for the metrics loop (media/posts.jsonl).
//
//   npm run posted -- <post link> --campaign tomo [--clip media/<job>/clips/01-x.mp4] [--window 30] [--no-remind]
import { appendFileSync, mkdirSync } from "node:fs";
import { loadCampaign } from "./config.mjs";
import { discordConfigured, sendWebhook } from "./discord.mjs";
import { MEDIA, parseArgs } from "./util.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2), ["remind"]);
const link = positional[0];

const platformOf = (url) =>
  /tiktok\.com/.test(url) ? "tiktok" : /youtube\.com|youtu\.be/.test(url) ? "youtube" : /instagram\.com/.test(url) ? "instagram" : /x\.com|twitter\.com/.test(url) ? "x" : "other";

async function main() {
  if (!link || !/^https?:\/\//.test(link)) throw new Error("Usage: npm run posted -- <post link> --campaign <name>");
  if (!flags.campaign) throw new Error("Which campaign? Add --campaign <name> (a file in campaigns/).");
  const campaign = loadCampaign(flags.campaign);
  const minutes = Number(flags.window ?? 30);
  const postedAt = new Date();
  const deadline = Math.floor(postedAt.getTime() / 1000) + minutes * 60;

  mkdirSync(MEDIA, { recursive: true });
  appendFileSync(
    `${MEDIA}posts.jsonl`,
    `${JSON.stringify({ postedAt: postedAt.toISOString(), link, platform: platformOf(link), campaign: campaign.id, clip: flags.clip ?? null, submitBy: new Date(deadline * 1000).toISOString() })}\n`,
  );
  console.log(`Logged to media/posts.jsonl. Submit by ${new Date(deadline * 1000).toLocaleTimeString()}.`);

  if (!discordConfigured("posted")) {
    console.log("No Discord webhook set, so no reminder was sent.");
    return;
  }
  await sendWebhook(
    { content: `**Submit this ${platformOf(link)} post to ${campaign.name}** before <t:${deadline}:t> (<t:${deadline}:R>)\nPost: <${link}>\nSubmit: ${campaign.submitUrl ? `<${campaign.submitUrl}>` : "(add submitUrl to the campaign file)"}` },
    { which: "posted" },
  );
  console.log("Reminder sent to Discord.");
  if (flags.remind === false || minutes <= 10) return;
  const wait = (minutes - 10) * 60 * 1000;
  console.log(`Keeping this open to ping again at ${minutes - 10} minutes (Ctrl+C to skip).`);
  await new Promise((r) => setTimeout(r, wait));
  await sendWebhook({ content: `⏰ **10 minutes left** to submit <${link}> to ${campaign.name} (<t:${deadline}:R>)` }, { which: "posted" });
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
