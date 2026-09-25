import type { Group, Member, Topology } from "./discovery.ts";
import { SonosError, fetchText, isDryRun, soap, type SoapArgs, type SoapResult } from "./soap.ts";
import { wsRequest } from "./ws.ts";
import { escapeXml, parseDidl, parseXml, text, type DidlObject } from "./xml.ts";

// [shuffle, repeat], as SoCo PLAY_MODES.
export const PLAY_MODES = {
  NORMAL: [false, "off"],
  SHUFFLE_NOREPEAT: [true, "off"],
  SHUFFLE: [true, "all"],
  REPEAT_ALL: [false, "all"],
  SHUFFLE_REPEAT_ONE: [true, "one"],
  REPEAT_ONE: [false, "one"],
} as const;
export type PlayMode = keyof typeof PLAY_MODES;
export type Repeat = "off" | "all" | "one";

// As SoCo SOURCES.
const SOURCES: [RegExp, string][] = [
  [/^$/, "NONE"],
  [/^x-file-cifs:/, "LIBRARY"],
  [/^x-rincon-mp3radio:/, "RADIO"],
  [/^x-sonosapi-(stream|radio|hls):/, "RADIO"],
  [/^x-sonos-http:sonos/, "RADIO"],
  [/^(aac|hls-radio):/, "RADIO"],
  [/^https?:/, "WEB_FILE"],
  [/^x-rincon-stream:/, "LINE_IN"],
  [/^x-sonos-htastream:/, "TV"],
  [/^x-sonos-vli:.*,airplay:/, "AIRPLAY"],
  [/^x-sonos-vli:.*,spotify:/, "SPOTIFY_CONNECT"],
  [/^x-rincon-queue:/, "QUEUE"],
  [/^x-rincon:/, "GROUP_MEMBER"],
];

export function musicSource(uri: string): string {
  return SOURCES.find(([re]) => re.test(uri))?.[1] ?? "UNKNOWN";
}

export interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  station: string;
  position: string;
  duration: string;
  queuePosition: number;
  uri: string;
  source: string;
  albumArt: string;
}

export interface Alarm {
  id: string;
  startTime: string;
  duration: string;
  recurrence: string;
  enabled: boolean;
  room: string;
  volume: number;
  playMode: string;
  programUri: string;
}

export function parseTime(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) throw new SonosError(`Invalid time: ${value}`);
  return parts.reduce((total, p) => total * 60 + p, 0);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const onOff = (value: boolean) => (value ? "On" : "Off");

// Only the group coordinator accepts transport, queue and group volume commands.
export class Speaker {
  constructor(
    readonly member: Member,
    readonly group: Group,
    readonly topology: Topology,
  ) {}

  get name() {
    return this.member.name;
  }
  get ip() {
    return this.member.ip;
  }
  get uuid() {
    return this.member.uuid;
  }
  get coordinator() {
    return this.group.coordinator;
  }
  get isCoordinator() {
    return this.coordinator.uuid === this.uuid;
  }

  private av(action: string, args: SoapArgs = {}): Promise<SoapResult> {
    return soap(this.coordinator.ip, "AVTransport", action, { InstanceID: 0, ...args });
  }

  private rc(action: string, args: SoapArgs = {}): Promise<SoapResult> {
    return soap(this.ip, "RenderingControl", action, { InstanceID: 0, ...args });
  }

  private grc(action: string, args: SoapArgs = {}): Promise<SoapResult> {
    return soap(this.coordinator.ip, "GroupRenderingControl", action, { InstanceID: 0, ...args });
  }

  async transportState(): Promise<string> {
    return (await this.av("GetTransportInfo")).CurrentTransportState ?? "UNKNOWN";
  }

  async play() {
    await this.av("Play", { Speed: 1 });
  }
  async pause() {
    await this.av("Pause");
  }
  async stop() {
    await this.av("Stop");
  }
  async next() {
    await this.av("Next");
  }
  async previous() {
    await this.av("Previous");
  }

