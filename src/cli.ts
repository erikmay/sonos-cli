#!/usr/bin/env bun
import { loadTopology, type Topology } from "./discovery.ts";
import { SERVICES, SonosError, fetchText, isDryRun, setDryRun, soap, type ServiceName } from "./soap.ts";
import { loadSnapshot, restoreSnapshot, saveSnapshot, takeSnapshot, describeSnapshot, reportRestore } from "./snapshot.ts";
import { parseArguments, resolveAction, UsageError, type Command } from "./arguments.ts";
import { playFile, interruptWith } from "./playback.ts";
import { watch } from "./watch.ts";
import { FADE_DEFAULTS, MAX_FADE_SECONDS, fade, type FadeOptions } from "./fade.ts";
import { isRecord } from "./validation.ts";
import { speechToFile } from "./tts.ts";
import { PLAY_MODES, Speaker, assertPlayable, formatTime, groupName, parseTime, type PlayMode, type Repeat } from "./speaker.ts";
import { SonosWebSocket, type WsHeader } from "./ws.ts";
import { parseXml, type DidlObject } from "./xml.ts";

interface Context {
  topology: Topology;
  speaker: () => Speaker;
  find: (query: string) => Speaker;
  json: boolean;
  flags: Set<string>;
  options: Map<string, string>;
}

function out(ctx: Context, value: unknown, human?: () => string) {
  if (ctx.json) console.log(JSON.stringify(value, null, 2));
  else console.log(human ? human() : String(value));
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => Bun.stringWidth(r[i] ?? "")))) ?? [];
  return rows.map((r) => r.map((c, i) => c + " ".repeat(widths[i]! - Bun.stringWidth(c))).join("  ").trimEnd()).join("\n");
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

function bool(value: string): boolean {
  if (/^(on|true|yes|1)$/i.test(value)) return true;
  if (/^(off|false|no|0)$/i.test(value)) return false;
  throw new SonosError(`Expected on or off, got "${value}"`);
}

function int(value: string | undefined, name = "value"): number {
  const n = Number(value);
  if (value === undefined || !value.trim() || !Number.isSafeInteger(n)) throw new SonosError(`Expected an integer for ${name}, got "${value ?? ""}"`);
  return n;
}

