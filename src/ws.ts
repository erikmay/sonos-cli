import { SonosError } from "./soap.ts";
import { isRecord } from "./validation.ts";

// Local copy of the cloud Control API (https://docs.sonos.com/docs/control), S2 firmware only.
// The speaker only checks that the key header exists. Its certificate comes from a private Sonos CA.
const API_KEY = "123e4567-e89b-12d3-a456-426655440000";
const PROTOCOL = "v1.api.smartspeaker.audio";
const WS_PORT = 1443;
const TIMEOUT_MS = 5000;

export interface WsHeader {
  namespace: string;
  command?: string;
  householdId?: string;
  groupId?: string;
  playerId?: string;
  [key: string]: unknown;
}

export type WsMessage = [WsHeader, Record<string, unknown>];

/** No request reached the speaker. */
export class WsConnectionError extends SonosError {}
/** The speaker answered that the command failed, so nothing changed. */
export class WsRejectedError extends SonosError {}
/** The command can have reached the speaker, so a retry can apply it twice. */
export class WsUnknownOutcomeError extends SonosError {}

function parseMessage(data: string): WsMessage | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (Array.isArray(value) && value.length === 2 && isRecord(value[0]) && isRecord(value[1])) return value as WsMessage;
  } catch {}
  return undefined;
}

export class SonosWebSocket {
  private nextId = 1;
  private pending = new Map<string, { resolve: (m: WsMessage) => void; reject: (e: Error) => void }>();
  private listeners: ((m: WsMessage) => void)[] = [];
  private household: string | undefined;
  private closing = Promise.withResolvers<void>();
  /** Resolves when the socket closes, for any reason. */
  readonly closed = this.closing.promise;

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = parseMessage(String(event.data));
      if (message) return this.handle(message);
      this.failPending(new WsUnknownOutcomeError("Invalid WebSocket message: expected [header, body]"));
      socket.close();
    };
    socket.onclose = () => {
      this.failPending(new WsUnknownOutcomeError("WebSocket closed; request outcome is unknown"));
      this.closing.resolve();
    };
    socket.onerror = () => socket.close();
  }

  static connect(ip: string): Promise<SonosWebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://${ip}:${WS_PORT}/websocket/api`, {
        protocols: [PROTOCOL],
        headers: { "X-Sonos-Api-Key": API_KEY },
        tls: { rejectUnauthorized: false },
      });
      const fail = (reason: string) => {
        clearTimeout(timer);
        socket.onclose = null;
        socket.onerror = null;
        socket.terminate();
        reject(new WsConnectionError(`${ip}: ${reason}`));
      };
      const timer = setTimeout(() => fail("WebSocket connect timed out"), TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new SonosWebSocket(socket));
      };
      socket.onerror = () => fail("WebSocket connection failed (firmware without local Control API?)");
      socket.onclose = () => fail("WebSocket closed before connecting");
    });
  }

  request(header: WsHeader, body: Record<string, unknown> = {}): Promise<WsMessage> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new WsConnectionError("WebSocket is not open"));
    const cmdId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new WsUnknownOutcomeError(`${header.namespace}.${header.command} timed out; request outcome is unknown`));
      }, TIMEOUT_MS);
      this.pending.set(cmdId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.send(JSON.stringify([{ ...header, cmdId }, body]));
    });
  }

  // Every response header carries the householdId, error responses too.
  async householdId(): Promise<string> {
    if (!this.household) await this.request({ namespace: "groups:1", command: "getGroups" }).catch(() => {});
    if (!this.household) throw new SonosError("Speaker did not return a householdId");
    return this.household;
  }

  onEvent(listener: (m: WsMessage) => void) {
    this.listeners.push(listener);
  }

  close() {
    this.socket.close();
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handle(message: WsMessage) {
    const [header, body] = message;
    if (typeof header.householdId === "string") this.household ??= header.householdId;
    const cmdId = typeof header.cmdId === "string" ? header.cmdId : undefined;
    const pending = cmdId ? this.pending.get(cmdId) : undefined;
    if (!pending) {
      for (const l of this.listeners) l(message);
      return;
    }
    this.pending.delete(cmdId!);
    if (header.success === false) {
      const reason = [body.errorCode ?? header.type, body.reason].filter((value) => typeof value === "string").join(": ");
      pending.reject(new WsRejectedError(`${header.namespace}.${header.response} failed: ${reason}`));
    } else {
      pending.resolve(message);
    }
  }
}

export async function wsRequest(ip: string, header: WsHeader, body: Record<string, unknown> = {}): Promise<WsMessage> {
  const ws = await SonosWebSocket.connect(ip);
  try {
    return await ws.request(header, body);
  } finally {
    ws.close();
  }
}
