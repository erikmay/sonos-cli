import { SonosError } from "./soap.ts";
import { trapInterrupt } from "./interrupt.ts";
import { Speaker, groupName } from "./speaker.ts";
import { SonosWebSocket } from "./ws.ts";
import { isRecord } from "./validation.ts";

export async function watch(s: Speaker, json: boolean) {
  const ws = await SonosWebSocket.connect(s.coordinator.ip);
  using interrupt = trapInterrupt();
  const stopped = Promise.withResolvers<void>();
  interrupt.signal.addEventListener("abort", () => stopped.resolve());
  const stamp = () => new Date().toLocaleTimeString();
  ws.onEvent(([header, body]) => {
    if (header.type === "groupCoordinatorChanged") stopped.resolve();
    if (json) return console.log(JSON.stringify({ event: header.type, ...body }));
    switch (header.type) {
      case "metadataStatus": {
        const item = isRecord(body.currentItem) ? body.currentItem : {};
        const track = isRecord(item.track) ? item.track : {};
        const artist = isRecord(track.artist) && typeof track.artist.name === "string" ? track.artist.name : "";
        const title = typeof track.name === "string" ? track.name : typeof body.streamInfo === "string" ? body.streamInfo : "";
        const container = isRecord(body.container) && typeof body.container.name === "string" ? body.container.name : "";
        console.log(`${stamp()}  track   ${[artist, title].filter(Boolean).join(" - ")}${container ? `  (${container})` : ""}`);
        break;
      }
      case "playbackStatus":
        console.log(`${stamp()}  state   ${String(body.playbackState).replace("PLAYBACK_STATE_", "")}`);
        break;
      case "groupVolume":
        console.log(`${stamp()}  volume  ${body.volume}${body.muted ? " (muted)" : ""}`);
        break;
      case "groupCoordinatorChanged":
        console.log(`${stamp()}  group changed (${body.groupStatus}). Restart watch.`);
        break;
      default:
        console.log(`${stamp()}  ${header.type}`);
    }
  });
  try {
    if (!json) console.log(`Watching ${groupName(s.group)} ...`);
    await Promise.all(["playbackMetadata:1", "playback:1", "groupVolume:1"].map((namespace) =>
      ws.request({ namespace, command: "subscribe", groupId: s.group.id }),
    ));
    const lost = await Promise.race([ws.closed.then(() => true), stopped.promise.then(() => false)]);
    if (lost) throw new SonosError("The speaker closed the connection");
  } finally {
    ws.close();
  }
}
