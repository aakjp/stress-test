# rust-fetch 2.2.0 — Verification Report

**Date:** 2026-10-23 · **Package:** `rust-fetch@2.2.0` (npm, wasm client + node transport) ·
**Environment:** darwin 25.6.0 (arm64), Node.js v22.15.1
**Suite:** [`test-2.2.0.ts`](./test-2.2.0.ts) · **Run:** `npx tsx test-2.2.0.ts`

**Result: 19/19 checks passed, exit 0.** The suite is self-contained — it starts its
own local HTTP server and WebSocket echo server (the `ws` package), so it has no
network dependencies and can serve as a regression gate before cutting future releases
(it exits non-zero on any failure).

---

## What was verified

### [1] Generic typed request methods — `client.get<T>(…)` — 3/3

| Check | Result |
| --- | --- |
| `get<Todo[]>` returns an array body | ✅ |
| Body element has the declared shape (`title: string` present) | ✅ |
| `ok: true`, `status: 200` | ✅ |

### [2] Upload progress — `onUploadProgress` — 4/4

2 MB POST upload against a local server that reads the body incrementally:

| Check | Result |
| --- | --- |
| Upload completes; response JSON parsed (`bytes` matches body length) | ✅ |
| Multiple progress events fired (**32 events** observed) | ✅ |
| `total` matches the body length exactly | ✅ |
| Progress reaches 100% (`loaded === total`) | ✅ |

### [3] WebSockets — `client.websocket()` — 12/12

| Check | Result |
| --- | --- |
| Connection opens (`onOpen` fires) | ✅ |
| Text message echoed | ✅ |
| Binary message echoed as `Uint8Array` | ✅ |
| `sendJson` + `messageType: 'json'` auto-parses responses | ✅ |
| `state` reads `'open'` while connected | ✅ |
| No reconnection when `reconnect` is off (default) | ✅ |
| `state` reads `'closed'` after `close()` | ✅ |
| Reconnection: `onOpen` fires again after abnormal drop (`ws.terminate()`) | ✅ |
| `onReconnect` fires with attempt info | ✅ |
| HTTP 500 rejects with `HttpError` (`kind: 'HttpError'`, `status: 500`) | ✅ |
| WebSocket to a non-WebSocket endpoint reports a typed error | ✅ |
| Error names use the documented `RustFetchErrorKind` values | ✅ |

## Backward compatibility (2.1.0 → 2.2.0)

The existing 2.1.0 demo (`index.ts`, jsonplaceholder) runs **unmodified** on 2.2.0 and
returns correct results. No API used by 2.1.0 code changed shape.

## Notes from verification

1. **The published `.d.ts` matches the runtime exactly.** The single test failure
   during development was the test itself calling `ws.state()` — `state` is a readonly
   property (getter), not a method, exactly as documented. No library defect was found.
2. `messageType: 'json'` parses **text** messages as JSON; binary messages still
   arrive as `Uint8Array`. `sendJson` serializes but does not change how the server's
   replies are parsed — pair it with `messageType: 'json'` for round-trip typed JSON.
3. Reconnection is silent by default: `reconnect` must be enabled explicitly, and it
   triggers only on abnormal drops (1001/1006/1011–1014), not clean closes.

## Reproduce

```bash
npm install -D ws @types/ws   # local test servers (already in this project)
npx tsx test-2.2.0.ts         # exits 0 on pass, 1 on failure
```

Related: [`RELEASE-2.2.0.md`](./RELEASE-2.2.0.md) · [`BENCHMARK-2.2.0.md`](./BENCHMARK-2.2.0.md)
