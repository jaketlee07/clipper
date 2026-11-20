// The Discord bot: when a campaign's streamer goes live it pings you with Clip it
// and Skip buttons. Tap Clip it (on your phone, anywhere) and it follows that
// broadcast with the same loop as `npm run follow`: clips land in #clips-ready
// as usual, and the message shows progress with a Stop button. When the
// broadcast ends it clips the last stretch and says how many clips it made.
//
//   caffeinate -i npm run bot
//
//   --chunk 30   minutes of footage per run (default 30)
//   --count 3    clips per chunk at most (default 3)
//   --every 2    minutes between checks for who's live (default 2)
//
// /clipper status | start | stop in Discord does the same from anywhere in the
// server. Only you (the bot's owner) can use the buttons and the command.
// Needs DISCORD_BOT_TOKEN in .env; see "The Discord bot" in the README.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadCampaign, loadStreamer } from "./config.mjs";
import { loadEnv } from "./env.mjs";
import { follow } from "./follow.mjs";
import { liveStreams, twitchConfigured } from "./signals/twitch.mjs";
import { MEDIA, clock, parseArgs } from "./util.mjs";

const STATE = `${MEDIA}bot.json`;
// A new broadcast this soon after a followed one ended (a crash or a restart)
// is followed without asking.
const RECONNECT = 30 * 60 * 1000;
// Permissions the bot needs: View Channel, Send Messages, Read Message History.
const PERMISSIONS = 1024 + 2048 + 65536;

const stamp = (text) => console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
const when = (iso, style = "t") => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// What a campaign's message for a broadcast says, and its buttons, by status:
// asked → following ⇄ stopped, asked ⇄ skipped, then done or ended.
export function view(rec, campaign, entry, { owner, live }) {
  const name = rec.name;
  const key = `${rec.id}|${campaign.id}`;
  const tally = `${plural(entry.chunks ?? 0, "chunk")} done, ${plural(entry.clips ?? 0, "clip")}`;
  const about = `${cut(rec.title ?? "", 140)}${rec.game ? ` (${rec.game})` : ""}`;
  switch (entry.status) {
    case "asked":
      return {
        content: `🔴 **${name} is live**: ${about}\nClip it for **${campaign.name}**?${owner ? ` <@${owner}>` : ""}`,
        buttons: [[`start|${key}`, "Clip it", "success"], [`skip|${key}`, "Skip", "secondary"]],
      };
    case "skipped":
      return { content: `⏭️ Skipped ${name}'s broadcast for ${campaign.name}: ${about}`, buttons: live ? [[`start|${key}`, "Clip it after all", "secondary"]] : [] };
    case "following": {
      const lines = [`▶️ **Following ${name}** for ${campaign.name} since ${when(entry.since)}${entry.auto ? " (picked up again: the last broadcast was being followed)" : ""}.`];
      if (entry.paused) lines.push("⏸️ The bot is offline. It picks up where it left off when it starts again.");
      lines.push(`${tally} so far, in #clips-ready.${entry.now ? ` Now clipping ${entry.now} of the VOD.` : live ? " The next chunk starts once there's enough new footage." : " The broadcast has ended; clipping the last stretch."}`);
      if (entry.note) lines.push(`⚠️ ${entry.note}`);
      return { content: lines.join("\n"), buttons: [[`stop|${key}`, "Stop", "danger"]] };
    }
    case "stopped":
      return { content: `⏹️ Stopped following ${name} for ${campaign.name} at ${when(entry.stoppedAt)}. ${tally}.${live ? "" : " The broadcast has ended."}`, buttons: live ? [[`start|${key}`, "Resume", "primary"]] : [] };
    case "done":
      return { content: `✅ **${name}'s broadcast is over** and clipped for ${campaign.name}: ${tally}.`, buttons: [] };
    case "error":
      return { content: `⚠️ Following ${name} for ${campaign.name} stopped: ${cut(entry.error ?? "unknown error", 300)}\n${tally}.`, buttons: live ? [[`start|${key}`, "Try again", "primary"]] : [] };
    default:
      return { content: `⚫ ${name}'s broadcast ended. Not clipped for ${campaign.name}.`, buttons: [] };
  }
}

const STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
const payload = ({ content, buttons }) => ({
  content,
  components: buttons.length ? [new ActionRowBuilder().addComponents(buttons.map(([id, label, style]) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(STYLES[style])))] : [],
});

// Campaigns whose streamer has a Twitch login: the ones the bot watches.
function watchedCampaigns() {
  const dir = fileURLToPath(new URL("../campaigns/", import.meta.url));
  const list = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "example.json")) {
    const id = file.slice(0, -5);
    try {
      const campaign = loadCampaign(id);
      const streamer = loadStreamer(campaign.streamer);
      if (streamer.twitch) list.push({ campaign, streamer, login: streamer.twitch.toLowerCase() });
    } catch (err) {
      stamp(`campaigns/${file}: ${err.message}`);
    }
  }
  return list;
}

// The channel a Discord webhook posts to, so the bot can talk in the same one.
async function webhookChannel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read DISCORD_WEBHOOK_URL (HTTP ${res.status}).`);
  return (await res.json()).channel_id;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Set DISCORD_BOT_TOKEN in .env first. The README's \"The Discord bot\" section has the steps.");
  if (!twitchConfigured()) throw new Error("The bot needs the Twitch API to see who's live: set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env.");
  if (!env.DISCORD_WEBHOOK_URL) stamp("No DISCORD_WEBHOOK_URL set, so finished clips won't be posted to Discord.");
  const settings = { chunk: Number(flags.chunk ?? 30) * 60, count: Number(flags.count ?? 3) };
  const every = Number(flags.every ?? 2) * 60 * 1000;

  mkdirSync(MEDIA, { recursive: true });
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { streams: {} };
  const save = () => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  const running = new Map(); // "streamId|campaignId" -> { controller, promise }
  let shuttingDown = false;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.Error, (err) => stamp(`Discord: ${err.message}`));
  await client.login(env.DISCORD_BOT_TOKEN);
  await new Promise((resolve) => (client.isReady() ? resolve() : client.once(Events.ClientReady, resolve)));
  const invite = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`;

  const app = await client.application.fetch();
  const owners = new Set(env.DISCORD_OWNER_ID ? env.DISCORD_OWNER_ID.split(",").map((s) => s.trim()) : app.owner?.members ? [...app.owner.members.keys()] : [app.owner?.id]);
  const owner = [...owners][0];
  if (!owner) throw new Error("Couldn't tell who owns the bot. Set DISCORD_OWNER_ID in .env to your Discord user ID.");

  const channelId = env.DISCORD_BOT_CHANNEL_ID || (env.DISCORD_WEBHOOK_URL ? await webhookChannel(env.DISCORD_WEBHOOK_URL) : null);
  if (!channelId) throw new Error("Which channel should the bot post in? Set DISCORD_BOT_CHANNEL_ID (or DISCORD_WEBHOOK_URL, and it uses that webhook's channel).");
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error(`The bot can't see channel ${channelId}. Invite it to your server with this link, then start it again:\n${invite}`);

  const isLive = (streamId) => Boolean(state.streams[streamId] && !state.streams[streamId].endedAt);
  const campaignOf = (id) => {
    try {
      return loadCampaign(id);
    } catch {
      return { id, name: id };
    }
  };

  async function show(streamId, campaignId, { ping = false } = {}) {
    const rec = state.streams[streamId];
    const entry = rec.campaigns[campaignId];
    const body = payload(view(rec, campaignOf(campaignId), entry, { owner, live: isLive(streamId) }));
    try {
      if (entry.message) {
        try {
          return await channel.messages.edit(entry.message, { ...body, allowedMentions: { parse: [] } });
        } catch (err) {
          if (err.code !== 10008) throw err; // deleted: post it again
          entry.message = null;
        }
      }
      const sent = await channel.send({ ...body, allowedMentions: { users: ping && owner ? [owner] : [] } });
      entry.message = sent.id;
      save();
    } catch (err) {
      stamp(`Discord: couldn't ${entry.message ? "edit" : "post"} the message for ${campaignId}: ${err.message}`);
    }
  }

  function startFollowing(streamId, campaignId) {
    const key = `${streamId}|${campaignId}`;
    if (running.has(key)) return;
    const rec = state.streams[streamId];
    const entry = rec.campaigns[campaignId];
    const campaign = loadCampaign(campaignId);
    const streamer = loadStreamer(campaign.streamer);
    Object.assign(entry, { status: "following", since: entry.since ?? new Date().toISOString(), paused: false, now: null, note: null, error: null });
    save();
    const controller = new AbortController();
    const onEvent = (e) => {
      if (e.type === "chunk") entry.now = `${clock(e.from)} to ${clock(e.to)}`;
      if (e.type === "clipped") {
        entry.now = null;
        entry.note = null;
        entry.chunks = (entry.chunks ?? 0) + 1;
        entry.clips = (entry.clips ?? 0) + e.clips.length;
      }
      if (e.type === "failed") {
        entry.now = null;
        entry.note = e.gaveUp ? `Skipped ${clock(e.from)} to ${clock(e.to)} after ${e.tries} failed tries.` : `The last chunk failed (try ${e.tries} of 3); trying again on the next check.`;
      }
      if (e.type === "chunk" || e.type === "clipped" || e.type === "failed") {
        save();
        show(streamId, campaignId);
      }
    };
    const promise = follow({ campaign, streamer, ...settings, stream: { id: streamId, startedAt: rec.startedAt }, signal: controller.signal, onEvent, log: (t) => stamp(`[${campaignId}] ${t}`) })
      .then(async (result) => {
        if (!result.over) return;
        entry.status = "done";
        await channel.send({ content: `✅ ${rec.name}'s broadcast is over and clipped for ${campaign.name}: ${plural(entry.clips ?? 0, "clip")} from ${plural(entry.chunks ?? 0, "chunk")}.`, allowedMentions: { parse: [] } }).catch(() => {});
      })
      .catch((err) => {
        if (shuttingDown) return;
        stamp(`[${campaignId}] ${err.message}`);
        Object.assign(entry, { status: "error", error: err.message });
      })
      .finally(async () => {
        running.delete(key);
        entry.now = null;
        if (shuttingDown) entry.paused = true;
        save();
        await show(streamId, campaignId);
      });
    running.set(key, { controller, promise });
  }

  function stopFollowing(streamId, campaignId) {
    const entry = state.streams[streamId]?.campaigns[campaignId];
    if (!entry) return;
    Object.assign(entry, { status: "stopped", stoppedAt: new Date().toISOString(), now: null });
    save();
    running.get(`${streamId}|${campaignId}`)?.controller.abort();
  }

  // Asks about a broadcast for a campaign, or follows it straight away if the
  // streamer's last broadcast was being followed and ended just before it.
  async function track(stream, { campaign, login }) {
    const rec = state.streams[stream.id];
    if (rec.campaigns[campaign.id]) return false;
    const reconnect = Object.values(state.streams).some((other) => {
      const prev = other.campaigns[campaign.id];
      return other.id !== stream.id && other.login === login && other.endedAt && ["following", "done"].includes(prev?.status) && new Date(stream.startedAt) - new Date(other.endedAt) < RECONNECT;
    });
    rec.campaigns[campaign.id] = { status: "asked", chunks: 0, clips: 0, auto: reconnect };
    save();
    stamp(`${rec.name} is live: ${rec.title}. ${reconnect ? `Following again for ${campaign.id}.` : `Asking whether to clip it for ${campaign.id}.`}`);
    if (reconnect) startFollowing(stream.id, campaign.id);
    await show(stream.id, campaign.id, { ping: !reconnect });
    return true;
  }

  async function poll() {
    const watched = watchedCampaigns();
    const logins = [...new Set(watched.map((w) => w.login))];
    if (!logins.length) return;
    let live;
    try {
      live = await liveStreams(logins);
    } catch (err) {
      return stamp(`Twitch: ${err.message}`);
    }
    // Broadcasts that ended: gone twice in a row (the API sometimes blinks), or
    // replaced by a new one.
    for (const rec of Object.values(state.streams)) {
      if (rec.endedAt) continue;
      const now = live.get(rec.login);
      if (now?.id === rec.id) {
        rec.missed = 0;
        continue;
      }
      if (!now && (rec.missed = (rec.missed ?? 0) + 1) < 2) continue;
      rec.endedAt = new Date().toISOString();
      stamp(`${rec.name}'s broadcast ended.`);
      for (const [campaignId, entry] of Object.entries(rec.campaigns)) {
        if (["asked", "skipped"].includes(entry.status)) entry.status = "ended";
        await show(rec.id, campaignId);
      }
    }
    for (const w of watched) {
      const stream = live.get(w.login);
      if (!stream) continue;
      const rec = (state.streams[stream.id] ??= { id: stream.id, login: w.login, startedAt: stream.startedAt, campaigns: {} });
      Object.assign(rec, { name: stream.name, title: stream.title, game: stream.game });
      await track(stream, w);
    }
    // Forget broadcasts older than a week that aren't being followed.
    for (const [id, rec] of Object.entries(state.streams)) {
      const busy = Object.keys(rec.campaigns).some((c) => running.has(`${id}|${c}`));
      if (rec.endedAt && !busy && Date.now() - new Date(rec.endedAt) > 7 * 24 * 3600 * 1000) delete state.streams[id];
    }
    save();
  }

  function status() {
    const watched = watchedCampaigns();
    const lines = [];
    for (const { campaign, login } of watched) {
      const recs = Object.values(state.streams).filter((r) => r.login === login && r.campaigns[campaign.id] && (!r.endedAt || running.has(`${r.id}|${campaign.id}`)));
      const liveRec = Object.values(state.streams).find((r) => r.login === login && !r.endedAt);
      if (!recs.length) {
        lines.push(`**${campaign.name}**: ${liveRec ? `${liveRec.name} is live, not clipping.` : `watching twitch.tv/${login}; not live.`}`);
        continue;
      }
      for (const r of recs) {
        const e = r.campaigns[campaign.id];
        const what = { asked: "waiting for you to tap Clip it or Skip", following: `following since ${when(e.since)}${e.now ? `, clipping ${e.now} now` : ""}`, skipped: "skipped", stopped: `stopped at ${when(e.stoppedAt)}`, error: `stopped by an error: ${cut(e.error ?? "", 200)}` }[e.status] ?? e.status;
        lines.push(`**${campaign.name}**: ${r.name} ${r.endedAt ? "(broadcast over)" : `live since ${when(r.startedAt)}`}, ${what}. ${plural(e.clips ?? 0, "clip")} from ${plural(e.chunks ?? 0, "chunk")}.`);
      }
    }
    return lines.join("\n") || "No campaigns to watch: add one in campaigns/ with a streamer that has a \"twitch\" login.";
  }

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (!i.isButton() && !i.isChatInputCommand()) return;
      if (!owners.has(i.user.id)) return await i.reply({ content: "Only the bot's owner can do that.", flags: MessageFlags.Ephemeral });
      if (i.isButton()) {
        const [action, streamId, campaignId] = i.customId.split("|");
        const rec = state.streams[streamId];
        const entry = rec?.campaigns[campaignId];
        if (!entry) return await i.reply({ content: "That broadcast isn't tracked any more.", flags: MessageFlags.Ephemeral });
        if (action === "start" && isLive(streamId)) startFollowing(streamId, campaignId);
        if (action === "skip" && entry.status === "asked") entry.status = "skipped";
        if (action === "stop") stopFollowing(streamId, campaignId);
        save();
        stamp(`You tapped ${action} for ${campaignId}.`);
        return await i.update(payload(view(rec, campaignOf(campaignId), entry, { owner, live: isLive(streamId) })));
      }
      if (i.commandName !== "clipper") return;
      const sub = i.options.getSubcommand();
      if (sub === "status") return await i.reply({ content: cut(status(), 1990), flags: MessageFlags.Ephemeral });
      const campaignId = i.options.getString("campaign", true);
      const w = watchedCampaigns().find((x) => x.campaign.id === campaignId);
      if (!w) return await i.reply({ content: `There's no campaign called ${campaignId}.`, flags: MessageFlags.Ephemeral });
      const rec = Object.values(state.streams).find((r) => r.login === w.login && !r.endedAt);
      if (sub === "stop") {
        const busy = Object.values(state.streams).filter((r) => running.has(`${r.id}|${campaignId}`));
        for (const r of busy) {
          stopFollowing(r.id, campaignId);
          show(r.id, campaignId);
        }
        return await i.reply({ content: busy.length ? `Stopped following for ${w.campaign.name}.` : `Nothing is being followed for ${w.campaign.name}.`, flags: MessageFlags.Ephemeral });
      }
      if (!rec) return await i.reply({ content: `twitch.tv/${w.login} isn't live. You'll get a ping with a Clip it button when they go live.`, flags: MessageFlags.Ephemeral });
      if (!rec.campaigns[campaignId]) rec.campaigns[campaignId] = { status: "asked", chunks: 0, clips: 0 };
      startFollowing(rec.id, campaignId);
      await show(rec.id, campaignId);
      return await i.reply({ content: `Following ${rec.name} for ${w.campaign.name}.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      stamp(`Discord: ${err.message}`);
    }
  });

  // /clipper, in this server only, so it shows up straight away.
  const choices = watchedCampaigns().slice(0, 25).map(({ campaign }) => ({ name: cut(campaign.name, 100), value: campaign.id }));
  const campaignOption = { type: ApplicationCommandOptionType.String, name: "campaign", description: "Which campaign", required: true, choices };
  await channel.guild.commands
    .set([
      {
        name: "clipper",
        description: "The clipping bot",
        options: [
          { type: ApplicationCommandOptionType.Subcommand, name: "status", description: "What's live and what's being clipped" },
          { type: ApplicationCommandOptionType.Subcommand, name: "start", description: "Start following the live broadcast now", options: [campaignOption] },
          { type: ApplicationCommandOptionType.Subcommand, name: "stop", description: "Stop following", options: [campaignOption] },
        ],
      },
    ])
    .catch((err) => stamp(`Couldn't add /clipper (${err.message}). Re-invite the bot with this link to allow it: ${invite}`));

  stamp(`Logged in as ${client.user.tag}, posting in #${channel.name}. Watching ${watchedCampaigns().map((w) => `twitch.tv/${w.login} (${w.campaign.id})`).join(", ") || "nothing yet"}.`);
  stamp(`Invite link, if it isn't in your server yet: ${invite}`);

  // Pick up broadcasts that were being followed when the bot last stopped.
  for (const rec of Object.values(state.streams)) {
    for (const [campaignId, entry] of Object.entries(rec.campaigns)) {
      if (entry.status !== "following") continue;
      startFollowing(rec.id, campaignId);
      show(rec.id, campaignId);
    }
  }

  const shutdown = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    stamp("Stopping. Following picks up where it left off when the bot starts again.");
    for (const r of running.values()) r.controller.abort();
    await Promise.race([Promise.allSettled([...running.values()].map((r) => r.promise)), new Promise((r) => setTimeout(r, 10000))]);
    await client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (;;) {
    await poll().catch((err) => stamp(`Check failed: ${err.message}`));
    await new Promise((r) => setTimeout(r, every));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
