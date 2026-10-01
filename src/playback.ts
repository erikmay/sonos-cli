import { serveFile, waitForFileEnd, type FileServer } from "./fileserver.ts";
import { trapInterrupt } from "./interrupt.ts";
import { groupSpeakers, takeSnapshot, saveSnapshot, restoreSnapshot, reportRestore } from "./snapshot.ts";
import { Speaker, groupName, trackMetadata } from "./speaker.ts";
import { isDryRun } from "./soap.ts";

async function withFile(s: Speaker, path: string, title: string | undefined, run: (server: FileServer, signal: AbortSignal) => Promise<void>) {
  const server = await serveFile(path, s.coordinator.ip, s.topology.members.map((m) => m.ip), title);
  using interrupt = trapInterrupt();
  try {
    await run(server, interrupt.signal);
  } catch (err) {
    if (err !== interrupt.signal.reason) throw err;
  } finally {
    await server.stop();
  }
}

/** `start` wraps the switch to the file, for example in a fade. */
export async function playFile(s: Speaker, path: string, start = (play: () => Promise<void>) => play()) {
  await withFile(s, path, undefined, async (server, signal) => {
    try {
      await start(() => s.playUri(server.url, { metadata: trackMetadata(server.title, server.url, server.contentType) }));
      if (isDryRun()) return;
      console.error(`Playing "${server.title}" on ${groupName(s.group)}. Press Ctrl-C to stop.`);
      const result = await waitForFileEnd(s, server.url, { replacedGraceMs: 10 * 60_000, signal });
      console.error(result === "ended" ? "Playback ended." : "Another source replaced the file.");
    } finally {
      if (signal.aborted && !isDryRun()) {
        // Without the server, our file cannot continue. Other music can.
        if ((await s.mediaInfo().catch(() => ({ uri: "" }))).uri === server.url) await s.stop();
      }
    }
  });
}

export async function interruptWith(s: Speaker, path: string, { volume, title }: { volume?: number; title?: string } = {}) {
  await withFile(s, path, title, async (server, signal) => {
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
