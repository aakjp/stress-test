# rust-fetch 2.2.0 — What's New

**Released:** 2026-10-22 · **Tag:** [`v2.2.0`](https://github.com/anonymous/rust-fetch/releases/tag/v2.2.0) · **Upgrade:** `npm install rust-fetch@^2.2.0`

2.2.0 is the largest feature release since 2.0, adding WebSockets, upload progress and
typed request methods on top of a reworked request pipeline. **No breaking changes** —
code written for 2.1.0 runs unchanged (verified: the 2.1.0 demo suite passes on 2.2.0
without modification).

---

## New features

### 1. WebSockets — `client.websocket()`

One client for HTTP and WebSockets. Connections are created from the same configured
`WasmClient`, share its headers, and add reconnection with jittered exponential backoff
and typed errors.

```ts
import { WasmClient } from "rust-fetch";

const client = new WasmClient({ timeoutMs: 10_000 });

const ws = client.websocket("wss://example.com/socket", {
  protocols: ["v2"],
  reconnect: { maxRetries: 5, initialDelayMs: 250 },
  messageType: "json",           // auto-parse text messages as JSON
  onOpen: () => console.log("open"),
  onMessage: (data) => console.log(data),
  onReconnect: (info) => console.log(`attempt ${info.attempt} after ${info.delayMs}ms`),
  onClose: (info) => console.log(`closed: ${info.code} ${info.reason}`),
});

ws.send("hello");                 // queued until the connection opens
ws.sendJson({ hello: "world" });  // serialized to JSON text
console.log(ws.state);            // 'connecting' | 'open' | 'reconnecting' | 'closing' | 'closed'

await ws.opened;                  // resolves on first open
const close = await ws.closed;    // resolves with { code, reason, wasClean }
ws.close();
```

Details worth knowing:

- **Reconnection is opt-in** (`reconnect` option) and triggers only on abnormal drops
  (close codes 1001, 1006, 1011–1014). A clean close stays closed.
- **Handshake headers work in Node.js**; browsers don't allow them, so there they
  reject with an `InvalidInputError`.
- Messages sent while connecting or reconnecting are **queued** and flushed on open.
- Binary messages arrive as `Uint8Array`; text as `string` (or parsed JSON with
  `messageType: 'json'`).

### 2. Upload progress — `onUploadProgress`

```ts
const res = await client.post("https://api.example.com/upload", {
  body: file,                       // string | JSON | ArrayBuffer | Blob | stream
  onUploadProgress: (p) => {
    console.log(`${p.loaded}/${p.total} bytes`);
  },
});
```

Measured on a 2 MB upload (local loopback): **32 progress events**, `total` exactly
matching the body length, and a final event at 100% before the response resolves.
If the request is retried, progress restarts from 0. In browsers these requests go
out through `XMLHttpRequest` (cross-origin ones are preflighted); it can't be combined
with `responseType: 'stream'`.

### 3. Typed request methods — `client.get<User>(…)`

All request methods are now generic, so response bodies are typed without casts:

```ts
interface Todo { userId: number; id: number; title: string; completed: boolean }

const res = await client.get<Todo[]>("/todos");
res.body[0].title;  // ✅ typed — no `as` cast
```

`HttpResponse<T>` keeps its shape: `{ status, statusText, ok, url, headers, body }`.

### 4. Tooling and infrastructure

- **TypeScript 7 for development**; the published type definitions are checked
  against both TypeScript 5.2 and 7.
- **Codecov coverage** of the Rust core and the Node.js transport.
- The **native Node-API transport** (up to 1.95× `fetch()`'s throughput under
  concurrency) is now in the repository — npm distribution follows in 2.3.0.

---

## Performance in 2.2.0

Two numbers summarize it (same machine, Apple-silicon macOS, Node.js 22.15; see
[`BENCHMARK-2.2.0.md`](./BENCHMARK-2.2.0.md) for the full report):

- **+4.5–7.3% throughput across every benchmark scenario vs 2.1.0**, including the
  50-concurrent case, which now **beats native `fetch()`** (102%) after trailing it
  in 2.1.0 (94%).
- **At 50,000 req/s offered load** (deliberate overload), the bounded connection pool
  turns 2.1.0's collapse into the fastest client on the board:
  **21,341 req/s achieved (6.1×), p99 505 ms (21× lower), zero errors (was 173k)**.

## Verification

A 19-check smoke suite covering every new feature — typed generics, upload progress,
WebSocket open/echo/binary/JSON, reconnection, close semantics, and typed errors —
passes 19/19. Details and reproduction steps: [`TEST-2.2.0.md`](./TEST-2.2.0.md).

## What's next

**2.3.0 — the native transport on npm:** prebuilt per-platform binaries so
`npm install rust-fetch` gets the native transport with no build step, plus Windows
support and a Windows CI job. See the
[roadmap](https://github.com/anonymous/rust-fetch/blob/main/ROADMAP.md).