/** A plain number means minutes. */
function parseDuration(value: string): number {
  if (value.includes(":")) return parseTime(value);
  if (/^\d+$/.test(value)) return Number(value) * 60;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!match || !value) throw new SonosError(`Invalid duration: ${value}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

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

const commands: Command<Context>[] = [
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
    args: [1, 1],
    usage: "seek <1:30|90|+30|-15|50%>",
    help: "Seek to a position in the track, forward/back in seconds, or to a percentage",
    run: async (ctx, [target]) => {
      await ctx.speaker().seek(target!);
    },
  },

  {
    names: ["volume", "vol", "v"],
    args: [0, 1],
    usage: "volume [0-100|+n|-n]",
    help: "Get or set the speaker volume",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.volume(), (n) => s.setVolume(n), (d) => s.changeVolume(d));
    },
  },
  {
    names: ["group-volume", "gv"],
    args: [0, 1],
    usage: "group-volume [0-100|+n|-n]",
    help: "Get or set the volume of the whole group",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.groupVolume(), (n) => s.setGroupVolume(n), (d) => s.changeGroupVolume(d));
    },
  },
  {
    names: ["ramp"],
    args: [1, 1],
    usage: "ramp <0-100>",
    help: "Change the volume slowly to a target value",
    run: async (ctx, [target]) => {
      const seconds = await ctx.speaker().rampVolume(int(target, "volume"));
      if (!isDryRun()) out(ctx, seconds, () => `Ramp takes ${seconds}s`);
    },
  },
  {
    names: ["mute"],
    args: [0, 1],
    usage: "mute [on|off]",
    help: "Get or set mute of the speaker",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.muted(), (v) => s.setMuted(v));
    },
  },
  {
    names: ["group-mute", "gm"],
    args: [0, 1],
    usage: "group-mute [on|off]",
    help: "Get or set mute of the whole group",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.groupMuted(), (v) => s.setGroupMuted(v));
    },
  },
  {
    names: ["bass"],
    args: [0, 1],
    usage: "bass [-10..10]",
    help: "Get or set bass",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.bass(), (n) => s.setBass(n));
    },
  },
  {
    names: ["treble"],
    args: [0, 1],
    usage: "treble [-10..10]",
    help: "Get or set treble",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await level(ctx, args, () => s.treble(), (n) => s.setTreble(n));
    },
  },
  {
    names: ["loudness"],
    args: [0, 1],
    usage: "loudness [on|off]",
    help: "Get or set loudness compensation",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.loudness(), (v) => s.setLoudness(v));
    },
  },
  {
    names: ["night"],
    args: [0, 1],
    usage: "night [on|off]",
    help: "Get or set night mode (soundbars only)",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, async () => (await s.eq("NightMode")) === "1", (v) => s.setEq("NightMode", v ? 1 : 0));
    },
  },
  {
    names: ["dialog"],
    args: [0, 1],
    usage: "dialog [on|off]",
    help: "Get or set speech enhancement (soundbars only)",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, async () => (await s.eq("DialogLevel")) === "1", (v) => s.setEq("DialogLevel", v ? 1 : 0));
    },
  },

  {
    names: ["mode"],
    args: [0, 1],
    usage: `mode [${Object.keys(PLAY_MODES).join("|")}]`,
    help: "Get or set the play mode",
    run: async (ctx, [mode]) => {
      const s = ctx.speaker();
      if (!mode) return out(ctx, await s.playMode());
      const upper = mode.toUpperCase() as PlayMode;
      if (!Object.hasOwn(PLAY_MODES, upper)) throw new SonosError(`Play mode must be one of ${Object.keys(PLAY_MODES).join(", ")}`);
      await s.setPlayMode(upper);
    },
  },
  {
    names: ["shuffle"],
    args: [0, 1],
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
    args: [0, 1],
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
    args: [0, 1],
    usage: "crossfade [on|off]",
    help: "Get or set crossfade",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.crossfade(), (v) => s.setCrossfade(v));
    },
  },
  {
    names: ["sleep"],
    args: [0, 1],
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

  {
    names: ["queue", "q"],
    usage: "queue [list|clear|play <n>|remove <n>|add <uri>]",
    help: "Show or change the queue",
    subcommands: {
      list: {
        run: async (ctx) => {
          const s = ctx.speaker();
          const [items, track] = await Promise.all([s.queue(), s.currentTrack()]);
          const current = track.source === "QUEUE" ? track.queuePosition : 0;
          out(ctx, items, () =>
            items.length === 0
              ? "(queue is empty)"
              : items
                  .map((t, i) => `${i + 1 === current ? "*" : " "}${String(i + 1).padStart(4)}  ${[t.creator, t.title].filter(Boolean).join(" - ")}`)
                  .join("\n"),
          );
        },
      },
      clear: { run: async (ctx) => ctx.speaker().clearQueue() },
      play: { args: [1, 1], run: async (ctx, [n]) => ctx.speaker().playFromQueue(int(n, "queue position")) },
      remove: { args: [1, 1], run: async (ctx, [n]) => ctx.speaker().removeFromQueue(int(n, "queue position")) },
      add: {
        args: [1, 1],
        run: async (ctx, [uri]) => {
          const position = await ctx.speaker().addToQueue(uri!);
          if (!isDryRun()) out(ctx, position, () => `Added at position ${position}`);
        },
      },
    },
  },

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
    args: [1, Infinity],
    usage: "fav <name|number>",
    help: "Play a Sonos favorite (name match is case-insensitive and partial)",
    run: async (ctx, args) => {
      const query = args.join(" ");
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
    args: [1, Infinity],
    options: { radio: { type: "boolean" } },
    usage: "play-uri <uri> [title] [--radio]",
    help: "Play a URI (for example an HTTP stream). A title makes it a radio station",
    run: async (ctx, [uri, ...title]) => {
      await ctx.speaker().playUri(uri!, { title: title.join(" ") || undefined, radio: ctx.flags.has("radio") });
    },
  },
  {
    names: ["fade"],
    options: { out: { type: "string" }, in: { type: "string" }, volume: { type: "string" } },
    usage: "fade [next|prev|fav <name>|uri <uri>|file <path>]",
    help: "Fade out, switch the song, fade back in. 'file' serves the file until it ends (like play-file)",
    subcommands: {
      next: { run: async (ctx) => fadeTo(ctx, async (s) => { await s.next(); await s.play(); }) },
      prev: { run: async (ctx) => fadeTo(ctx, async (s) => { await s.previous(); await s.play(); }) },
      fav: {
        args: [1, Infinity],
        run: async (ctx, args) => {
          const fav = pickFavorite(await ctx.speaker().favorites(), args.join(" "));
          assertPlayable(fav);
          await fadeTo(ctx, (s) => s.playFavorite(fav));
        },
      },
      uri: {
        args: [1, Infinity],
        run: async (ctx, [uri, ...title]) => fadeTo(ctx, (s) => s.playUri(uri!, { title: title.join(" ") || undefined })),
      },
      file: {
        args: [1, Infinity],
        run: async (ctx, args) => {
          const s = ctx.speaker();
          const options = fadeOptions(ctx);
          await playFile(s, args.join(" "), (play) => fade(s, play, options));
        },
      },
    },
  },
  {
    names: ["play-file", "file"],
    args: [1, Infinity],
    usage: "play-file <path>",
    help: "Play a local audio file. Serves it over HTTP until playback ends (Ctrl-C stops)",
    run: async (ctx, args) => {
      const path = args.join(" ");
      await playFile(ctx.speaker(), path);
    },
  },
  {
    names: ["interrupt", "insert"],
    args: [1, Infinity],
    options: { volume: { type: "string" } },
    usage: "interrupt <path> [--volume n]",
    help: "Play a local file, then return to the previous music at the same position",
    run: async (ctx, args) => {
      const path = args.join(" ");
      await interruptWith(ctx.speaker(), path, { volume: volumeOption(ctx) });
    },
  },
  {
    names: ["say", "tts"],
    args: [1, Infinity],
    options: { volume: { type: "string" }, voice: { type: "string" } },
    usage: 'say "<text>" [--voice Anna] [--volume n]',
    help: "Speak a text (macOS say), then return to the previous music at the same position",
    run: async (ctx, args) => {
      const text = args.join(" ");
      const volume = volumeOption(ctx);
      const path = await speechToFile(text, ctx.options.get("voice"));
      try {
        await interruptWith(ctx.speaker(), path, { volume, title: "Announcement" });
      } finally {
        await Bun.file(path).delete().catch(() => {});
      }
    },
  },
  {
    names: ["snapshot", "snap"],
    usage: "snapshot [save|restore|show] [name]",
    help: "Save what the group plays (source, track, position, volumes), or restore it",
    subcommands: {
      save: {
        args: [0, 1],
        run: async (ctx, [name = "default"]) => {
          const snap = await takeSnapshot(ctx.speaker());
          await saveSnapshot(name, snap);
          out(ctx, snap, () => `Saved "${name}": ${describeSnapshot(snap)}`);
        },
      },
      restore: {
        args: [0, 1],
        run: async (ctx, [name = "default"]) => {
          const snap = await loadSnapshot(name);
          const summary = reportRestore(snap, await restoreSnapshot(ctx.speaker(), snap), "Restored");
          if (!isDryRun()) out(ctx, snap.title, () => summary);
        },
      },
      show: {
        args: [0, 1],
        run: async (ctx, [name = "default"]) => {
          const snap = await loadSnapshot(name);
          out(ctx, snap, () => describeSnapshot(snap));
        },
      },
    },
  },
  {
    names: ["line-in"],
    args: [0, 1],
    usage: "line-in [source room]",
    help: "Play the line-in input of this speaker or of another speaker",
    run: async (ctx, [source]) => {
      const s = ctx.speaker();
      await s.lineIn(source ? ctx.find(source) : s);
    },
  },
  { names: ["tv"], usage: "tv", help: "Switch a soundbar to the TV input", run: async (ctx) => ctx.speaker().tv() },

  {
    names: ["join", "group"],
    args: [1, Infinity],
    usage: "join <room>",
    help: "Add the speaker to the group of another room",
    run: async (ctx, args) => {
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

  {
    names: ["light"],
    args: [0, 1],
    usage: "light [on|off]",
    help: "Get or set the status light",
    run: async (ctx, args) => {
      const s = ctx.speaker();
      await onOffSetting(ctx, args, () => s.statusLight(), (v) => s.setStatusLight(v));
    },
  },
  {
    names: ["buttons"],
    args: [0, 1],
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

  {
    names: ["actions", "describe"],
    args: [0, 1],
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
    args: [2, Infinity],
    usage: "raw <Service> <Action> [Arg=Value ...]",
    help: "Send any UPnP action to the speaker (see 'actions')",
    run: async (ctx, [service, action, ...rest]) => {
      const args = Object.fromEntries(
        rest.map((kv) => {
          const i = kv.indexOf("=");
          if (i < 0) throw new SonosError(`Expected Arg=Value, got "${kv}"`);
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const result = await soap(ctx.speaker().ip, resolveService(service!), action!, args);
      out(ctx, result, () => Object.entries(result).map(([k, v]) => `${k}: ${v}`).join("\n") || "OK");
    },
  },
  {
    names: ["ws"],
    args: [2, 3],
    options: { player: { type: "boolean" }, household: { type: "boolean" } },
    usage: "ws <namespace> <command> [json-body] [--player|--household]",
    help: "Send a command to the local Sonos Control API (WebSocket, port 1443)",
    run: async (ctx, [namespace, command, body]) => {
      if (ctx.flags.has("player") && ctx.flags.has("household")) throw new UsageError("Options --player and --household cannot be combined");
      let requestBody: unknown;
      try {
        requestBody = body ? JSON.parse(body) : {};
      } catch {
        throw new UsageError("WebSocket body must be valid JSON");
      }
      if (!isRecord(requestBody)) throw new UsageError("WebSocket body must be a JSON object");
      const s = ctx.speaker();
      const ns = namespace!.includes(":") ? namespace! : `${namespace}:1`;
      // A player command sent to another speaker fails with ERROR_INVALID_OBJECT_ID.
      const ip = ctx.flags.has("player") ? s.ip : s.coordinator.ip;
      if (isDryRun() && !/^(get|subscribe|unsubscribe)/.test(command!)) {
        console.error(`[dry-run] ${ip} ${ns}.${command} ${body ?? "{}"}`);
        return;
      }
      const ws = await SonosWebSocket.connect(ip);
      try {
        const header: WsHeader = { namespace: ns, command: command! };
        if (ctx.flags.has("player")) header.playerId = s.uuid;
        else if (ctx.flags.has("household")) header.householdId = await ws.householdId();
        else header.groupId = s.group.id;
        const [, response] = await ws.request(header, requestBody);
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
    run: async (ctx) => watch(ctx.speaker(), ctx.json),
  },
];

function fadeSeconds(ctx: Context, name: "out" | "in"): number {
  const value = ctx.options.get(name);
  if (value === undefined) return FADE_DEFAULTS[name];
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n < 0 || n > MAX_FADE_SECONDS) {
    throw new UsageError(`--${name} must be 0 to ${MAX_FADE_SECONDS} seconds, got "${value}"`);
  }
  return n;
}

function fadeOptions(ctx: Context): FadeOptions {
  return { out: fadeSeconds(ctx, "out"), in: fadeSeconds(ctx, "in"), volume: volumeOption(ctx) };
}

async function fadeTo(ctx: Context, change: (s: Speaker) => Promise<unknown>) {
  const s = ctx.speaker();
  const options = fadeOptions(ctx);
  await fade(s, () => change(s), options);
  if (isDryRun()) return;
  const track = await s.currentTrack();
  out(ctx, { ...options, track }, () => `${describeTrack(track)}  (faded out ${options.out}s, in ${options.in}s)`);
}

function volumeOption(ctx: Context): number | undefined {
  return ctx.options.has("volume") ? int(ctx.options.get("volume"), "--volume") : undefined;
}

function resolveService(name: string): ServiceName {
  const match = Object.keys(SERVICES).find((s) => s.toLowerCase() === name.toLowerCase());
  if (!match) throw new SonosError(`Unknown service "${name}". Known: ${Object.keys(SERVICES).join(", ")}`);
  return match as ServiceName;
}

const commandByName = new Map(commands.flatMap((c) => c.names.map((n) => [n, c] as const)));

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
                         fade: volume of all group members after the fade
  --voice <name>         say: macOS voice (list: say -v '?'), for example Anna
  --player, --household  ws: target the player or the household (default: group)
  --out <s>, --in <s>    fade: fade-out and fade-in time in seconds (default ${FADE_DEFAULTS.out} and ${FADE_DEFAULTS.in}, max ${MAX_FADE_SECONDS})
  -h, --help             Show this help

Environment:
  SONOS_SPEAKER          Default room
  SONOS_HOST             IP of one speaker (skips discovery)

Without a room, commands use SONOS_SPEAKER or the coordinator of the only group.
Transport and queue commands always go to the group coordinator.`;
}

async function main(argv: string[]) {
  const { positional, flags, options } = parseArguments(argv, commands);
  let speakerQuery = options.get("speaker");
  if (flags.has("help") || positional.length === 0) {
    console.log(usage());
    return;
  }
  setDryRun(flags.has("dry-run"));

  // "sonos Kantine volume 20"
  let [name, ...args] = positional;
  if (!commandByName.has(name!) && positional.length > 1 && commandByName.has(positional[1]!)) {
    speakerQuery = name;
    [name, ...args] = positional.slice(1);
  }
  const command = commandByName.get(name!);
  if (!command) throw new UsageError(`Unknown command "${name}". Run "sonos --help".`);
  const [action, actionArgs] = resolveAction(command, args, [...flags, ...options.keys()]);

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
  await action.run(ctx, actionArgs);
}

main(Bun.argv.slice(2)).catch((err) => {
  console.error(err instanceof SonosError ? `Error: ${err.message}` : err);
  process.exitCode = process.exitCode === 130 ? 130 : err instanceof UsageError ? 2 : 1;
});
