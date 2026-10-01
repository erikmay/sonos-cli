import { trapInterrupt } from "./interrupt.ts";
import { groupSpeakers } from "./snapshot.ts";
import { isDryRun } from "./soap.ts";
import type { Speaker } from "./speaker.ts";

/** Seconds. Slow enough that a change of song in a quiet office goes unnoticed. */
export const FADE_DEFAULTS = { out: 6, in: 4 };
export const MAX_FADE_SECONDS = 300;
const STEP_MS = 100;
const START_TIMEOUT_MS = 10_000;

export interface FadeOptions {
  out: number;
  in: number;
  /** Volume of every group member after the fade. Without it, each member returns to its own volume. */
  volume?: number;
}

// Sonos plays one source per group, so the fade goes down, switches the source and comes back up.
export async function fade(s: Speaker, change: () => Promise<unknown>, options: FadeOptions) {
  const members = groupSpeakers(s);
  const before = await Promise.all(members.map((m) => m.volume()));
  const current = [...before];
  let full = before;
  const setLevel = (level: number) => Promise.all(members.map(async (m, i) => {
    const volume = Math.round(full[i]! * level);
    if (volume === current[i]) return;
    await m.setVolume(volume);
    current[i] = volume;
  }));
  using interrupt = trapInterrupt();
  const ramp = async (duration: number, from: number, to: number) => {
    const started = performance.now();
    for (;;) {
      interrupt.signal.throwIfAborted();
      const t = isDryRun() || duration === 0 ? 1 : Math.min(1, (performance.now() - started) / (duration * 1000));
      // Smoothstep: no audible jump at the start or the end of the ramp.
      await setLevel(from + (to - from) * t * t * (3 - 2 * t));
      if (t === 1) return;
      await Bun.sleep(STEP_MS);
    }
  };
  try {
    await ramp(options.out, 1, 0);
    await change();
    full = before.map((v) => options.volume ?? v);
    await waitForPlaying(s, interrupt.signal);
    await ramp(options.in, 0, 1);
  } catch (err) {
    if (err !== interrupt.signal.reason) throw err;
  } finally {
    // An error or Ctrl-C must not leave the room silent.
    await setLevel(1);
  }
}

// A new stream buffers first. A fade-in during buffering is lost.
async function waitForPlaying(s: Speaker, signal: AbortSignal) {
  if (isDryRun()) return;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && (await s.transportState()) !== "PLAYING") {
    signal.throwIfAborted();
    await Bun.sleep(250);
  }
}
