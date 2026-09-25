import { networkInterfaces } from "node:os";
import { basename, extname } from "node:path";
import { SonosError } from "./soap.ts";

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
  stop: () => void;
}

const toInt = (ip: string) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

/** Finds the local IPv4 address in the same network as `speakerIp`. */
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

/**
 * Serves one local file over HTTP so a speaker can stream it, like soco-cli
 * play_local_file. Only `allowedIps` (the speakers) get the file. The path
 * has a random token, and the port is chosen by the OS.
 */
export async function serveFile(path: string, speakerIp: string, allowedIps: string[]): Promise<FileServer> {
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
      // Bun answers Range requests for Bun.file bodies. Sonos uses them to seek.
      return new Response(file, { headers: { "Content-Type": contentType } });
    },
  });
  return {
    url: `http://${host}:${server.port}${filePath}`,
    title: basename(path, extname(path)),
    contentType,
    stop: () => server.stop(true),
  };
}
