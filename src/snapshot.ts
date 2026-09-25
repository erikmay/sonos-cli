import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { SonosError, isDryRun } from "./soap.ts";
import { Speaker, type PlayMode } from "./speaker.ts";

// Saves and restores what a group plays, like SoCo snapshot.py: the source,
// the queue track, the position in the track, the play mode, and the volume
// of each member. The group itself (which rooms) is not changed.

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
  /** Track number in the queue (1-based). Only used if the source is the queue. */
  queuePosition: number;
  /** Position in the track, "H:MM:SS". Empty for streams without a position. */
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
      groupSpeakers(s).map(async (m) => ({ uuid: m.uuid, name: m.name, volume: await m.volume(), muted: await m.muted() })),
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
    // TRANSITIONING means that playback starts, so treat it as playing.
    state: state === "TRANSITIONING" ? "PLAYING" : state,
    playMode,
    members: memberStates,
  };
}

/** Restores a snapshot on the group of `s`. Returns warnings for parts that failed. */
export async function restoreSnapshot(s: Speaker, snap: Snapshot): Promise<string[]> {
  const warnings: string[] = [];
  if (!snap.mediaUri) throw new SonosError("The snapshot has no source to restore");

  // Volumes first, so the music does not start at the volume of the announcement.
  for (const m of groupSpeakers(s)) {
    const saved = snap.members.find((x) => x.uuid === m.uuid);
    if (!saved) continue;
    await m.setVolume(saved.volume);
    await m.setMuted(saved.muted);
  }

  if (isQueue(snap.mediaUri)) {
    // The queue belongs to the coordinator. Use the current one.
    await s.setSource(`x-rincon-queue:${s.coordinator.uuid}#0`);
    if (snap.queuePosition > 0) await s.seekTrack(snap.queuePosition);
  } else {
    await s.setSource(snap.mediaUri, snap.mediaMetadata);
  }
  await s.setPlayMode(snap.playMode).catch((e) => warnings.push(`play mode: ${e.message}`));

  const wasPlaying = snap.state === "PLAYING";
  if (snap.position && snap.position !== "0:00:00") {
    try {
      await s.seek(snap.position);
    } catch {
      // Some sources accept a seek only while they play. Radio streams do not seek at all.
      if (wasPlaying && !isDryRun()) {
        await s.play();
        await Bun.sleep(1000);
        await s.seek(snap.position).catch((e) => warnings.push(`position ${snap.position}: ${e.message}`));
        return warnings;
      }
      warnings.push(`position ${snap.position}: the source does not support seek`);
    }
  }
  if (wasPlaying) await s.play();
  return warnings;
}

// Named snapshots are stored as JSON, so "restore" also works from a new process.
const snapshotDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "sonos-cli", "snapshots");

function snapshotPath(name: string) {
  if (!/^[\w.-]+$/.test(name)) throw new SonosError(`Invalid snapshot name "${name}" (use letters, digits, ".", "-", "_")`);
  return join(snapshotDir, `${name}.json`);
}

export async function saveSnapshot(name: string, snap: Snapshot) {
  await mkdir(snapshotDir, { recursive: true });
  await Bun.write(snapshotPath(name), JSON.stringify(snap, null, 2));
}

export async function loadSnapshot(name: string): Promise<Snapshot> {
  const file = Bun.file(snapshotPath(name));
  if (!(await file.exists())) throw new SonosError(`Snapshot "${name}" not found`);
  return (await file.json()) as Snapshot;
}