  async toggle(): Promise<"play" | "pause"> {
    if ((await this.transportState()) === "PLAYING") {
      await this.pause();
      return "pause";
    }
    await this.play();
    return "play";
  }

  /** "1:30", "90", "+30", "-15" or "50%". */
  async seek(target: string) {
    let seconds: number;
    if (/^[+-]\d+$/.test(target)) {
      const { RelTime } = await this.av("GetPositionInfo");
      seconds = parseTime(RelTime ?? "0") + Number(target);
    } else if (/^\d+(\.\d+)?%$/.test(target)) {
      const duration = valid((await this.av("GetPositionInfo")).TrackDuration);
      if (!duration) throw new SonosError("The current track has no known length");
      seconds = (parseTime(duration) * Math.min(100, parseFloat(target))) / 100;
    } else {
      seconds = parseTime(target);
    }
    await this.av("Seek", { Unit: "REL_TIME", Target: formatTime(seconds) });
  }

  /** `position` is 1-based. */
  async seekTrack(position: number) {
    await this.av("Seek", { Unit: "TRACK_NR", Target: position });
  }

  async mediaInfo(): Promise<{ uri: string; metadata: string }> {
    const media = await this.av("GetMediaInfo");
    return { uri: media.CurrentURI ?? "", metadata: media.CurrentURIMetaData ?? "" };
  }

  async setSource(uri: string, metadata = "") {
    await this.av("SetAVTransportURI", { CurrentURI: uri, CurrentURIMetaData: metadata });
  }

  async currentTrack(): Promise<TrackInfo> {
    const pos = await this.av("GetPositionInfo");
    const meta = parseDidl(pos.TrackMetaData ?? "")[0];
    const uri = pos.TrackURI ?? "";
    const info: TrackInfo = {
      title: meta?.title ?? "",
      artist: meta?.creator ?? "",
      album: meta?.album ?? "",
      station: "",
      position: valid(pos.RelTime),
      duration: valid(pos.TrackDuration),
      queuePosition: Number(pos.Track ?? 0),
      uri,
      source: musicSource(uri),
      albumArt: meta?.albumArt ? absoluteUrl(meta.albumArt, this.coordinator.ip) : "",
    };
    // Radio: "Artist - Title" is in streamContent, the station in the media metadata.
    const media = await this.av("GetMediaInfo");
    const mediaMeta = parseDidl(media.CurrentURIMetaData ?? "")[0];
    if (mediaMeta?.upnpClass.startsWith("object.item.audioItem.musicTrack")) {
      // Without ID3 tags, Sonos titles a file with its URL file name.
      if (mediaMeta.title && info.title === fileNameOf(uri)) info.title = mediaMeta.title;
    } else if (mediaMeta?.title && mediaMeta.title !== info.title) {
      info.station = mediaMeta.title;
    }
    if (meta?.streamContent) {
      const [artist, ...rest] = meta.streamContent.split(" - ");
      if (rest.length > 0) {
        info.artist = artist!;
        info.title = rest.join(" - ");
      } else {
        info.title = meta.streamContent;
      }
    }
    return info;
  }

  async volume(): Promise<number> {
    return Number((await this.rc("GetVolume", { Channel: "Master" })).CurrentVolume);
  }
  async setVolume(volume: number) {
    await this.rc("SetVolume", { Channel: "Master", DesiredVolume: clamp(volume, 0, 100) });
  }
  async changeVolume(delta: number): Promise<number> {
    return Number((await this.rc("SetRelativeVolume", { Channel: "Master", Adjustment: delta })).NewVolume);
  }
  /** Returns the ramp time in seconds. */
  async rampVolume(volume: number): Promise<number> {
    const result = await this.rc("RampToVolume", {
      Channel: "Master",
      RampType: "SLEEP_TIMER_RAMP_TYPE",
      DesiredVolume: clamp(volume, 0, 100),
      ResetVolumeAfter: false,
      ProgramURI: "",
    });
    return Number(result.RampTime ?? 0);
  }
  async muted(): Promise<boolean> {
    return (await this.rc("GetMute", { Channel: "Master" })).CurrentMute === "1";
  }
  async setMuted(muted: boolean) {
    await this.rc("SetMute", { Channel: "Master", DesiredMute: muted });
  }

