#!/usr/bin/env bun
import { loadTopology, type Topology } from "./discovery.ts";
import { SERVICES, SonosError, fetchText, isDryRun, setDryRun, soap, type ServiceName } from "./soap.ts";
import { unlink } from "node:fs/promises";
import { serveFile, waitForFileEnd } from "./fileserver.ts";
import { groupSpeakers, loadSnapshot, restoreSnapshot, saveSnapshot, takeSnapshot, type Snapshot } from "./snapshot.ts";
import { speechToFile } from "./tts.ts";
import { PLAY_MODES, Speaker, formatTime, groupName, parseTime, trackMetadata, type PlayMode, type Repeat } from "./speaker.ts";
import { SonosWebSocket, type WsHeader } from "./ws.ts";
import { parseXml, type DidlObject } from "./xml.ts";

interface Context {
  topology: Topology;
  /** Resolves the target speaker (from -s, the leading room name, or the default). */
  speaker: () => Speaker;
  find: (query: string) => Speaker;
  json: boolean;
  flags: Set<string>;
  /** Flags with a value, for example --volume 30. */
  options: Map<string, string>;
}

interface Command {
  names: string[];
  usage: string;
  help: string;
  run: (ctx: Context, args: string[]) => Promise<void>;
}

// --- Output helpers --------------------------------------------------------

function out(ctx: Context, value: unknown, human?: () => string) {
  if (ctx.json) console.log(JSON.stringify(value, null, 2));
  else console.log(human ? human() : String(value));
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function describeTrack(t: Awaited<ReturnType<Speaker["currentTrack"]>>): string {
  const main = [t.artist, t.title].filter(Boolean).join(" - ") || "(no title)";
  const parts = [main];
  if (t.album) parts.push(`[${t.album}]`);
  if (t.station) parts.push(`on ${t.station}`);
  if (t.duration) parts.push(`${t.position} / ${t.duration}`);
  else if (t.position) parts.push(t.position);
  return parts.join("  ");
}

// --- Argument helpers ------------------------------------------------------

function bool(value: string): boolean {
  if (/^(on|true|yes|1)$/i.test(value)) return true;
  if (/^(off|false|no|0)$/i.test(value)) return false;
  throw new SonosError(`Expected on or off, got "${value}"`);
}

function int(value: string | undefined, name = "value"): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) throw new SonosError(`Expected an integer for ${name}, got "${value ?? ""}"`);
  return n;
}

