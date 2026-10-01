import { networkInterfaces } from "node:os";
import { basename, extname } from "node:path";
import { SonosError } from "./soap.ts";
import type { Speaker } from "./speaker.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export interface FileServer {
  url: string;
  title: string;
  contentType: string;
  stop: () => Promise<void>;
}

const toInt = (ip: string) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

export function localAddressFor(speakerIp: string): string {
  const target = toInt(speakerIp);
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal);
  const sameNet = candidates.find((a) => {
    const mask = toInt(a!.netmask);
    return (toInt(a!.address) & mask) === (target & mask);
  });
  const address = (sameNet ?? candidates[0])?.address;
  if (!address) throw new SonosError("No local IPv4 address found to serve the file");
  return address;
}

export async function serveFile(path: string, speakerIp: string, allowedIps: string[], title?: string): Promise<FileServer> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new SonosError(`File not found: ${path}`);
  const ext = extname(path).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw new SonosError(`Unsupported file type "${ext}". Supported: ${Object.keys(CONTENT_TYPES).join(", ")}`);

  const allowed = new Set(allowedIps);
  const filePath = `/${crypto.randomUUID()}/${encodeURIComponent(basename(path))}`;
  const host = localAddressFor(speakerIp);
  const server = Bun.serve({
    hostname: host,
    port: 0,
    fetch(req, srv) {
      const client = srv.requestIP(req)?.address?.replace(/^::ffff:/, "") ?? "";
      if (!allowed.has(client)) return new Response("Forbidden", { status: 403 });
      if (new URL(req.url).pathname !== filePath) return new Response("Not found", { status: 404 });
      // Bun answers the Range requests that Sonos sends to seek.
      return new Response(file, { headers: { "Content-Type": contentType } });
    },
  });
  return {
    url: `http://${host}:${server.port}${filePath}`,
    title: title ?? basename(path, extname(path)),
    contentType,
    stop: () => server.stop(true),
  };
}

export interface WaitOptions {
  signal?: AbortSignal;
  pollMs?: number;
  /** Keeps serving while an interrupt plays, so the restore can return to the file. */
  replacedGraceMs?: number;
}

// Ctrl-C must not wait for the next poll.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal?.addEventListener("abort", wake);
  });
}

export async function waitForFileEnd(
  s: Speaker,
  url: string,
  { pollMs = 2000, replacedGraceMs = 0, signal }: WaitOptions = {},
): Promise<"ended" | "replaced"> {
  // Sonos reports STOPPED for a moment while the stream starts.
  const startGraceMs = 6000;
  let started = Date.now();
  let seenPlaying = false;
  let replacedSince: number | undefined;
  let failures = 0;
  for (;;) {
    await sleep(pollMs, signal);
    signal?.throwIfAborted();
    try {
      const [{ uri }, state] = await Promise.all([s.mediaInfo(), s.transportState()]);
      failures = 0;
      if (uri !== url) {
        replacedSince ??= Date.now();
        if (Date.now() - replacedSince >= replacedGraceMs) return "replaced";
        continue;
      }
      if (replacedSince !== undefined) {
        // Back after an interrupt: the restore passes through STOPPED before it plays.
        replacedSince = undefined;
        started = Date.now();
        seenPlaying = false;
      }
      if (state === "PLAYING") seenPlaying = true;
      if (state === "STOPPED" && (seenPlaying || Date.now() - started > startGraceMs)) return "ended";
    } catch (err) {
      if (++failures >= 15) throw err;
    }
  }
}