  // Group volume is relative to the member volumes, so snapshot the ratios first.
  async groupVolume(): Promise<number> {
    await this.grc("SnapshotGroupVolume");
    return Number((await this.grc("GetGroupVolume")).CurrentVolume);
  }
  async setGroupVolume(volume: number) {
    await this.grc("SnapshotGroupVolume");
    await this.grc("SetGroupVolume", { DesiredVolume: clamp(volume, 0, 100) });
  }
  async changeGroupVolume(delta: number): Promise<number> {
    await this.grc("SnapshotGroupVolume");
    return Number((await this.grc("SetRelativeGroupVolume", { Adjustment: delta })).NewVolume);
  }
  async groupMuted(): Promise<boolean> {
    return (await this.grc("GetGroupMute")).CurrentMute === "1";
  }
  async setGroupMuted(muted: boolean) {
    await this.grc("SetGroupMute", { DesiredMute: muted });
  }

  async bass(): Promise<number> {
    return Number((await this.rc("GetBass")).CurrentBass);
  }
  async setBass(value: number) {
    await this.rc("SetBass", { DesiredBass: clamp(value, -10, 10) });
  }
  async treble(): Promise<number> {
    return Number((await this.rc("GetTreble")).CurrentTreble);
  }
  async setTreble(value: number) {
    await this.rc("SetTreble", { DesiredTreble: clamp(value, -10, 10) });
  }
  async loudness(): Promise<boolean> {
    return (await this.rc("GetLoudness", { Channel: "Master" })).CurrentLoudness === "1";
  }
  async setLoudness(value: boolean) {
    await this.rc("SetLoudness", { Channel: "Master", DesiredLoudness: value });
  }

  /** Soundbars only: "NightMode", "DialogLevel", "SubGain", ... */
  async eq(type: string): Promise<string> {
    return (await this.rc("GetEQ", { EQType: type })).CurrentValue ?? "";
  }
  async setEq(type: string, value: string | number) {
    await this.rc("SetEQ", { EQType: type, DesiredValue: value });
  }

  async playMode(): Promise<PlayMode> {
    return (await this.av("GetTransportSettings")).PlayMode as PlayMode;
  }
  async setPlayMode(mode: PlayMode) {
    await this.av("SetPlayMode", { NewPlayMode: mode });
  }
  async setShuffleRepeat(change: { shuffle?: boolean; repeat?: Repeat }) {
    const [shuffle, repeat] = PLAY_MODES[await this.playMode()] ?? PLAY_MODES.NORMAL;
    const wanted: readonly [boolean, Repeat] = [change.shuffle ?? shuffle, change.repeat ?? repeat];
    const mode = (Object.keys(PLAY_MODES) as PlayMode[]).find(
      (m) => PLAY_MODES[m][0] === wanted[0] && PLAY_MODES[m][1] === wanted[1],
    )!;
    await this.setPlayMode(mode);
    return mode;
  }
  async crossfade(): Promise<boolean> {
    return (await this.av("GetCrossfadeMode")).CrossfadeMode === "1";
  }
  async setCrossfade(value: boolean) {
    await this.av("SetCrossfadeMode", { CrossfadeMode: value });
  }

  async sleepTimer(): Promise<number | null> {
    const { RemainingSleepTimerDuration: remaining } = await this.av("GetRemainingSleepTimerDuration");
    return remaining ? parseTime(remaining) : null;
  }
  /** `null` cancels the timer. */
  async setSleepTimer(seconds: number | null) {
    if (seconds !== null && (seconds < 0 || seconds > 86399)) throw new SonosError("Sleep time must be 0..86399 seconds");
    const value = seconds === null ? "" : formatTime(seconds).padStart(8, "0");
    await this.av("ConfigureSleepTimer", { NewSleepTimerDuration: value });
  }

