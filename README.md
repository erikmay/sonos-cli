| `src/snapshot.ts` | save and restore source, track, position and volumes (like SoCo `snapshot.py`) |
| `src/tts.ts` | text to speech with the macOS `say` command |
# sonos-cli

Control Sonos speakers in the local network from the command line. The tool
is a Bun/TypeScript port of the core logic of [SoCo](https://github.com/SoCo/SoCo),
with commands like [soco-cli](https://github.com/avantrec/soco-cli). It also
uses the local Sonos Control API (WebSocket) for favorites and live events.

No cloud account, no Python and no runtime dependencies are necessary.
XML parsing uses `Bun.XML` (Bun 1.4 or newer).

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for how the protocols work.

## Install

```sh
bun install
bun link            # installs the "sonos" command
# or build a single binary:
bun run build       # -> dist/sonos
```

## Usage

```sh
sonos speakers                    # find speakers (SSDP), refresh the cache
sonos status                      # all groups: state, track, volume
sonos kantine volume 20           # the first word can be a room name
sonos -s couch volume +5          # or use -s; names can be partial
sonos gv -3                       # group volume
sonos pause | play | toggle | next | prev
sonos seek 1:30 | seek +30
sonos favorites                   # list Sonos favorites
sonos fav "seeed radio"           # play a favorite (by name or number)
sonos play-uri https://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3 "Deutschlandfunk"
sonos play-file ~/Music/track.mp3    # serves the file over HTTP until it ends
sonos say "Mittagessen ist fertig" --voice Anna --volume 25   # announce, then resume
sonos interrupt ~/Music/jingle.mp3                   # insert a file, then resume
sonos snapshot save && ... && sonos snapshot restore  # manual save and restore
sonos seek 50%                    # also: seek 1:30, seek +30, seek -15
sonos queue | queue play 3 | queue clear
sonos sleep 30m | sleep off
sonos couch join kantine          # grouping
sonos couch leave
sonos party | ungroup-all
sonos watch                       # live track, state and volume changes
```

Run `sonos --help` for all commands.

Options: `--json` for JSON output, `--dry-run` to print changing requests
Unknown options and extra arguments are errors (exit code 2), so a typo
such as `--dryrun` never sends a change.
without sending them, `--refresh` to ignore the discovery cache.

Environment: `SONOS_SPEAKER` sets the default room, `SONOS_HOST` sets the IP
of one speaker (for networks without multicast).

Without a room, commands use `SONOS_SPEAKER` or the coordinator of the only
group. Transport and queue commands always go to the group coordinator.

## Exploration commands

```sh
sonos actions                     # UPnP services
sonos actions RenderingControl    # actions of a service (from the SCPD)
sonos raw AVTransport GetPositionInfo InstanceID=0
sonos ws playback getPlaybackStatus
sonos ws favorites getFavorites --household
```

## Layout

| File | Content |
| --- | --- |
| `src/soap.ts` | UPnP services, SOAP envelope, error codes, dry-run |
| `src/discovery.ts` | SSDP, network scan fallback, zone group topology, IP cache |
| `src/speaker.ts` | speaker logic from SoCo `core.py` (transport, volume, EQ, queue, favorites, groups) |
| `src/ws.ts` | client for the local Control API on port 1443 |
| `src/fileserver.ts` | HTTP server for `play-file` (speaker IPs only, random path) |
| `src/xml.ts` | XML parsing (Bun.XML, normalized) and DIDL-Lite |
| `src/cli.ts` | command-line interface |

## Not ported

Music library search, music service browsing (SMAPI), playlist editing,
alarm editing, stereo pairs and home theater setup, playlists of local
files (m3u, directories), and GENA event subscriptions (replaced by `watch`).
Use `sonos raw` for UPnP actions without a command.
