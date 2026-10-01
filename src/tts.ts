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
  const [exitCode, stderr] = await Promise.all([proc.exited, proc.stderr.text()]);
  if (exitCode !== 0) {
    await Bun.file(path).delete().catch(() => {});
    throw new SonosError(`say failed: ${stderr.trim()}`);
  }
  return path;
}
