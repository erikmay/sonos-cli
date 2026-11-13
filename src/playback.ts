import { serveFile, waitForFileEnd, type FileServer } from "./fileserver.ts";
import { trapInterrupt } from "./interrupt.ts";
import { groupSpeakers, takeSnapshot, saveSnapshot, restoreSnapshot, reportRestore } from "./snapshot.ts";
import { Speaker, groupName, trackMetadata } from "./speaker.ts";
import { isDryRun } from "./soap.ts";
import { serveMacAudio } from "./macaudio.ts";

async function withServer(server: FileServer, run: (signal: AbortSignal) => Promise<void>) {
  using interrupt = trapInterrupt();
  try {
    await run(interrupt.signal);
  } catch (err) {
    if (err !== interrupt.signal.reason) throw err;
  } finally {
    await server.stop();
  }
}

/** `start` wraps the switch to the file, for example in a fade. */
export async function playFile(s: Speaker, path: string, start = (play: () => Promise<void>) => play()) {
  const server = await serveFile(path, s.coordinator.ip, s.topology.members.map((m) => m.ip));
  await playServed(s, server, server.url, start, () => s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) }));
}

/** Streams the sound of an app on this Mac (or of all apps without `app`) until Ctrl-C. */
export async function playMacAudio(s: Speaker, app: string | undefined, start = (play: () => Promise<void>) => play()) {
  const server = await serveMacAudio(s.coordinator.ip, s.topology.members.map((m) => m.ip), app);
  // Radio mode: Sonos plays a live stream without a length.
  const uri = server.url.replace(/^http:/, "x-rincon-mp3radio:");
  await playServed(s, server, uri, start, () => s.playUri(uri, { title: server.title }));
}

async function playServed(s: Speaker, server: FileServer, uri: string, start: (play: () => Promise<void>) => Promise<void>, play: () => Promise<void>) {
  await withServer(server, async (signal) => {
    try {
      await start(play);
      if (isDryRun()) return;
      console.error(`Playing "${server.title}" on ${groupName(s.group)}. Press Ctrl-C to stop.`);
      const result = await waitForFileEnd(s, uri, { replacedGraceMs: 10 * 60_000, signal });
      console.error(result === "ended" ? "Playback ended." : `Another source replaced "${server.title}".`);
    } finally {
      if (signal.aborted && !isDryRun()) {
        // Without the server, our file cannot continue. Other music can.
        if ((await s.mediaInfo().catch(() => ({ uri: "" }))).uri === uri) await s.stop();
      }
    }
  });
}

export async function interruptWith(s: Speaker, path: string, { volume, title }: { volume?: number; title?: string } = {}) {
  const server = await serveFile(path, s.coordinator.ip, s.topology.members.map((m) => m.ip), title);
  await withServer(server, async (signal) => {
    const snap = await takeSnapshot(s);
    // The recovery snapshot remains available if the process cannot complete restoration.
    if (!isDryRun()) await saveSnapshot("last-interrupt", snap);
    let replaced = false;
    try {
      if (volume !== undefined) for (const m of groupSpeakers(s)) await m.setVolume(volume);
      // A Ctrl-C during the preparation must not start the file.
      signal.throwIfAborted();
      await s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) });
      if (!isDryRun()) {
        console.error(`Playing "${server.title}" on ${groupName(s.group)} ...`);
        replaced = await waitForFileEnd(s, server.url, { pollMs: 500, signal }) === "replaced";
      }
    } finally {
      if (!replaced) {
        const summary = reportRestore(snap, await restoreSnapshot(s, snap), "Back to");
        if (!isDryRun()) console.error(summary);
      }
    }
    if (replaced) console.error("Another source started. The previous music is not restored.");
  });
}
