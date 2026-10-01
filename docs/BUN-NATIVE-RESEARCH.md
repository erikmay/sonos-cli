# Bun tooling research for sonos-cli

Research date: 2026-10-01. Local runtime: Bun 1.4.2; installed types: `@types/bun` 1.4.2 and TypeScript 7.0.2. Sources are official documentation, installed Bun declarations, and isolated runtime probes. The findings below describe the implementation before the follow-up changes. No speaker commands ran.

A local WebSocket handshake found that Bun 1.4.2 accepts the subprotocol as `protocols: ["v1.api.smartspeaker.audio"]`; the string form accepted by its declarations throws at runtime. The implementation uses the verified array form.

## Recommendation

Use more built-in functionality where it removes work: command argument parsing, typed WebSocket options, file creation, and file deletion. Keep explicit Sonos protocol rules, snapshot validation, and restoration coordination in application code. This repository already uses Bun for the expensive runtime work: UDP discovery, HTTP serving, subprocess execution, XML parsing, file access, sleeping, and executable builds.

“Native” has three meanings here:

| Category | Examples | Meaning |
| --- | --- | --- |
| Bun-specific runtime APIs | `Bun.XML`, `Bun.file`, `Bun.write`, `Bun.serve`, `Bun.spawn`, `Bun.udpSocket` | Bun owns these APIs. |
| Node-compatible built-ins implemented by Bun | `node:util` parsing; `node:fs`, `node:os`, `node:path`; `process` signals | These run inside Bun. A `node:` import does not require a Node process or an npm dependency. |
| Standard JavaScript/Web APIs implemented by Bun | `WebSocket`, `fetch`, `AbortSignal`, `AsyncDisposableStack`, `Promise` | Use their standard contracts, with documented Bun extensions where needed. |

