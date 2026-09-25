import { SonosError } from "./soap.ts";

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

export type WsMessage = [WsHeader & Record<string, unknown>, Record<string, any>];

export class SonosWebSocket {
  private nextId = 1;
  private pending = new Map<string, { resolve: (m: WsMessage) => void; reject: (e: Error) => void }>();
  private listeners: ((m: WsMessage) => void)[] = [];
  private household: string | undefined;

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => this.handle(JSON.parse(String(event.data)) as WsMessage);
    socket.onclose = () => {
      for (const p of this.pending.values()) p.reject(new SonosError("WebSocket closed"));
      this.pending.clear();
    };
  }

  static connect(ip: string): Promise<SonosWebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://${ip}:${WS_PORT}/websocket/api`, {
        headers: { "X-Sonos-Api-Key": API_KEY, "Sec-WebSocket-Protocol": PROTOCOL },
        tls: { rejectUnauthorized: false },
      } as any);
      const timer = setTimeout(() => {
        socket.close();
        reject(new SonosError(`${ip}: WebSocket connect timed out`));
      }, TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new SonosWebSocket(socket));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new SonosError(`${ip}: WebSocket connection failed (firmware without local Control API?)`));
      };
    });
  }

  request(header: WsHeader, body: Record<string, unknown> = {}): Promise<WsMessage> {
    const cmdId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new SonosError(`${header.namespace}.${header.command} timed out`));
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

  private handle(message: WsMessage) {
    const [header, body] = message;
    if (typeof header.householdId === "string") this.household ??= header.householdId;
    const cmdId = header.cmdId as string | undefined;
    const pending = cmdId ? this.pending.get(cmdId) : undefined;
    if (!pending) {
      for (const l of this.listeners) l(message);
      return;
    }
    this.pending.delete(cmdId!);
    if (header.success === false) {
      const reason = [body.errorCode ?? header.type, body.reason].filter(Boolean).join(": ");
      pending.reject(new SonosError(`${header.namespace}.${header.response} failed: ${reason}`));
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
