import { networkInterfaces, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PORT, SonosError, soap } from "./soap.ts";
import { parseXml, type XmlNode } from "./xml.ts";

export interface Member {
  uuid: string;
  name: string;
  ip: string;
  /** Bridges, subwoofers, satellites, right side of stereo pairs. */
  invisible: boolean;
}

export interface Group {
  id: string;
  coordinator: Member;
  members: Member[];
}

export interface Topology {
  groups: Group[];
  members: Member[];
}

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:ZonePlayer:1";

export async function ssdpDiscover(timeoutMs = 1500): Promise<string[]> {
  const message =
    "M-SEARCH * HTTP/1.1\r\n" +
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    "MX: 1\r\n" +
    `ST: ${SEARCH_TARGET}\r\n\r\n`;
  const found = new Set<string>();
  const socket = await Bun.udpSocket({
    socket: {
      data(_socket, data, _port, address) {
        if (data.toString().includes("Sonos")) found.add(address);
      },
    },
  });
  // UDP drops packets.
  for (let i = 0; i < 3; i++) {
    socket.send(message, SSDP_PORT, SSDP_ADDRESS);
    await Bun.sleep(100);
  }
  await Bun.sleep(timeoutMs);
  socket.close();
  return [...found];
}

// For networks without multicast (VPN, some Wi-Fi setups).
export async function scanNetwork(timeoutMs = 700): Promise<string[]> {
  const prefixes = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === "IPv4" && !a.internal && a.netmask === "255.255.255.0") {
        prefixes.add(a.address.split(".").slice(0, 3).join("."));
      }
    }
  }
  const candidates = [...prefixes].flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
  const results = await Promise.all(
    candidates.map(async (ip) => {
      try {
        const r = await fetch(`http://${ip}:${PORT}/xml/device_description.xml`, { signal: AbortSignal.timeout(timeoutMs) });
        return (await r.text()).includes("ZonePlayer") ? ip : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((ip): ip is string => ip !== null);
}

// Any speaker returns the topology of the whole household.
export async function getTopology(ip: string, timeoutMs?: number): Promise<Topology> {
  const { ZoneGroupState } = await soap(ip, "ZoneGroupTopology", "GetZoneGroupState", {}, timeoutMs);
  const state = parseXml(ZoneGroupState ?? "");
  // Newer firmware adds a ZoneGroupState wrapper.
  const zoneGroups: XmlNode[] = (state.ZoneGroupState ?? state).ZoneGroups?.ZoneGroup ?? [];
  const groups: Group[] = [];
  const members: Member[] = [];
  for (const zg of zoneGroups) {
    const groupMembers = (zg.ZoneGroupMember ?? []).map(toMember);
    members.push(...groupMembers);
    for (const m of zg.ZoneGroupMember ?? []) {
      members.push(...(m.Satellite ?? []).map(toMember));
    }
    const coordinator = groupMembers.find((m: Member) => m.uuid === zg["@Coordinator"]);
    if (!coordinator) continue;
    groups.push({ id: zg["@ID"], coordinator, members: groupMembers.filter((m: Member) => !m.invisible) });
  }
  return { groups: groups.filter((g) => g.members.length > 0), members };
}

function toMember(node: XmlNode): Member {
  return {
    uuid: node["@UUID"],
    name: node["@ZoneName"],
    ip: new URL(node["@Location"]).hostname,
    invisible: node["@Invisible"] === "1" || node["@IsZoneBridge"] === "1",
  };
}

// One cached IP replaces the 1.5 s SSDP search.
const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "sonos-cli");
const cacheFile = join(cacheDir, "hosts.json");

async function readCache(): Promise<string[]> {
  try {
    return (await Bun.file(cacheFile).json()) as string[];
  } catch {
    return [];
  }
}

async function writeCache(topology: Topology) {
  const ips = JSON.stringify([...new Set(topology.members.filter((m) => !m.invisible).map((m) => m.ip))]);
  if (JSON.stringify(await readCache()) === ips) return;
  await mkdir(cacheDir, { recursive: true });
  await Bun.write(cacheFile, ips);
}

export async function loadTopology(refresh = false): Promise<Topology> {
  const hosts = process.env.SONOS_HOST ? [process.env.SONOS_HOST] : refresh ? [] : await readCache();
  for (const ip of hosts) {
    try {
      // Short timeout: a cached speaker can be off.
      const topology = await getTopology(ip, 1000);
      if (!process.env.SONOS_HOST) await writeCache(topology);
      return topology;
    } catch {}
  }
  let found = await ssdpDiscover();
  if (found.length === 0) found = await scanNetwork();
  for (const ip of found) {
    try {
      const topology = await getTopology(ip);
      await writeCache(topology);
      return topology;
    } catch {}
  }
  throw new SonosError("No Sonos speakers found. Set SONOS_HOST=<ip> if discovery does not work in this network.");
}