The official [API catalog](https://bun.sh/docs/runtime/bun-apis), [Node compatibility table](https://bun.sh/docs/runtime/nodejs-compat), and [API reference](https://bun.sh/reference) distinguish these surfaces.

## 1. Replace token parsing with the built-in parser, with a bounded adaptation

Bun's [argument parsing guide](https://bun.sh/guides/process/argv) recommends `parseArgs` from `node:util`. This is a Bun-provided Node-compatible built-in, not `Bun.parseArgs`. It provides typed options, positional arguments, strict rejection, and optional tokens.

The original CLI manually consumed the following token for string options. A strict parser rejects an ambiguous value such as `pause --voice --dry-run`, which prevents the option from swallowing `--dry-run`. Offline probes confirmed that behavior on Bun 1.4.2.

It is not a blind replacement. Existing forms such as `volume -3` and `seek -15` use signed positional values. Strict parsing treats these as options. `allowNegative` concerns negated boolean flags such as `--no-color`; it does not solve signed positionals. Preserve the CLI's signed positional grammar through a small, command-aware adaptation. Do not disable strict parsing globally.

The larger design change is still required: each command should own its option and positional contract. A generic parser cannot decide whether `--voice` belongs on `pause`, enforce Sonos volume limits, or replace command-specific validation. Use it to delete lexical parsing, not to conceal missing contracts.

## 2. Use the typed global WebSocket constructor

Bun extends the global WebSocket constructor with `protocols`, `headers`, and `tls` options. The extension has an official [`Bun.WebSocketOptions` contract](https://bun.com/reference/bun/WebSocketOptions). This covers the custom headers and TLS settings required by `src/ws.ts`; no client library is needed.

The installed declarations also expose these constructor overloads in `node_modules/bun-types/globals.d.ts`. An isolated strict TypeScript compilation accepted `protocols: "v1.api.smartspeaker.audio"`, an API key in `headers`, and `tls: { rejectUnauthorized: false }` without a cast. The current code sets the subprotocol as a raw header instead. Use the native `protocols` option and then remove the cast; removing the cast alone was not the verified example. Offline runtime inspection found that importing `WebSocket` from `bun` produces `undefined`; use the global constructor. Server-side WebSocket APIs described in the [WebSocket documentation](https://bun.com/docs/runtime/http/websockets) are a different surface. Speaker handshake interoperability was not checked.

This removes type indirection. It does not remove request correlation, response deadlines, incoming message validation, or explicit transport error categories. Those are application protocol responsibilities.

## 3. Delete redundant directory creation and use file deletion

[`Bun.write`](https://bun.sh/reference/bun/write) creates missing parent directories by default. Its `createPath` option defaults to `true`. This is also explicit in the installed `bun.d.ts` declaration. A temporary-directory probe on Bun 1.4.2 successfully wrote nested JSON without calling `mkdir`.

Consequently, `saveSnapshot` in `src/snapshot.ts` and `writeCache` in `src/discovery.ts` can remove their preceding recursive `mkdir` calls and imports. Passing `{ createPath: true }` is optional if the code should state the dependency explicitly.

Use `Bun.file(path).delete()` for the temporary speech file. The [file I/O documentation](https://bun.sh/docs/runtime/file-io) documents this operation, and an isolated probe confirmed deletion. This can remove `unlink` from `src/cli.ts`.

Do not replace useful `node:os` or `node:path` calls merely to remove their imports. Bun documents both modules as implemented. `networkInterfaces`, `homedir`, `tmpdir`, and path operations express the needed behavior directly. Bun's file documentation itself recommends `node:fs` for directory operations.

## 4. File writes still need a persistence policy

No atomic-replacement option appears in the documented `Bun.write` options or the installed declarations. The reference describes overwriting and truncation. Treat “write succeeded” as distinct from atomic replacement or power-loss durability.

For the recovery snapshot, a plausible design is writing a temporary sibling file with `Bun.write`, then replacing the destination with `rename` from `node:fs/promises`. This keeps readers from observing partially written JSON on systems that provide atomic same-filesystem rename. It does not itself guarantee persistence across power failure; that requires a deliberate synchronization policy. The [Node filesystem documentation](https://nodejs.org/api/fs.html) specifies `rename`, file synchronization, and related primitives.

Recommendation: decide the required crash behavior for `last-interrupt` before adding a persistence helper. The discovery cache is disposable and can use a simpler policy. Do not introduce SQLite solely to store these small JSON files.

## 5. Bun XML parsing cannot delete the normalization contract

[`Bun.XML.parse`](https://bun.sh/docs/runtime/xml) keeps namespace prefixes and namespace attributes. Compact mode returns an array only when sibling names repeat. Tree mode provides ordered children, but changes the model entirely. Its documented [`ParseOptions`](https://bun.com/reference/bun/XML/ParseOptions) exposes only `compact`; there are no namespace stripping, forced-array, or lenient parsing options.

`src/xml.ts` already uses the native parser. Its adapter removes prefixes, excludes namespace declarations, forces selected collections to arrays, and retries illegal control characters. Bun cannot perform these policies through parser settings. Removing `normalize` without changing all consumers would break the contract. Keep one canonical adapter; improve its types separately. A tree-model rewrite would add traversal work to this data-oriented CLI.

[`Bun.XML.stringify`](https://bun.com/reference/bun/XML/stringify) can replace manual element construction and escaping. It accepts ordered child nodes and escapes XML text. However, Sonos SOAP argument order remains application-owned. Boolean values stringify as `true`/`false`, not Sonos `1`/`0`; an offline probe confirmed this. Keep that conversion and the XML declaration. Offline in-memory SOAP probes confirmed namespaces, escaping, and insertion order. Native serialization rejects invalid XML characters; replacing interpolation changes that error behavior. Assess the resulting code size and intended boundary before replacing the currently short envelope builder.

If interpolation remains clearer, [`Bun.escapeHTML`](https://bun.com/docs/runtime/utils#bunescapehtml) can replace the five chained replacements inside the canonical `escapeXml` helper. Local probes round-tripped ampersands, angle brackets, quotes, apostrophes, and Unicode through `parseXml`. Apostrophes become numeric `&#x27;` rather than `&apos;`, which changes bytes while preserving XML text. Do not escape before `XML.stringify`; it escapes values itself. Neither escape operation substitutes for validation of protocol fields.

## 6. Await resource closure and keep restoration ownership explicit

[`Server.stop`](https://bun.sh/reference/bun/Server/stop) returns `Promise<void>` and resolves once connections close. Passing `true` terminates active connections. The local declaration and a loopback-only probe agree. `FileServer.stop: () => void` currently hides this result. Expose `Promise<void>` so cleanup can await closure.

Bun supports `using` and `await using`; its [1.2 release notes](https://bun.sh/blog/bun-v1.2) describe explicit resource management. A Bun 1.4.2 probe found `DisposableStack` and `AsyncDisposableStack`, and a server `[Symbol.dispose]` function. The server had no `[Symbol.asyncDispose]`, and the installed `serve.d.ts` did not declare its disposal symbol. The official [server disposal reference](https://bun.sh/reference/bun/Server/%5Bdispose%5D) documents the runtime method. Prefer a direct `try/finally` with awaited `stop(true)` to adding casts around that declaration mismatch. An application-owned asynchronous disposable is an option if it reduces repeated cleanup.

Disposal is lexical cleanup; it does not serialize concurrent cleanup requests or await work after a forced `process.exit()`. Bun's [signal guide](https://bun.sh/guides/process/os-signals) uses the Node-compatible `process.on` API. Keep an explicit signal path that awaits a shared restoration promise, shuts down the file server in `finally`, and removes its listener. No Bun API substitutes for the snapshot restoration state model.

## 7. Runtime validation remains application work

The official Bun API catalog and installed declarations expose JSON readers and parsers, but no general runtime schema validator. This is an inference from the reviewed public API surface, not a claim about all future versions.

`Bun.file(path).json()` parses JSON syntax. A TypeScript cast does not check its fields. Validate snapshots completely before hardware operations; validate cached hosts and incoming WebSocket messages at their boundaries. For the current small fixed shapes, explicit decoders can preserve the dependency-free runtime. A schema library may be justified later if it removes repeated contracts; calling it “Bun native” would be inaccurate.

## 8. Keep the external type checker

Bun's [file type documentation](https://bun.sh/docs/runtime/file-types) states that its TypeScript loader strips types without type checking. `bun build` and successful execution cannot replace `tsc --noEmit`.

The repository already has Bun execution, Bun standalone compilation, and a TypeScript check. Its `tsconfig.json` follows Bun's [recommended settings](https://bun.sh/docs/runtime/typescript), including `types: ["bun"]`, required for current TypeScript versions. The [TypeScript 6 and 7 guide](https://bun.sh/docs/typescript-6) describes compatibility updates; there is no reason to remove the checker to make the toolchain more Bun-specific.

Keep `bun run typecheck` and `bun build ... --compile`. Pinning compatible Bun declarations can avoid editor types silently getting ahead of the supported runtime. Build cross-platform binaries only for actual distribution targets.

Keep `Bun.spawn` for macOS `say`; a [Bun shell](https://bun.com/docs/runtime/shell) template adds no benefit to the existing argument-array execution. The [subprocess guide](https://bun.com/docs/runtime/child-process) documents `.text()` on output streams. `proc.stderr.text()` can remove the `new Response(proc.stderr).text()` wrapper. Drain stderr concurrently with awaiting the exit code, so a full pipe cannot block exit. An isolated offline subprocess probe confirmed `Promise.all([proc.exited, proc.stderr.text()])` without invoking `say`.

## 9. Keep the current file handler and explicit MIME contract

The [routing documentation](https://bun.sh/docs/runtime/http/routing) promises automatic partial responses for static file routes. It separately illustrates a `fetch` handler that parses `Range` and returns a file slice. `src/fileserver.ts` uses a `fetch` handler, while its comment claims Bun handles the ranges automatically.

A loopback probe verified both forms on Bun 1.4.2 with a loopback-only request: `Range: bytes=2-5` against `0123456789` returned `206`, `Content-Range: bytes 2-5/10`, and body `2345` from both the current handler pattern and a static file route. The documentation's slicing example is not evidence that this handler needs manual range code. Keep the current handler. A static route would bypass fallback `fetch` authorization unless the IP allowlist moves to an earlier boundary. The probe establishes the supported runtime behavior, not every historical Bun version or every range form.

The [file guide](https://bun.sh/guides/http/stream-file) documents automatic MIME detection. It is not a drop-in replacement for `CONTENT_TYPES`. Offline probes found `audio/x-m4a`, `audio/x-aac`, `audio/x-flac`, and `audio/x-wav` where the CLI explicitly uses `audio/mp4`, `audio/aac`, `audio/flac`, and `audio/wav`. MP3 and Ogg matched. Keep the supported-format allowlist and the deliberate MIME values unless speaker evidence supports a change.

## 10. Optional terminal width correction

[`Bun.stringWidth`](https://bun.com/docs/runtime/utils#bunstringwidth) measures display columns instead of UTF-16 string length. `src/cli.ts` currently uses `.length` and `padEnd` for its table widths. Room names with wide characters can therefore misalign. An in-memory probe measured `客厅` as four display columns while its JavaScript length is two.

Compute widths with `Bun.stringWidth`, then append the required number of spaces. This is a small presentation improvement. It changes output and should not be described as a guaranteed behavior-preserving substitution.

## Implementation order

1. Introduce command-local option contracts and built-in strict parsing, preserving signed positionals. This removes the most consequential bespoke logic.
2. Fix resource ownership and the awaited `FileServer.stop` contract. Bun provides closure and disposal primitives; the shared restoration promise remains application logic.
3. Use the native WebSocket `protocols` option and remove the constructor cast. That option shape is verified by strict compilation.
4. Remove redundant `mkdir` calls and use `BunFile.delete` for speech cleanup. These are small direct simplifications.
5. Consider native XML serialization if it reduces the SOAP builder and its stricter error behavior is intended. Preserve the canonical parser adapter.
6. Use direct stderr `.text()` with concurrent draining where useful. Keep argument-array spawning, the current file handler, MIME contracts, and the external type checker.

Validate persisted state and classify transport errors regardless of which APIs are used. These address the earlier review findings more directly than increasing the number of Bun-specific calls.

## Verification performed

- Inspected all runtime modules, package scripts, TypeScript configuration, and installed Bun type declarations.
- Read official Bun runtime guides, API references, compatibility documentation, and release notes.
- Confirmed Bun 1.4.2 XML namespace retention, boolean serialization, and terminal width with in-memory probes.
- Confirmed implicit parent creation and file deletion inside a temporary directory; removed the directory afterward.
- Confirmed disposal methods and the asynchronous server stop result on a loopback listener; closed it afterward.
- Incorporated offline parser, WebSocket compilation, SOAP serialization, MIME, Range, and subprocess probes.

These checks establish API behavior on the local runtime. They do not verify speaker interoperability or recommend a runtime upgrade.
