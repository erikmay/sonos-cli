// Bun.XML returns an array only when an element repeats.
const ARRAY_TAGS = new Set([
  "item",
  "container",
  "res",
  "ZoneGroup",
  "ZoneGroupMember",
  "Satellite",
  "Alarm",
  "action",
  "argument",
  "stateVariable",
  "service",
  "allowedValue",
]);

// Some track titles contain control characters that XML 1.0 forbids (SoCo strips them too).
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export type XmlNode = Record<string, any>;

// Keys lose their namespace prefix ("dc:title" -> "title"); attributes keep "@".
export function parseXml(xml: string): XmlNode {
  let parsed: unknown;
  try {
    parsed = Bun.XML.parse(xml);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    parsed = Bun.XML.parse(xml.replace(ILLEGAL_XML_CHARS, ""));
  }
  return (normalize(parsed) ?? {}) as XmlNode;
}

const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== "object") return node;
  const out: XmlNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "@xmlns" || key.startsWith("@xmlns:")) continue;
    if (key.startsWith("@")) {
      out[`@${localName(key.slice(1))}`] = value;
      continue;
    }
    const name = key === "#text" ? key : localName(key);
    const normalized = normalize(value);
    out[name] ??= ARRAY_TAGS.has(name) && !Array.isArray(normalized) ? [normalized] : normalized;
  }
  return out;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function text(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in node) return String((node as XmlNode)["#text"]);
  return "";
}

export interface DidlObject {
  id: string;
  parentId: string;
  kind: "item" | "container";
  upnpClass: string;
  title: string;
  creator: string;
  album: string;
  uri: string;
  protocolInfo: string;
  duration: string;
  albumArt: string;
  resMD: string;
  /** Favorites: "instantPlay" or "shortcut" (app-only, no URI). */
  type: string;
  description: string;
  streamContent: string;
}

export function parseDidl(xml: string): DidlObject[] {
  if (!xml || xml === "NOT_IMPLEMENTED") return [];
  const root = parseXml(xml)["DIDL-Lite"];
  if (!root) return [];
  const result: DidlObject[] = [];
  for (const kind of ["item", "container"] as const) {
    for (const node of (root[kind] ?? []) as XmlNode[]) {
      const res = node.res?.[0];
      result.push({
        id: node["@id"] ?? "",
        parentId: node["@parentID"] ?? "",
        kind,
        upnpClass: text(node.class),
        title: text(node.title),
        creator: text(node.creator) || text(node.albumArtist),
        album: text(node.album),
        uri: text(res),
        protocolInfo: res?.["@protocolInfo"] ?? "",
        duration: res?.["@duration"] ?? "",
        albumArt: text(node.albumArtURI),
        resMD: text(node.resMD),
        type: text(node.type),
        description: text(node.description),
        streamContent: text(node.streamContent),
      });
    }
  }
  return result;
}
