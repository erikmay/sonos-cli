import { rename } from "node:fs/promises";
import { join } from "node:path";
import tapSource from "./audiotap.swift" with { type: "text" };
import { cacheDir } from "./discovery.ts";
import { serveTo, type FileServer } from "./fileserver.ts";
import { SonosError, isDryRun } from "./soap.ts";

export const APPLE_MUSIC = "com.apple.Music";
const CONTENT_TYPE = "audio/mpeg";

// macOS asks for the audio capture permission only with this usage description.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.github.erikmay.sonos-cli.audio-tap</string>
<key>NSAudioCaptureUsageDescription</key><string>sonos-cli streams the sound of this Mac to Sonos speakers.</string>
</dict></plist>
`;

// Bun cannot call the Core Audio tap API, so a Swift helper does the capture. It is built once per source version.
async function tapBinary(): Promise<string> {
  if (process.platform !== "darwin") throw new SonosError("Streaming the Mac sound needs macOS 14.2 or newer");
  const dir = join(cacheDir, "audio-tap");
  const binary = join(dir, `audio-tap-${Bun.hash(tapSource + INFO_PLIST).toString(36)}`);
  if (await Bun.file(binary).exists()) return binary;
  if (!Bun.which("swiftc")) throw new SonosError('The audio tap needs the Swift compiler. Install it with "xcode-select --install"');
  console.error("Building the audio tap helper (first run only) ...");
  const source = join(dir, "audiotap.swift");
  const plist = join(dir, "Info.plist");
  await Bun.write(source, tapSource);
  await Bun.write(plist, INFO_PLIST);
  const linkPlist = ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist];
  const proc = Bun.spawn(["swiftc", "-O", "-o", `${binary}.tmp`, source, ...linkPlist], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, proc.stderr.text()]);
  if (exitCode !== 0) throw new SonosError(`Building the audio tap failed: ${stderr.trim()}`);
  // A cancelled build must not leave a broken binary under the final name.
  await rename(`${binary}.tmp`, binary);
  return binary;
}

// Resolves with the sample rate and channel count. The other stderr lines are messages for the user.
function tapFormat(tap: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<[rate: number, channels: number]> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let pending = "";
      for await (const text of tap.stderr.pipeThrough(new TextDecoderStream())) {
        const lines = (pending + text).split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          const match = /^format (\d+) (\d+)$/.exec(line);
          if (match) resolve([Number(match[1]), Number(match[2])]);
          else console.error(line);
        }
      }
      reject(new SonosError(`The audio tap stopped (exit code ${await tap.exited})`));
    })();
  });
}

/** Streams the sound of one app (or of all apps without `app`) as MP3 to the speakers. */
export async function serveMacAudio(speakerIp: string, allowedIps: string[], app?: string): Promise<FileServer> {
  const title = app === APPLE_MUSIC ? "Apple Music" : app ?? "Mac";
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = serveTo(speakerIp, allowedIps, "mac-audio.mp3", () => {
    let client: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => void clients.add((client = controller)),
      cancel: () => void clients.delete(client),
    });
    return new Response(body, { headers: { "Content-Type": CONTENT_TYPE } });
  });
  if (isDryRun()) return { ...server, title, contentType: CONTENT_TYPE };

  if (!Bun.which("ffmpeg")) throw new SonosError('Streaming the Mac sound needs ffmpeg. Install it with "brew install ffmpeg"');
  const tap = Bun.spawn([await tapBinary(), app ?? "--all"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let encoder: Bun.Subprocess | undefined;
  // The encoder stops first, so it does not report the closed stream as an error.
  const stop = async () => {
    encoder?.kill();
    await encoder?.exited;
    tap.kill();
    await server.stop();
  };
  try {
    const [rate, channels] = await tapFormat(tap);
    const input = ["-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0"];
    // Small packets keep the delay on Sonos short.
    const output = ["-c:a", "libmp3lame", "-b:a", "320k", "-flush_packets", "1", "-f", "mp3", "pipe:1"];
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...input, ...output], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    encoder = proc;
    // With the tap stream as "stdin", Bun delivers the first audio only after minutes. A flush per chunk keeps it live.
    void (async () => {
      try {
        for await (const chunk of tap.stdout) {
          proc.stdin.write(chunk);
          await proc.stdin.flush();
        }
        await proc.stdin.end();
      } catch {
        // The encoder has stopped. Its exit ends the stream.
      }
    })();
    void (async () => {
      for await (const chunk of proc.stdout) {
        for (const client of clients) {
          try {
            client.enqueue(chunk);
          } catch {
            clients.delete(client);
          }
        }
      }
      // Sonos sees the end of the stream and stops.
      for (const client of clients) client.close();
    })();
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: server.url, title, contentType: CONTENT_TYPE, stop };
}