/** Parses "30m", "1h30m", "90s", "1:30:00" or a plain number of minutes. */
function parseDuration(value: string): number {
  if (value.includes(":")) return parseTime(value);
  if (/^\d+$/.test(value)) return Number(value) * 60;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!match || !value) throw new SonosError(`Invalid duration: ${value}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** Runs a getter, or a setter if an argument is given. Arguments "+n"/"-n" change relative. */
async function level(
  ctx: Context,
  args: string[],
  get: () => Promise<number>,
  set: (n: number) => Promise<unknown>,
  change?: (delta: number) => Promise<number>,
) {
  const arg = args[0];
  if (arg === undefined) return out(ctx, await get());
  if (change && /^[+-]\d+$/.test(arg)) {
    const result = await change(Number(arg));
    return out(ctx, isDryRun() ? arg : result);
  }
  await set(int(arg));
  if (!isDryRun()) out(ctx, await get());
}

async function onOffSetting(ctx: Context, args: string[], get: () => Promise<boolean>, set: (v: boolean) => Promise<unknown>) {
  if (args[0] === undefined) {
    const value = await get();
    return out(ctx, value, () => (value ? "on" : "off"));
  }
  await set(bool(args[0]));
}

function pickFavorite(favorites: DidlObject[], query: string): DidlObject {
  if (/^\d+$/.test(query)) {
    const fav = favorites[Number(query) - 1];
    if (!fav) throw new SonosError(`Favorite number must be 1..${favorites.length}`);
    return fav;
  }
  const q = query.toLowerCase();
  const exact = favorites.filter((f) => f.title.toLowerCase() === q);
  const partial = favorites.filter((f) => f.title.toLowerCase().includes(q));
  const matches = exact.length > 0 ? exact : partial;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new SonosError(`Favorite "${query}" not found`);
  throw new SonosError(`Favorite "${query}" is ambiguous: ${matches.map((f) => f.title).join(", ")}`);
}

// --- Commands --------------------------------------------------------------

const commands: Command[] = [
  // Discovery and status
  {
    names: ["speakers", "discover", "ls"],
    usage: "speakers",
    help: "List all speakers (refreshes the discovery cache)",
    run: async (ctx) => {
      const rows = ctx.topology.groups.flatMap((g) =>
        g.members.map((m) => ({
          name: m.name,
          ip: m.ip,
          uuid: m.uuid,
          group: groupName(g),
          coordinator: m.uuid === g.coordinator.uuid,
        })),
      );
      rows.sort((a, b) => a.name.localeCompare(b.name));
      out(ctx, rows, () =>
        table([["NAME", "IP", "GROUP", "UUID"], ...rows.map((r) => [r.name + (r.coordinator ? " *" : ""), r.ip, r.group, r.uuid])]),
      );
    },
  },
  {
    names: ["status", "groups", "st"],
    usage: "status",
    help: "Show all groups with playback state, track and group volume",
    run: async (ctx) => {
      const groups = await Promise.all(
        ctx.topology.groups.map(async (g) => {
          const s = new Speaker(g.coordinator, g, ctx.topology);
          const [state, track, volume] = await Promise.all([s.transportState(), s.currentTrack(), s.groupVolume()]);
          return { group: groupName(g), coordinator: g.coordinator.name, state, volume, track };
        }),
      );
      out(ctx, groups, () =>
        groups.map((g) => `${g.group}\n  ${g.state.padEnd(15)} vol ${g.volume}\n  ${describeTrack(g.track)}`).join("\n"),
      );
    },
  },
  {
    names: ["info"],
    usage: "info",
    help: "Show device information of the speaker",
    run: async (ctx) => {
      const info = await ctx.speaker().info();
      out(ctx, info, () => table(Object.entries(info)));
    },
  },
  {
    names: ["track", "now"],
    usage: "track",
    help: "Show the current track",
    run: async (ctx) => {
      const track = await ctx.speaker().currentTrack();
      out(ctx, track, () => describeTrack(track));
    },
  },
  {
    names: ["state"],
    usage: "state",
    help: "Show the transport state (PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING)",
    run: async (ctx) => out(ctx, await ctx.speaker().transportState()),
  },

  // Transport
  { names: ["play"], usage: "play", help: "Start playback", run: async (ctx) => ctx.speaker().play() },
  { names: ["pause"], usage: "pause", help: "Pause playback", run: async (ctx) => ctx.speaker().pause() },
  { names: ["stop"], usage: "stop", help: "Stop playback", run: async (ctx) => ctx.speaker().stop() },
  {
    names: ["toggle", "playpause"],
    usage: "toggle",
    help: "Pause if playing, else play",
    run: async (ctx) => void (await ctx.speaker().toggle()),
  },
  { names: ["next"], usage: "next", help: "Skip to the next track", run: async (ctx) => ctx.speaker().next() },
  { names: ["prev", "previous"], usage: "prev", help: "Go to the previous track", run: async (ctx) => ctx.speaker().previous() },
  {
    names: ["seek"],
    usage: "seek <1:30|90|+30|-15|50%>",
    help: "Seek to a position in the track, forward/back in seconds, or to a percentage",
    run: async (ctx, [target]) => {
      if (!target) throw new SonosError("Usage: seek <time>");
      await ctx.speaker().seek(target);
    },
  },

  // Volume and EQ
  {
    names: ["volume", "vol", "v"],
    usage: "volume [0-100|+n|-n]",
    help: "Get or set the speaker volume",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.volume(), (n) => s.setVolume(n), (d) => s.changeVolume(d));
    },
  },
  {
    names: ["group-volume", "gv"],
    usage: "group-volume [0-100|+n|-n]",
    help: "Get or set the volume of the whole group",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.groupVolume(), (n) => s.setGroupVolume(n), (d) => s.changeGroupVolume(d));
    },
  },
  {
    names: ["ramp"],
    usage: "ramp <0-100>",
    help: "Change the volume slowly to a target value",
    run: async (ctx, [target]) => {
      const seconds = await ctx.speaker().rampVolume(int(target, "volume"));
      if (!isDryRun()) out(ctx, seconds, () => `Ramp takes ${seconds}s`);
    },
  },
  {
    names: ["mute"],
    usage: "mute [on|off]",
    help: "Get or set mute of the speaker",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.muted(), (v) => s.setMuted(v));
    },
  },
  {
    names: ["group-mute", "gm"],
    usage: "group-mute [on|off]",
    help: "Get or set mute of the whole group",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.groupMuted(), (v) => s.setGroupMuted(v));
    },
  },
  {
    names: ["bass"],
    usage: "bass [-10..10]",
    help: "Get or set bass",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.bass(), (n) => s.setBass(n));
    },
  },
  {
    names: ["treble"],
    usage: "treble [-10..10]",
    help: "Get or set treble",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.treble(), (n) => s.setTreble(n));
    },
  },
  {
    names: ["loudness"],
    usage: "loudness [on|off]",
    help: "Get or set loudness compensation",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.loudness(), (v) => s.setLoudness(v));
    },
  },
  {
    names: ["night"],
    usage: "night [on|off]",
    help: "Get or set night mode (soundbars only)",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, async () => (await s.eq("NightMode")) === "1", (v) => s.setEq("NightMode", v ? 1 : 0));
    },
  },
  {
    names: ["dialog"],
    usage: "dialog [on|off]",
    help: "Get or set speech enhancement (soundbars only)",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, async () => (await s.eq("DialogLevel")) === "1", (v) => s.setEq("DialogLevel", v ? 1 : 0));
    },
  },

  // Play mode and sleep timer
  {
    names: ["mode"],
    usage: `mode [${Object.keys(PLAY_MODES).join("|")}]`,
    help: "Get or set the play mode",
    run: async (ctx, [mode]) => {
      const s = ctx.speaker();
      if (!mode) return out(ctx, await s.playMode());
      const upper = mode.toUpperCase() as PlayMode;
      if (!(upper in PLAY_MODES)) throw new SonosError(`Play mode must be one of ${Object.keys(PLAY_MODES).join(", ")}`);
      await s.setPlayMode(upper);
    },
  },
  {
    names: ["shuffle"],
    usage: "shuffle [on|off]",
    help: "Get or set shuffle",
    run: async (ctx, [value]) => {
      const s = ctx.speaker();
      if (!value) {
        const on = PLAY_MODES[await s.playMode()][0];
        return out(ctx, on, () => (on ? "on" : "off"));
      }
      await s.setShuffleRepeat({ shuffle: bool(value) });
    },
  },
  {
    names: ["repeat"],
    usage: "repeat [off|all|one]",
    help: "Get or set repeat",
    run: async (ctx, [value]) => {
      const s = ctx.speaker();
      if (!value) return out(ctx, PLAY_MODES[await s.playMode()][1]);
      if (!["off", "all", "one"].includes(value)) throw new SonosError("Repeat must be off, all or one");
      await s.setShuffleRepeat({ repeat: value as Repeat });
    },
  },
  {
    names: ["crossfade"],
    usage: "crossfade [on|off]",
    help: "Get or set crossfade",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.crossfade(), (v) => s.setCrossfade(v));
    },
  },
  {
    names: ["sleep"],
    usage: "sleep [30m|1h30m|90s|1:30:00|<minutes>|off]",
    help: "Get, set or cancel the sleep timer",
    run: async (ctx, [value]) => {
      const s = ctx.speaker();
      if (!value) {
        const remaining = await s.sleepTimer();
        return out(ctx, remaining, () => (remaining === null ? "off" : `${formatTime(remaining)} remaining`));
      }
      await s.setSleepTimer(/^(off|cancel)$/i.test(value) ? null : parseDuration(value));
    },
  },

  // Queue
  {
    names: ["queue", "q"],
    usage: "queue [list|clear|play <n>|remove <n>|add <uri>]",
    help: "Show or change the queue",
    run: async (ctx, [sub = "list", arg]) => {
      const s = ctx.speaker();
      switch (sub) {
        case "list": {
          const [items, track] = await Promise.all([s.queue(), s.currentTrack()]);
          const current = track.source === "QUEUE" ? track.queuePosition : 0;
          return out(ctx, items, () =>
            items.length === 0
              ? "(queue is empty)"
              : items
                  .map((t, i) => `${i + 1 === current ? "*" : " "}${String(i + 1).padStart(4)}  ${[t.creator, t.title].filter(Boolean).join(" - ")}`)
                  .join("\n"),
          );
        }
        case "clear":
          return s.clearQueue();
        case "play":
          return s.playFromQueue(int(arg, "queue position"));
        case "remove":
          return s.removeFromQueue(int(arg, "queue position"));
        case "add": {
          if (!arg) throw new SonosError("Usage: queue add <uri>");
          const position = await s.addToQueue(arg);
          if (!isDryRun()) out(ctx, position, () => `Added at position ${position}`);
          return;
        }
        default:
          throw new SonosError(`Unknown queue command: ${sub}`);
      }
    },
  },

  // Favorites, playlists, URIs, inputs
  {
    names: ["favorites", "favs", "lf"],
    usage: "favorites",
    help: "List Sonos favorites",
    run: async (ctx) => {
      const favs = await ctx.speaker().favorites();
      out(ctx, favs, () =>
        table(favs.map((f, i) => [String(i + 1).padStart(3), f.title, f.description, f.uri ? "" : "(app shortcut, not playable)"])),
      );
    },
  },
  {
    names: ["fav", "play-fav", "pf"],
    usage: "fav <name|number>",
    help: "Play a Sonos favorite (name match is case-insensitive and partial)",
    run: async (ctx, args) => {
      const query = args.join(" ");
      if (!query) throw new SonosError("Usage: fav <name|number>");
      const s = ctx.speaker();
      const fav = pickFavorite(await s.favorites(), query);
      await s.playFavorite(fav);
      if (!isDryRun()) out(ctx, fav.title, () => `Playing ${fav.title}`);
    },
  },
  {
    names: ["playlists"],
    usage: "playlists",
    help: "List saved Sonos playlists",
    run: async (ctx) => {
      const lists = await ctx.speaker().playlists();
      out(ctx, lists, () => (lists.length ? lists.map((l, i) => `${String(i + 1).padStart(3)}  ${l.title}`).join("\n") : "(no playlists)"));
    },
  },
  {
    names: ["play-uri", "uri"],
    usage: "play-uri <uri> [title] [--radio]",
    help: "Play a URI (for example an HTTP stream). A title makes it a radio station",
    run: async (ctx, [uri, ...title]) => {
      if (!uri) throw new SonosError("Usage: play-uri <uri> [title]");
      await ctx.speaker().playUri(uri, { title: title.join(" ") || undefined, radio: ctx.flags.has("radio") });
    },
  },
  {
    names: ["play-file", "file"],
    usage: "play-file <path>",
    help: "Play a local audio file. Serves it over HTTP until playback ends (Ctrl-C stops)",
    run: async (ctx, args) => {
      const path = args.join(" ");
      if (!path) throw new SonosError("Usage: play-file <path>");
      const s = ctx.speaker();
      const server = await serveFile(path, s.coordinator.ip, ctx.topology.members.map((m) => m.ip));
      if (isDryRun()) {
        await s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) });
        server.stop();
        return;
      }
      process.on("SIGINT", async () => {
        // Stop only if our file still plays. Without the server, it cannot continue.
        if ((await s.mediaInfo().catch(() => ({ uri: "" }))).uri === server.url) await s.stop().catch(() => {});
        server.stop();
        process.exit(130);
      });
      await s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) });
      console.error(`Playing "${server.title}" on ${groupName(s.group)}. Press Ctrl-C to stop.`);
      // Keep the file available for 10 minutes after another source starts,
      // so that "interrupt" and "say" can return to it.
      const result = await waitForFileEnd(s, server.url, { replacedGraceMs: 10 * 60_000 });
      console.error(result === "ended" ? "Playback ended." : "Another source replaced the file.");
      server.stop();
    },
  },
  {
    names: ["interrupt", "insert"],
    usage: "interrupt <path> [--volume n]",
    help: "Play a local file, then return to the previous music at the same position",
    run: async (ctx, args) => {
      const path = args.join(" ");
      if (!path) throw new SonosError("Usage: interrupt <path>");
      await interruptWith(ctx, path);
    },
  },
  {
    names: ["say", "tts"],
    usage: 'say "<text>" [--voice Anna] [--volume n]',
    help: "Speak a text (macOS say), then return to the previous music at the same position",
    run: async (ctx, args) => {
      const text = args.join(" ");
      if (!text) throw new SonosError('Usage: say "<text>"');
      const path = await speechToFile(text, ctx.options.get("voice"));
      try {
        await interruptWith(ctx, path, "Announcement");
      } finally {
        await unlink(path).catch(() => {});
      }
    },
  },
  {
    names: ["snapshot", "snap"],
    usage: "snapshot [save|restore|show] [name]",
    help: "Save what the group plays (source, track, position, volumes), or restore it",
    run: async (ctx, [sub = "save", name = "default"]) => {
      const s = ctx.speaker();
      switch (sub) {
        case "save": {
          const snap = await takeSnapshot(s);
          await saveSnapshot(name, snap);
          return out(ctx, snap, () => `Saved "${name}": ${describeSnapshot(snap)}`);
        }
        case "show": {
          const snap = await loadSnapshot(name);
          return out(ctx, snap, () => describeSnapshot(snap));
        }
        case "restore": {
          const snap = await loadSnapshot(name);
          for (const w of await restoreSnapshot(s, snap)) console.error(`Warning: ${w}`);
          if (!isDryRun()) out(ctx, snap.title, () => `Restored: ${describeSnapshot(snap)}`);
          return;
        }
        default:
          throw new SonosError(`Unknown snapshot command: ${sub}`);
      }
    },
  },
  {
    names: ["line-in"],
    usage: "line-in [source room]",
    help: "Play the line-in input of this speaker or of another speaker",
    run: async (ctx, [source]) => {
      const s = ctx.speaker();
      await s.lineIn(source ? ctx.find(source) : s);
    },
  },
  { names: ["tv"], usage: "tv", help: "Switch a soundbar to the TV input", run: async (ctx) => ctx.speaker().tv() },

  // Groups
  {
    names: ["join", "group"],
    usage: "join <room>",
    help: "Add the speaker to the group of another room",
    run: async (ctx, args) => {
      if (!args[0]) throw new SonosError("Usage: join <room>");
      await ctx.speaker().join(ctx.find(args.join(" ")));
    },
  },
  {
    names: ["leave", "ungroup", "unjoin"],
    usage: "leave",
    help: "Remove the speaker from its group",
    run: async (ctx) => ctx.speaker().leave(),
  },
  {
    names: ["party"],
    usage: "party",
    help: "Add all other speakers to the group of this speaker",
    run: async (ctx) => {
      const target = ctx.speaker();
      for (const g of ctx.topology.groups) {
        for (const m of g.members) {
          if (g.id !== target.group.id) await new Speaker(m, g, ctx.topology).join(target);
        }
      }
    },
  },
  {
    names: ["ungroup-all"],
    usage: "ungroup-all",
    help: "Split all groups into single speakers",
    run: async (ctx) => {
      for (const g of ctx.topology.groups) {
        for (const m of g.members) {
          if (m.uuid !== g.coordinator.uuid) await new Speaker(m, g, ctx.topology).leave();
        }
      }
    },
  },

  // Device settings
  {
    names: ["light"],
    usage: "light [on|off]",
    help: "Get or set the status light",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.statusLight(), (v) => s.setStatusLight(v));
    },
  },
  {
    names: ["buttons"],
    usage: "buttons [on|off]",
    help: "Get or set if the buttons on the speaker work",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.buttonsEnabled(), (v) => s.setButtonsEnabled(v));
    },
  },
  {
    names: ["alarms"],
    usage: "alarms",
    help: "List alarms",
    run: async (ctx) => {
      const alarms = await ctx.speaker().alarms();
      out(ctx, alarms, () =>
        alarms.length === 0
          ? "(no alarms)"
          : table([
              ["ID", "TIME", "DURATION", "RECURRENCE", "ON", "ROOM", "VOL"],
              ...alarms.map((a) => [a.id, a.startTime, a.duration, a.recurrence, a.enabled ? "yes" : "no", a.room, String(a.volume)]),
            ]),
      );
    },
  },

  // Exploration
  {
    names: ["actions", "describe"],
    usage: "actions [Service]",
    help: "List the UPnP services, or the actions of one service (from its SCPD)",
    run: async (ctx, [service]) => {
      const s = ctx.speaker();
      if (!service) {
        return out(ctx, SERVICES, () =>
          table(Object.entries(SERVICES).map(([name, def]) => [name, `${def.path}/Control`, def.type])),
        );
      }
      const name = resolveService(service);
      const scpd = parseXml(await fetchText(s.ip, `/xml/${name}1.xml`)).scpd;
      const actions = (scpd?.actionList?.action ?? []).map((a: any) => {
        const argsList: any[] = a.argumentList?.argument ?? [];
        return {
          name: a.name as string,
          in: argsList.filter((x) => x.direction === "in").map((x) => x.name as string),
          out: argsList.filter((x) => x.direction === "out").map((x) => x.name as string),
        };
      });
      out(ctx, actions, () =>
        actions.map((a: any) => `${a.name}(${a.in.join(", ")})${a.out.length ? " -> " + a.out.join(", ") : ""}`).join("\n"),
      );
    },
  },
  {
    names: ["raw", "call"],
    usage: "raw <Service> <Action> [Arg=Value ...]",
    help: "Send any UPnP action to the speaker (see 'actions')",
    run: async (ctx, [service, action, ...rest]) => {
      if (!service || !action) throw new SonosError("Usage: raw <Service> <Action> [Arg=Value ...]");
      const args = Object.fromEntries(
        rest.map((kv) => {
          const i = kv.indexOf("=");
          if (i < 0) throw new SonosError(`Expected Arg=Value, got "${kv}"`);
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const result = await soap(ctx.speaker().ip, resolveService(service), action, args);
      out(ctx, result, () => Object.entries(result).map(([k, v]) => `${k}: ${v}`).join("\n") || "OK");
    },
  },
  {
    names: ["ws"],
    usage: "ws <namespace> <command> [json-body] [--player|--household]",
    help: "Send a command to the local Sonos Control API (WebSocket, port 1443)",
    run: async (ctx, [namespace, command, body]) => {
      if (!namespace || !command) throw new SonosError("Usage: ws <namespace> <command> [json-body]");
      const s = ctx.speaker();
      const ns = namespace.includes(":") ? namespace : `${namespace}:1`;
      // Player commands go to the player itself; group commands to the coordinator.
      const ip = ctx.flags.has("player") ? s.ip : s.coordinator.ip;
      if (isDryRun() && !/^(get|subscribe|unsubscribe)/.test(command)) {
        console.error(`[dry-run] ${ip} ${ns}.${command} ${body ?? "{}"}`);
        return;
      }
      const ws = await SonosWebSocket.connect(ip);
      try {
        const header: WsHeader = { namespace: ns, command };
        if (ctx.flags.has("player")) header.playerId = s.uuid;
        else if (ctx.flags.has("household")) header.householdId = await ws.householdId();
        else header.groupId = s.group.id;
        const [, response] = await ws.request(header, body ? JSON.parse(body) : {});
        console.log(JSON.stringify(response, null, 2));
      } finally {
        ws.close();
      }
    },
  },
  {
    names: ["watch"],
    usage: "watch",
    help: "Print playback, track and volume changes of the group (Ctrl-C to stop)",
    run: async (ctx) => {
      const s = ctx.speaker();
      const ws = await SonosWebSocket.connect(s.coordinator.ip);
      const stamp = () => new Date().toLocaleTimeString();
      ws.onEvent(([header, body]) => {
        if (ctx.json) return console.log(JSON.stringify({ event: header.type, ...body }));
        switch (header.type) {
          case "metadataStatus": {
            const track = body.currentItem?.track;
            const artist = track?.artist?.name ?? "";
            const title = track?.name ?? body.streamInfo ?? "";
            console.log(`${stamp()}  track   ${[artist, title].filter(Boolean).join(" - ")}${body.container?.name ? `  (${body.container.name})` : ""}`);
            break;
          }
          case "playbackStatus":
            console.log(`${stamp()}  state   ${String(body.playbackState).replace("PLAYBACK_STATE_", "")}`);
            break;
          case "groupVolume":
            console.log(`${stamp()}  volume  ${body.volume}${body.muted ? " (muted)" : ""}`);
            break;
          case "groupCoordinatorChanged":
            console.log(`${stamp()}  group changed (${body.groupStatus}). Restart watch.`);
            ws.close();
            process.exit(0);
          default:
            console.log(`${stamp()}  ${header.type}`);
        }
      });
      console.log(`Watching ${groupName(s.group)} ...`);
      for (const namespace of ["playbackMetadata:1", "playback:1", "groupVolume:1"]) {
        await ws.request({ namespace, command: "subscribe", groupId: s.group.id });
      }
      await new Promise(() => {});
    },
  },
];

function describeSnapshot(snap: Snapshot): string {
  const at = snap.position ? ` at ${snap.position}` : "";
  const volumes = snap.members.map((m) => `${m.name} ${m.volume}${m.muted ? " (muted)" : ""}`).join(", ");
  return `${snap.title || snap.mediaUri}${at}, ${snap.state}, ${volumes}`;
}

/**
 * Plays a local file on the group, waits for its end, and restores the music
 * that played before (source, track, position, volumes). The snapshot is also
 * saved as "last-interrupt", so "snapshot restore last-interrupt" can repair
 * a broken run.
 */
async function interruptWith(ctx: Context, path: string, title?: string) {
  const s = ctx.speaker();
  const volume = ctx.options.has("volume") ? int(ctx.options.get("volume"), "--volume") : undefined;
  const snap = await takeSnapshot(s);
  if (!isDryRun()) await saveSnapshot("last-interrupt", snap);
  const server = await serveFile(path, s.coordinator.ip, ctx.topology.members.map((m) => m.ip), title);

  let done = false;
  const restore = async () => {
    if (done) return;
    done = true;
    for (const w of await restoreSnapshot(s, snap)) console.error(`Warning: ${w}`);
  };
  process.on("SIGINT", async () => {
    await restore().catch((e) => console.error(`Error: ${e.message}`));
    server.stop();
    process.exit(130);
  });

  try {
    if (volume !== undefined) for (const m of groupSpeakers(s)) await m.setVolume(volume);
    await s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) });
    if (!isDryRun()) {
      console.error(`Playing "${server.title}" on ${groupName(s.group)} ...`);
      if ((await waitForFileEnd(s, server.url, { pollMs: 500 })) === "replaced") {
        // Somebody started other music. Do not overwrite it.
        done = true;
        console.error("Another source started. The previous music is not restored.");
      }
    }
  } finally {
    await restore();
    server.stop();
  }
  if (!isDryRun() && snap.mediaUri) console.error(`Back to: ${describeSnapshot(snap)}`);
}

function resolveService(name: string): ServiceName {
  const match = Object.keys(SERVICES).find((s) => s.toLowerCase() === name.toLowerCase());
  if (!match) throw new SonosError(`Unknown service "${name}". Known: ${Object.keys(SERVICES).join(", ")}`);
  return match as ServiceName;
}

const commandByName = new Map(commands.flatMap((c) => c.names.map((n) => [n, c] as const)));

// --- Speaker lookup --------------------------------------------------------

function makeFinder(topology: Topology) {
  const visible = topology.groups.flatMap((g) => g.members.map((m) => ({ m, g })));
  return (query: string): Speaker => {
    const q = query.toLowerCase();
    const matches =
      [
        visible.filter(({ m }) => m.ip === query || m.uuid === query),
        visible.filter(({ m }) => m.name.toLowerCase() === q),
        visible.filter(({ m }) => m.name.toLowerCase().startsWith(q)),
        visible.filter(({ m }) => m.name.toLowerCase().includes(q)),
      ].find((list) => list.length > 0) ?? [];
    if (matches.length === 0) {
      throw new SonosError(`Speaker "${query}" not found. Known: ${visible.map(({ m }) => m.name).join(", ")}`);
    }
    if (matches.length > 1) throw new SonosError(`Speaker "${query}" is ambiguous: ${matches.map(({ m }) => m.name).join(", ")}`);
    return new Speaker(matches[0]!.m, matches[0]!.g, topology);
  };
}

function defaultSpeaker(topology: Topology, find: (q: string) => Speaker): Speaker {
  if (process.env.SONOS_SPEAKER) return find(process.env.SONOS_SPEAKER);
  if (topology.groups.length === 1) {
    const g = topology.groups[0]!;
    return new Speaker(g.coordinator, g, topology);
  }
  throw new SonosError(
    `Several groups found. Name a room (sonos <room> <command> or -s <room>) or set SONOS_SPEAKER. Rooms: ${topology.groups
      .flatMap((g) => g.members.map((m) => m.name))
      .join(", ")}`,
  );
}

// --- Main ------------------------------------------------------------------

class UsageError extends SonosError {}

// Most commands take a fixed number of arguments. Extra arguments are an
// error, so that a misplaced word (for example after "--") never changes a
// value by accident. Commands that are not listed join their arguments.
const MAX_ARGS: Record<string, number> = {
  ...Object.fromEntries(
    ["speakers", "status", "info", "track", "state", "play", "pause", "stop", "toggle", "next", "prev", "favorites",
     "playlists", "tv", "leave", "party", "ungroup-all", "alarms", "watch"].map((n) => [n, 0]),
  ),
  ...Object.fromEntries(
    ["seek", "volume", "group-volume", "ramp", "mute", "group-mute", "bass", "treble", "loudness", "night", "dialog",
     "mode", "shuffle", "repeat", "crossfade", "sleep", "light", "buttons", "line-in", "actions"].map((n) => [n, 1]),
  ),
  queue: 2,
  snapshot: 2,
  ws: 3,
};

const BOOLEAN_FLAGS = new Set(["help", "json", "dry-run", "refresh", "radio", "player", "household"]);
const VALUE_OPTIONS = new Set(["speaker", "volume", "voice"]);

function usage(): string {
  const lines = commands.map((c) => `  ${c.usage.padEnd(48)} ${c.help}`);
  return `sonos-cli - control Sonos speakers in the local network

Usage: sonos [room] <command> [args] [options]

Commands:
${lines.join("\n")}

Options:
  -s, --speaker <room>   Target speaker (name, part of a name, IP or UUID)
  --json                 Print JSON output
  --dry-run              Print state-changing requests, do not send them
  --refresh              Ignore the discovery cache
  --radio                play-uri: force radio mode (x-rincon-mp3radio)
  --volume <n>           interrupt, say: volume of all group members during the insert
  --voice <name>         say: macOS voice (list: say -v '?'), for example Anna
  --player, --household  ws: target the player or the household (default: group)
  -h, --help             Show this help

Environment:
  SONOS_SPEAKER          Default room
  SONOS_HOST             IP of one speaker (skips discovery)

Without a room, commands use SONOS_SPEAKER or the coordinator of the only group.
Transport and queue commands always go to the group coordinator.`;
}

async function main(argv: string[]) {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const long = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    const name = long ? long[1]! : arg === "-s" ? "speaker" : arg === "-h" ? "help" : undefined;
    if (name === undefined) {
      // Negative numbers ("volume -3") are arguments, other "-x" are unknown flags.
      if (/^-[a-zA-Z]/.test(arg)) throw new UsageError(`Unknown option "${arg}"`);
      positional.push(arg);
    } else if (VALUE_OPTIONS.has(name)) {
      const value = long?.[2] ?? argv[++i];
      if (value === undefined || value === "") throw new UsageError(`Option --${name} needs a value`);
      options.set(name, value);
    } else if (BOOLEAN_FLAGS.has(name) && long?.[2] === undefined) {
      flags.add(name);
    } else {
      throw new UsageError(`Unknown option "${arg}". Run "sonos --help".`);
    }
  }
  let speakerQuery = options.get("speaker");
  if (flags.has("help") || positional.length === 0) {
    console.log(usage());
    return;
  }
  setDryRun(flags.has("dry-run"));

  // "sonos Kantine volume 20": the first word is a room if it is not a command.
  let [name, ...args] = positional;
  if (!commandByName.has(name!) && positional.length > 1 && commandByName.has(positional[1]!)) {
    speakerQuery = name;
    [name, ...args] = positional.slice(1);
  }
  const command = commandByName.get(name!);
  if (!command) throw new UsageError(`Unknown command "${name}". Run "sonos --help".`);
  const maxArgs = MAX_ARGS[command.names[0]!];
  if (maxArgs !== undefined && args.length > maxArgs) {
    throw new UsageError(`Too many arguments for "${name}": ${args.slice(maxArgs).join(" ")}. Usage: sonos ${command.usage}`);
  }

  const refresh = flags.has("refresh") || command.names[0] === "speakers";
  const topology = await loadTopology(refresh);
  const find = makeFinder(topology);
  let cached: Speaker | undefined;
  const ctx: Context = {
    topology,
    find,
    json: flags.has("json"),
    flags,
    options,
    speaker: () => (cached ??= speakerQuery ? find(speakerQuery) : defaultSpeaker(topology, find)),
  };
  await command.run(ctx, args);
}

main(Bun.argv.slice(2)).catch((err) => {
  console.error(err instanceof SonosError ? `Error: ${err.message}` : err);
  // Exit code 2 for usage errors, as most CLIs do.
  process.exit(err instanceof UsageError ? 2 : 1);
});