  private async browse(objectId: string, start = 0, count = 1000): Promise<{ items: DidlObject[]; total: number }> {
    const result = await soap(this.coordinator.ip, "ContentDirectory", "Browse", {
      ObjectID: objectId,
      BrowseFlag: "BrowseDirectChildren",
      Filter: "*",
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: "",
    });
    return { items: parseDidl(result.Result ?? ""), total: Number(result.TotalMatches ?? 0) };
  }

  private async browseAll(objectId: string): Promise<DidlObject[]> {
    const items: DidlObject[] = [];
    for (;;) {
      const page = await this.browse(objectId, items.length);
      items.push(...page.items);
      if (page.items.length === 0 || items.length >= page.total) return items;
    }
  }

  queue() {
    return this.browseAll("Q:0");
  }
  async clearQueue() {
    await this.av("RemoveAllTracksFromQueue");
  }
  /** `position` is 1-based. */
  async removeFromQueue(position: number) {
    await this.av("RemoveTrackFromQueue", { ObjectID: `Q:0/${position}`, UpdateID: 0 });
  }
  /** `position` is 1-based. */
  async playFromQueue(position: number) {
    await this.setSource(`x-rincon-queue:${this.coordinator.uuid}#0`);
    await this.seekTrack(position);
    await this.play();
  }
  /** `position` 0 appends. Returns the queue position. */
  async addToQueue(uri: string, metadata = "", position = 0, asNext = false): Promise<number> {
    const result = await this.av("AddURIToQueue", {
      EnqueuedURI: uri,
      EnqueuedURIMetaData: metadata,
      DesiredFirstTrackNumberEnqueued: position,
      EnqueueAsNext: asNext,
    });
    return Number(result.FirstTrackNumberEnqueued ?? 0);
  }

  favorites() {
    return this.browseAll("FV:2");
  }
  playlists() {
    return this.browseAll("SQ:");
  }

  // loadFavorite handles every favorite type. UPnP is the fallback for firmware without the local API.
  async playFavorite(favorite: DidlObject) {
    const favoriteId = favorite.id.replace(/^FV:2\//, "");
    if (isDryRun()) {
      console.error(`[dry-run] ${this.coordinator.ip} favorites:1.loadFavorite ${favoriteId} (${favorite.title})`);
      return;
    }
    try {
      await wsRequest(
        this.coordinator.ip,
        { namespace: "favorites:1", command: "loadFavorite", groupId: this.group.id },
        { favoriteId, playOnCompletion: true },
      );
      return;
    } catch (err) {
      // Shortcuts (Sonos Radio) have no URI and are missing from the local API.
      if (!favorite.uri) {
        throw new SonosError(`"${favorite.title}" is a Sonos app shortcut without a URI and cannot play locally (${(err as Error).message})`);
      }
    }
    const isContainer = favorite.uri.startsWith("x-rincon-cpcontainer:") || /<upnp:class>object\.container/.test(favorite.resMD);
    if (isContainer) {
      const position = await this.addToQueue(favorite.uri, favorite.resMD, 0, true);
      await this.playFromQueue(position);
    } else {
      await this.playUri(favorite.uri, { metadata: favorite.resMD });
    }
  }

  // Radio streams play only with metadata, so a title turns the URI into a station.
  async playUri(uri: string, options: { title?: string; metadata?: string; radio?: boolean } = {}) {
    let metadata = options.metadata ?? "";
    if (!metadata && options.title) metadata = radioMetadata(options.title);
    if (options.radio) uri = uri.replace(/^[^:]+:/, "x-rincon-mp3radio:");
    await this.av("SetAVTransportURI", { CurrentURI: uri, CurrentURIMetaData: metadata });
    await this.play();
  }

  async lineIn(source: Speaker = this) {
    await this.av("SetAVTransportURI", { CurrentURI: `x-rincon-stream:${source.uuid}`, CurrentURIMetaData: "" });
    await this.play();
  }

  async tv() {
    await soap(this.ip, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: `x-sonos-htastream:${this.uuid}:spdif`,
      CurrentURIMetaData: "",
    });
  }

