# How Sonos speakers are controlled

This document records what SoCo and soco-cli do and what we found on real
speakers (Play:1, firmware 86.10, S2). It also shows how to explore the
protocols with this tool.

## Summary

Sonos does not use one secret protocol. A speaker offers three local
interfaces:

| Interface | Port | Format | Used by |
| --- | --- | --- | --- |
| SSDP discovery | UDP 1900 (multicast 239.255.255.250) | HTTP-like text | SoCo, this tool |
| UPnP control (SOAP) | TCP 1400 (HTTP) | XML | SoCo, soco-cli, this tool (main path) |
| UPnP events (GENA) | TCP 1400, callback server | XML | SoCo events, soco-cli `track_follow` |
| Local Control API | TCP 1443 (WSS) | JSON | Sonos app, Home Assistant, this tool (`ws`, `watch`, favorites) |

SoCo uses only SSDP and UPnP. soco-cli is a command-line layer on top of
SoCo and adds no protocol of its own.

## 1. Discovery (SSDP)

The client sends an `M-SEARCH` to `239.255.255.250:1900` with
`ST: urn:schemas-upnp-org:device:ZonePlayer:1`. Each speaker answers with
a unicast response. Relevant headers:

```
LOCATION: http://192.168.1.41:1400/xml/device_description.xml
SERVER: Linux UPnP/1.0 Sonos/86.10-80260 (ZPS12)
USN: uuid:RINCON_000E58AAAAAA01400::urn:schemas-upnp-org:device:ZonePlayer:1
X-RINCON-HOUSEHOLD: Sonos_AbCdEfGhIjKlMnOpQrStUvWxYz01
HOUSEHOLD.SMARTSPEAKER.AUDIO: Sonos_AbCd...XyZ0000000000000000   <- householdId for the Control API
```

The UUID (`RINCON_<MAC>01400`) identifies the speaker in all later calls.

One speaker is enough: `ZoneGroupTopology.GetZoneGroupState` on any
speaker returns all groups, members, names and IPs of the household. This
tool caches the known IPs in `~/.cache/sonos-cli/hosts.json`, so most
commands need one SOAP call instead of an SSDP search.

If multicast does not work (VPN, guest Wi-Fi), SoCo `scan_network()` probes
port 1400 on every host of the local network. `discovery.ts` does the same
as a fallback.

## 2. Control (UPnP SOAP on port 1400)

`/xml/device_description.xml` lists the services. Each service has an
SCPD file (`/xml/<Service>1.xml`) with its actions and arguments.

| Service | Control URL | Purpose |
| --- | --- | --- |
| AVTransport | /MediaRenderer/AVTransport/Control | play, pause, seek, URIs, queue changes, play mode, sleep timer, grouping |
| RenderingControl | /MediaRenderer/RenderingControl/Control | volume, mute, bass, treble, loudness, EQ (night mode etc.) |
| GroupRenderingControl | /MediaRenderer/GroupRenderingControl/Control | group volume and mute |
| ContentDirectory | /MediaServer/ContentDirectory/Control | browse queue (`Q:0`), favorites (`FV:2`), playlists (`SQ:`), library (`A:`) |
| ZoneGroupTopology | /ZoneGroupTopology/Control | groups and members |
| DeviceProperties | /DeviceProperties/Control | LED, button lock, room name, stereo pairs |
| AlarmClock | /AlarmClock/Control | alarms |
| Queue | /MediaRenderer/Queue/Control | Sonos queue service (namespace `urn:schemas-sonos-com`) |

A request is a HTTP POST:

```http
POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Content-Type: text/xml; charset="utf-8"
SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"

<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID><Channel>Master</Channel>
    </u:GetVolume>
  </s:Body>
</s:Envelope>
```

The response contains `<u:GetVolumeResponse><CurrentVolume>15</CurrentVolume>`.
Errors come back as HTTP 500 with a SOAP fault that holds a UPnP error code
(for example 401 Invalid Action, 402 Invalid Args, 701 Transition not
available, 800 not the coordinator).

Arguments must be in the order of the SCPD. `InstanceID` is always 0.

Some values are XML documents inside a string. They are escaped once more:
`ZoneGroupState`, `TrackMetaData`, `CurrentURIMetaData`, the `Result` of
`Browse`. Metadata uses DIDL-Lite (from UPnP AV).

### Group rules

- A group has one coordinator. Only the coordinator accepts transport,
  queue and group volume commands. Members play `x-rincon:<coordinator UUID>`.
- Join: send `SetAVTransportURI(CurrentURI="x-rincon:<coordinator UUID>")`
  to the new member.
- Leave: send `BecomeCoordinatorOfStandaloneGroup` to the member.
- Volume and EQ belong to each speaker. The group volume is relative:
  call `SnapshotGroupVolume` before `GetGroupVolume` / `SetGroupVolume`.

### URI schemes (from SoCo)

| Prefix | Meaning |
| --- | --- |
| `x-rincon-queue:<UUID>#0` | the queue of the coordinator |
| `x-rincon:<UUID>` | follow another speaker (group member) |
| `x-rincon-stream:<UUID>` | line-in of a speaker |
| `x-sonos-htastream:<UUID>:spdif` | TV input of a soundbar |
| `x-rincon-mp3radio:`, `x-sonosapi-stream:`, `x-sonosapi-radio:`, `x-sonosapi-hls:`, `aac:` | radio |
| `x-sonos-spotify:`, `x-sonosprog-spotify:` | Spotify track (sid=9) |
| `x-rincon-cpcontainer:` | music service container (playlist, album). Must go through the queue |
| `x-file-cifs:` | music library on a SMB share |
| `http(s):` | a file or stream on a web server |

