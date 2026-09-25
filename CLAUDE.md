# sonos-cli

Bun/TypeScript CLI that controls Sonos speakers in the local network.
Port of the SoCo core logic. Protocol notes: `docs/PROTOCOL.md`.

- Run: `bun src/cli.ts <command>`. Type check: `bun run typecheck`.
- Speakers in the office are used by other people. Check changing commands
  with `--dry-run` first. Do not pause, skip, regroup or change the volume of
  music that plays unless the user asks for it.
- Read commands (`status`, `track`, `favorites`, `actions`, `raw Get...`,
  `ws ... get...`) are safe.
- Transport, queue and group volume calls go to the group coordinator.
  Volume, EQ and device settings go to the speaker itself.
- SOAP argument order must match the SCPD (`sonos actions <Service>`).
- No runtime dependencies. XML goes through `parseXml` in `src/xml.ts` (Bun.XML, normalized).