  async join(target: Speaker) {
    await soap(this.ip, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: `x-rincon:${target.coordinator.uuid}`,
      CurrentURIMetaData: "",
    });
  }

  async leave() {
    await soap(this.ip, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
  }

  async statusLight(): Promise<boolean> {
    return (await soap(this.ip, "DeviceProperties", "GetLEDState")).CurrentLEDState === "On";
  }
  async setStatusLight(on: boolean) {
    await soap(this.ip, "DeviceProperties", "SetLEDState", { DesiredLEDState: onOff(on) });
  }
  async buttonsEnabled(): Promise<boolean> {
    return (await soap(this.ip, "DeviceProperties", "GetButtonLockState")).CurrentButtonLockState === "Off";
  }
  async setButtonsEnabled(enabled: boolean) {
    await soap(this.ip, "DeviceProperties", "SetButtonLockState", { DesiredButtonLockState: onOff(!enabled) });
  }

  async info(): Promise<Record<string, string>> {
    const device = parseXml(await fetchText(this.ip, "/xml/device_description.xml")).root?.device ?? {};
    return {
      name: this.name,
      ip: this.ip,
      uuid: this.uuid,
      model: text(device.modelName),
      modelNumber: text(device.modelNumber),
      displayName: text(device.displayName),
      softwareVersion: text(device.softwareVersion),
      hardwareVersion: text(device.hardwareVersion),
      serialNumber: text(device.serialNum),
      macAddress: text(device.MACAddress),
      group: groupName(this.group),
      coordinator: this.coordinator.name,
    };
  }

  async alarms(): Promise<Alarm[]> {
    const { CurrentAlarmList } = await soap(this.ip, "AlarmClock", "ListAlarms");
    const alarms = parseXml(CurrentAlarmList ?? "").Alarms?.Alarm ?? [];
    return alarms.map((a: Record<string, string>) => ({
      id: a["@ID"],
      startTime: a["@StartTime"],
      duration: a["@Duration"],
      recurrence: a["@Recurrence"],
      enabled: a["@Enabled"] === "1",
      room: this.topology.members.find((m) => m.uuid === a["@RoomUUID"])?.name ?? a["@RoomUUID"],
      volume: Number(a["@Volume"]),
      playMode: a["@PlayMode"],
      programUri: a["@ProgramURI"],
    }));
  }
}

export function groupName(group: Group): string {
  const others = group.members.filter((m) => m.uuid !== group.coordinator.uuid).map((m) => m.name);
  return [group.coordinator.name, ...others].join(" + ");
}

// From SoCo play_uri(). The TuneIn service descriptor makes Sonos show radio controls.
function radioMetadata(title: string): string {
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="R:0/0/0" parentID="R:0/0" restricted="true"><dc:title>${escapeXml(title)}</dc:title>` +
    "<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>" +
    '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>'
  );
}

export function trackMetadata(title: string, uri: string, contentType: string): string {
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="-1" parentID="-1" restricted="true"><dc:title>${escapeXml(title)}</dc:title>` +
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
    `<res protocolInfo="http-get:*:${contentType}:*">${escapeXml(uri)}</res></item></DIDL-Lite>`
  );
}

function fileNameOf(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

function valid(value: string | undefined): string {
  return !value || value === "NOT_IMPLEMENTED" ? "" : value;
}

function absoluteUrl(url: string, ip: string): string {
  return url.startsWith("/") ? `http://${ip}:1400${url}` : url;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new SonosError(`Invalid number: ${value}`);
  return Math.min(max, Math.max(min, Math.round(value)));
}
