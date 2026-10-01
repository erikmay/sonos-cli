import { homedir } from "node:os";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { SonosError, isDryRun } from "./soap.ts";
import { PLAY_MODES, Speaker, parseTime, type PlayMode } from "./speaker.ts";
import { isRecord } from "./validation.ts";

// Port of SoCo snapshot.py. Group membership is not part of a snapshot.

export interface MemberState {
  uuid: string;
  name: string;
  volume: number;
  muted: boolean;
}

export interface Snapshot {
  createdAt: string;
  groupName: string;
  coordinatorUuid: string;
  mediaUri: string;
  mediaMetadata: string;
  /** 1-based. */
  queuePosition: number;
  /** Empty for streams without a position. */
  position: string;
  title: string;
  state: string;
  playMode: PlayMode;
  members: MemberState[];
}

const isQueue = (uri: string) => uri.startsWith("x-rincon-queue:");

export function groupSpeakers(s: Speaker): Speaker[] {
  return s.group.members.map((m) => new Speaker(m, s.group, s.topology));
}

export async function takeSnapshot(s: Speaker): Promise<Snapshot> {
  const [media, track, state, playMode, memberStates] = await Promise.all([
    s.mediaInfo(),
    s.currentTrack(),
    s.transportState(),
    s.playMode(),
    Promise.all(
      groupSpeakers(s).map(async (m) => {
        const [volume, muted] = await Promise.all([m.volume(), m.muted()]);
        return { uuid: m.uuid, name: m.name, volume, muted };
      }),
    ),
  ]);
  return {
    createdAt: new Date().toISOString(),
    groupName: s.group.members.map((m) => m.name).join(" + "),
    coordinatorUuid: s.coordinator.uuid,
    mediaUri: media.uri,
    mediaMetadata: media.metadata,
    queuePosition: track.queuePosition,
    position: track.position,
    title: [track.artist, track.title].filter(Boolean).join(" - "),
    state: state === "TRANSITIONING" ? "PLAYING" : state,
    playMode,
    members: memberStates,
  };
}

/** Returns warnings for the parts that failed. */
export async function restoreSnapshot(s: Speaker, snap: Snapshot): Promise<string[]> {
  const warnings: string[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const savedMembers = new Map(snap.members.map((m) => [m.uuid, m]));

  // Volumes first, so the music does not resume at announcement volume.
  await Promise.all(groupSpeakers(s).map(async (m) => {
    const saved = savedMembers.get(m.uuid);
    if (!saved) return;
    await attempt(`${m.name} volume`, () => m.setVolume(saved.volume));
    await attempt(`${m.name} mute`, () => m.setMuted(saved.muted));
  }));

  if (!snap.mediaUri) {
    await attempt("stop", () => s.stop());
    return warnings;
  }

  const sourceSet = await attempt("source", async () => {
    if (isQueue(snap.mediaUri)) {
      // The queue belongs to the current coordinator, which can differ from the saved one.
      await s.setSource(`x-rincon-queue:${s.coordinator.uuid}#0`);
      if (snap.queuePosition > 0) await s.seekTrack(snap.queuePosition);
    } else {
      await s.setSource(snap.mediaUri, snap.mediaMetadata);
    }
  });
  if (!sourceSet) return warnings;
  await attempt("play mode", () => s.setPlayMode(snap.playMode));

  const wasPlaying = snap.state === "PLAYING";
  if (snap.position && parseTime(snap.position) > 0) {
    try {
      await s.seek(snap.position);
    } catch {
      // Some sources seek only while playing. Radio never seeks.
      if (wasPlaying && !isDryRun()) {
        if (await attempt("play", () => s.play())) {
          await Bun.sleep(1000);
          await attempt(`position ${snap.position}`, () => s.seek(snap.position));
        }
        return warnings;
      }
      warnings.push(`position ${snap.position}: the source does not support seek`);
    }
  }
  if (wasPlaying) await attempt("play", () => s.play());
  return warnings;
}

/** Prints the warnings and returns the summary line. */
export function reportRestore(snap: Snapshot, warnings: string[], success: string): string {
  for (const warning of warnings) console.error(`Warning: ${warning}`);
  return `${warnings.length ? "Restoration finished with warnings" : success}: ${describeSnapshot(snap)}`;
}

export function describeSnapshot(snap: Snapshot): string {
  const at = snap.position ? ` at ${snap.position}` : "";
  const volumes = snap.members.map((m) => `${m.name} ${m.volume}${m.muted ? " (muted)" : ""}`).join(", ");
  return `${snap.title || snap.mediaUri || "(no source)"}${at}, ${snap.state}, ${volumes}`;
}

function decodeSnapshot(value: unknown): Snapshot {
  const invalid = (field: string): never => { throw new SonosError(`Invalid snapshot field: ${field}`); };
  if (!isRecord(value)) return invalid("snapshot");
  const string = (field: string): string => typeof value[field] === "string" ? value[field] : invalid(field);
  const playMode = string("playMode");
  if (!Object.hasOwn(PLAY_MODES, playMode)) return invalid("playMode");
  const position = string("position");
  if (position && !/^\d+:[0-5]\d:[0-5]\d$/.test(position)) return invalid("position");
  const queuePosition = value.queuePosition;
  if (typeof queuePosition !== "number" || !Number.isSafeInteger(queuePosition) || queuePosition < 0) return invalid("queuePosition");
  if (!Array.isArray(value.members)) return invalid("members");
  const members = value.members.map((m: unknown): MemberState => {
    if (!isRecord(m) || typeof m.uuid !== "string" || typeof m.name !== "string" || typeof m.muted !== "boolean" ||
        typeof m.volume !== "number" || !Number.isInteger(m.volume) || m.volume < 0 || m.volume > 100) {
      return invalid("members");
    }
    return { uuid: m.uuid, name: m.name, volume: m.volume, muted: m.muted };
  });
  return {
    createdAt: string("createdAt"), groupName: string("groupName"), coordinatorUuid: string("coordinatorUuid"),
    mediaUri: string("mediaUri"), mediaMetadata: string("mediaMetadata"), title: string("title"), state: string("state"),
    position, queuePosition, playMode: playMode as PlayMode, members,
  };
}

const snapshotDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "sonos-cli", "snapshots");

function snapshotPath(name: string) {
  if (!/^[\w.-]+$/.test(name)) throw new SonosError(`Invalid snapshot name "${name}" (use letters, digits, ".", "-", "_")`);
  return join(snapshotDir, `${name}.json`);
}

export async function saveSnapshot(name: string, snap: Snapshot) {
  const path = snapshotPath(name);
  const data = JSON.stringify(snap, null, 2);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, data);
    await rename(temporary, path);
  } finally {
    await Bun.file(temporary).delete().catch(() => {});
  }
}

export async function loadSnapshot(name: string): Promise<Snapshot> {
  const file = Bun.file(snapshotPath(name));
  if (!(await file.exists())) throw new SonosError(`Snapshot "${name}" not found`);
  try {
    return decodeSnapshot(await file.json());
  } catch (err) {
    throw new SonosError(`Snapshot "${name}" is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}
