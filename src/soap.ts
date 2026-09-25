import { escapeXml, parseXml, type XmlNode } from "./xml.ts";

// Sonos speakers are UPnP devices. Every service accepts SOAP requests on
// HTTP port 1400. Service type and control path come from
// http://<ip>:1400/xml/device_description.xml.
export const SERVICES = {
  AVTransport: { type: "urn:schemas-upnp-org:service:AVTransport:1", path: "/MediaRenderer/AVTransport" },
  RenderingControl: { type: "urn:schemas-upnp-org:service:RenderingControl:1", path: "/MediaRenderer/RenderingControl" },
  GroupRenderingControl: { type: "urn:schemas-upnp-org:service:GroupRenderingControl:1", path: "/MediaRenderer/GroupRenderingControl" },
  Queue: { type: "urn:schemas-sonos-com:service:Queue:1", path: "/MediaRenderer/Queue" },
  VirtualLineIn: { type: "urn:schemas-upnp-org:service:VirtualLineIn:1", path: "/MediaRenderer/VirtualLineIn" },
  ContentDirectory: { type: "urn:schemas-upnp-org:service:ContentDirectory:1", path: "/MediaServer/ContentDirectory" },
  ZoneGroupTopology: { type: "urn:schemas-upnp-org:service:ZoneGroupTopology:1", path: "/ZoneGroupTopology" },
  DeviceProperties: { type: "urn:schemas-upnp-org:service:DeviceProperties:1", path: "/DeviceProperties" },
  SystemProperties: { type: "urn:schemas-upnp-org:service:SystemProperties:1", path: "/SystemProperties" },
  AlarmClock: { type: "urn:schemas-upnp-org:service:AlarmClock:1", path: "/AlarmClock" },
  MusicServices: { type: "urn:schemas-upnp-org:service:MusicServices:1", path: "/MusicServices" },
  GroupManagement: { type: "urn:schemas-upnp-org:service:GroupManagement:1", path: "/GroupManagement" },
  AudioIn: { type: "urn:schemas-upnp-org:service:AudioIn:1", path: "/AudioIn" },
} as const;

export type ServiceName = keyof typeof SERVICES;
export type SoapArgs = Record<string, string | number | boolean>;
export type SoapResult = Record<string, string>;

export const PORT = 1400;
const TIMEOUT_MS = 5000;

// Error codes from the UPnP device architecture and the AVTransport spec.
const UPNP_ERRORS: Record<string, string> = {
  "400": "Bad Request",
  "401": "Invalid Action",
  "402": "Invalid Args",
  "404": "Invalid Var",
  "501": "Action Failed",
  "600": "Argument Value Invalid",
  "601": "Argument Value Out of Range",
  "602": "Optional Action Not Implemented",
  "606": "Action Not Authorized",
  "701": "Transition not available",
  "702": "No contents",
  "705": "Transport is locked",
  "711": "Illegal seek target",
  "712": "Play mode not supported",
  "714": "Illegal MIME-type",
  "718": "Invalid InstanceID",
  "800": "Command not allowed on this speaker (not group coordinator?)",
};

export class SonosError extends Error {}

let dryRun = false;

/** In dry-run mode, state-changing actions are printed but not sent. */
export function setDryRun(value: boolean) {
  dryRun = value;
}

export function isDryRun() {
  return dryRun;
}

// Actions that only read state. SnapshotGroupVolume stores the volume ratio
// of the group members before a group volume read and changes nothing audible.
const READ_ONLY_ACTION = /^(Get|List|Browse|Search|SnapshotGroupVolume$)/;

export function buildEnvelope(service: ServiceName, action: string, args: SoapArgs): string {
  const body = Object.entries(args)
    .map(([name, value]) => {
      const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      return `<${name}>${escapeXml(v)}</${name}>`;
    })
    .join("");
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${SERVICES[service].type}">${body}</u:${action}></s:Body></s:Envelope>`
  );
}

/**
 * Sends one UPnP action to a speaker. Argument order must match the order in
 * the service description (SCPD), so pass `args` in that order.
 */
export async function soap(
  ip: string,
  service: ServiceName,
  action: string,
  args: SoapArgs = {},
  timeoutMs = TIMEOUT_MS,
): Promise<SoapResult> {
  if (dryRun && !READ_ONLY_ACTION.test(action)) {
    console.error(`[dry-run] ${ip} ${service}.${action} ${JSON.stringify(args)}`);
    return {};
  }
  const def = SERVICES[service];
  let response: Response;
  try {
    response = await fetch(`http://${ip}:${PORT}${def.path}/Control`, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${def.type}#${action}"`,
      },
      body: buildEnvelope(service, action, args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SonosError(`${ip}: ${service}.${action} failed: ${(err as Error).message}`);
  }
  const body = await response.text();
  if (response.status === 200) {
    const result = parseXml(body)?.Envelope?.Body?.[`${action}Response`];
    return toStrings(result);
  }
  if (response.status === 500) {
    const detail = parseXml(body)?.Envelope?.Body?.Fault?.detail?.UPnPError ?? {};
    const code = String(detail.errorCode ?? "?");
    const description = detail.errorDescription || UPNP_ERRORS[code] || "Unknown error";
    throw new SonosError(`${service}.${action} failed: UPnP error ${code} (${description})`);
  }
  throw new SonosError(`${service}.${action} failed: HTTP ${response.status}`);
}

function toStrings(node: XmlNode | string | undefined): SoapResult {
  if (!node || typeof node !== "object") return {};
  const out: SoapResult = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@")) continue;
    out[key] = typeof value === "string" ? value : "";
  }
  return out;
}

export async function fetchText(ip: string, path: string): Promise<string> {
  const response = await fetch(`http://${ip}:${PORT}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new SonosError(`GET ${path} failed: HTTP ${response.status}`);
  return response.text();
}