### Play a URI

- Stream or track: `SetAVTransportURI(uri, metadata)`, then `Play`.
  Radio streams need DIDL metadata with a title, otherwise Sonos refuses them.
  SoCo builds that metadata with the TuneIn service descriptor `SA_RINCON65031_`.
- Container: `AddURIToQueue(uri, metadata)`, then
  `SetAVTransportURI(x-rincon-queue:<UUID>#0)`, `Seek(TRACK_NR, n)`, `Play`.

### Favorites

`Browse("FV:2")` returns the Sonos favorites. Each item has a `<res>` (URI)
and `<r:resMD>` (DIDL metadata of the target). Three kinds were found:

| Kind | Example | How to play |
| --- | --- | --- |
| `instantPlay` track | `x-sonos-spotify:spotify%3Atrack%3A...` | `SetAVTransportURI(res, resMD)` |
| `instantPlay` container | `x-rincon-cpcontainer:1006206cspotify%3Aplaylist%3A...` | through the queue |
| `shortcut` | Sonos Radio "Diese Musik ist gerade" (empty `<res>`) | not playable locally |

## 3. Events (UPnP GENA)

SoCo sends `SUBSCRIBE /MediaRenderer/AVTransport/Event` with a `CALLBACK`
header. The speaker then sends `NOTIFY` requests with `LastChange` XML to a
local HTTP server. This needs an open port on the client.

This tool uses the WebSocket subscriptions of the Control API for `watch`
instead. They need no callback server.

## 4. Local Control API (WebSocket on port 1443)

S2 firmware also runs the Sonos Control API locally. It is the same API as
the documented cloud API (https://docs.sonos.com/docs/control), but without
OAuth. SoCo does not use it.

- URL: `wss://<ip>:1443/websocket/api` (self-signed certificate)
- Headers: `X-Sonos-Api-Key: 123e4567-e89b-12d3-a456-426655440000` (the
  public key that the Sonos app and Home Assistant send) and
  `Sec-WebSocket-Protocol: v1.api.smartspeaker.audio`
- Message: JSON array `[header, body]`. The header has `namespace`,
  `command`, one target ID (`householdId`, `groupId` or `playerId`) and an
  optional `cmdId` that the response repeats.

```json
[{"namespace":"groupVolume:1","command":"getVolume","groupId":"RINCON_000E58BBBBBB01400:29934888","cmdId":"1"},{}]
-> [{"namespace":"groupVolume:1","response":"getVolume","success":true,"type":"groupVolume","cmdId":"1",...},
    {"_objectType":"groupVolume","volume":15,"muted":false,"fixed":false}]
```

Findings:

- `householdId` is required for household commands (`groups:1 getGroups`,
  `favorites:1 getFavorites`). Every response header contains it, also error
  responses (`ERROR_MISSING_PARAMETERS`).
- Group commands must go to the coordinator. A member answers with
  `groupCoordinatorChanged` and the coordinator's `websocketUrl`.
- Player commands (`playerVolume:1`) must go to the player itself.
  Otherwise the answer is `ERROR_INVALID_OBJECT_ID`.
- `favorites:1 loadFavorite {favoriteId, playOnCompletion}` plays a
  favorite of any type. The IDs match the `FV:2/<id>` IDs of UPnP. Shortcut
  favorites are not in the list.
- `subscribe` on `playbackMetadata:1`, `playback:1`, `groupVolume:1`,
  `groups:1` sends events on the same socket.
- `audioClip:1` (capability `AUDIO_CLIP`) plays notification sounds over
  the music.

Useful namespaces: `groups:1`, `playback:1`, `playbackMetadata:1`,
`groupVolume:1`, `playerVolume:1`, `favorites:1`, `playlists:1`,
`audioClip:1`, `homeTheater:1`, `settings:1`.

## How to explore

All read commands are safe. Use `--dry-run` to see which requests a
changing command would send.

```sh
sonos speakers                           # SSDP + topology
sonos actions                            # UPnP services of a speaker
sonos actions AVTransport                # actions and arguments from the SCPD
sonos raw AVTransport GetMediaInfo InstanceID=0 --json
sonos raw ContentDirectory Browse ObjectID=FV:2 BrowseFlag=BrowseDirectChildren Filter='*' StartingIndex=0 RequestedCount=100 SortCriteria=
sonos ws playback getPlaybackStatus      # Control API, group target
sonos ws favorites getFavorites --household
sonos couch ws playerVolume getVolume --player
sonos watch                              # live events
sonos pause --dry-run                    # show the SOAP call, do not send it
```

Other sources:

- The SCPD files on the speaker: `http://<ip>:1400/xml/AVTransport1.xml` etc.
- Diagnostic pages: `http://<ip>:1400/support/review`, `http://<ip>:1400/status`.
- Network capture of the Sonos app (Wireshark filter `tcp.port == 1400`)
  shows the SOAP calls. Port 1443 is TLS; the app traffic there is encrypted.
- SoCo source: `soco/core.py` (speaker logic), `soco/services.py` (SOAP),
  `soco/discovery.py`, `soco/zonegroupstate.py`, `soco/data_structures.py` (DIDL).
