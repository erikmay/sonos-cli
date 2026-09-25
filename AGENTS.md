# sonos-cli

Bun CLI for Sonos speakers in the local network, ported from SoCo.

## Live speakers

The office speakers are live: people listen to them all day. Every command
reaches real hardware.

- Verify a change with read commands (`status`, `track`, `raw … Get…`,
  `ws … get…`) and `--dry-run`.
- Change playback, volume or grouping only when the user asks for it.
- If a test changes state by mistake, restore the old value at once and tell
  the user.

## Protocol rules

Read `docs/PROTOCOL.md` before you change a UPnP call, a URI scheme or a
WebSocket command.

- Transport, queue and group volume go to the group coordinator. Volume, EQ
  and device settings go to the speaker itself.
- SOAP arguments must follow SCPD order: `sonos actions <Service>`.
- WebSocket group commands go to the coordinator's socket, player commands go
  to the player's own socket.
- Sonos app shortcut favorites (empty `<res>`) cannot play locally.
- The title in the Sonos app comes from the ID3 tags of a file. Download
  with `yt-dlp -x --audio-format mp3 --embed-metadata`.

## Code

- Parse all XML through `parseXml` in `src/xml.ts`.
- Comments are one line and state the reason. The code carries the rest.
- A comment-only change must leave the bundle unchanged. Compare
  `bun build src/cli.ts --minify --target bun` output before and after.
