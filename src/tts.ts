import { tmpdir } from "node:os";
import { join } from "node:path";
import { SonosError } from "./soap.ts";

// The caller deletes the file.
export async function speechToFile(text: string, voice?: string): Promise<string> {
  if (process.platform !== "darwin") throw new SonosError("Text to speech needs the macOS \"say\" command");
  const path = join(tmpdir(), `sonos-say-${crypto.randomUUID()}.wav`);
  const args = ["say", "-o", path, "--file-format=WAVE", "--data-format=LEI16@44100"];
  if (voice) args.push("-v", voice);
  const proc = Bun.spawn([...args, "--", text], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new SonosError(`say failed: ${(await new Response(proc.stderr).text()).trim()}`);
  }
  return path;
}
