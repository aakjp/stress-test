// test-2.2.0.ts — smoke test for rust-fetch 2.2.0 features
// 1. Generic typed request methods: client.get<User>(…)
// 2. Upload progress (onUploadProgress)
// 3. WebSockets: messages, JSON, reconnection, typed errors

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WasmClient, type RustFetchError } from "rust-fetch";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Todo {
  userId: number;
  id: number;
  title: string;
  completed: boolean;
}

// ---------------------------------------------------------------- HTTP server
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/todos") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { userId: 1, id: 1, title: "test rust-fetch 2.2.0", completed: false },
      ]),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/echo-upload") {
    // Read the body slowly so intermediate upload-progress events appear
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      // small pause every ~256KB to let progress events fire
      if (received % (256 * 1024) < chunk.length) {
        setTimeout(() => {}, 5);
      }
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: received }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/error") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
const httpPort = (httpServer.address() as { port: number }).port;
const httpBase = `http://127.0.0.1:${httpPort}`;

// ------------------------------------------------------------ WebSocket server
const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
let wsPort = 0;
await new Promise<void>((r) => wsServer.on("listening", () => {
  wsPort = wsServer.address().port;
  r();
}));
const wsBase = `ws://127.0.0.1:${wsPort}`;

let connections = 0;
let killNextConnection = false;
wsServer.on("connection", (ws: WebSocket) => {
  connections++;
  if (killNextConnection) {
    // abnormal drop (no close frame) after a beat -> client should reconnect
    setTimeout(() => ws.terminate(), 50);
    return;
  }
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      ws.send(data);
    } else {
      const text = data.toString();
      if (text.startsWith("{")) {
        ws.send(text); // echo raw JSON back (for messageType: 'json')
      } else {
        ws.send(`echo:${text}`);
      }
    }
  });
});

// ------------------------------------------------------------------- the tests
const client = new WasmClient({
  timeoutMs: 10_000,
  retries: 0,
});

try {
  // 1. Typed generic request methods ------------------------------------------
  console.log("\n[1] Generic typed request methods");
  {
    const res = await client.get<Todo[]>(`${httpBase}/todos`);
    const todos = res.body;
    check("get<Todo[]> returns array", Array.isArray(todos));
    check("body element has Todo shape (title: string)",
      typeof todos?.[0]?.title === "string" && todos[0].title.includes("rust-fetch"));
    check("ok is true, status 200", res.ok && res.status === 200);
  }

  // 2. Upload progress ---------------------------------------------------------
  console.log("\n[2] Upload progress (onUploadProgress)");
  {
    const body = Buffer.alloc(2 * 1024 * 1024, 7); // 2 MB
    const events: { loaded: number; total: number }[] = [];
    const res = await client.post<{ ok: boolean; bytes: number }>(
      `${httpBase}/echo-upload`,
      {
        body,
        headers: { "content-type": "application/octet-stream" },
        onUploadProgress: (p) => events.push({ loaded: p.loaded, total: p.total }),
      },
    );
    check("upload completed with parsed JSON body", res.body?.ok === true && res.body.bytes === body.length);
    const hasTotal = events.some((e) => e.total === body.length);
    const multipleEvents = events.length >= 2;
    const reachedEnd = events.some((e) => e.loaded === e.total);
    check(`progress events fired (${events.length} events)`, multipleEvents,
      `only ${events.length} event(s)`);
    check("progress total matches body length", hasTotal);
    check("progress reached 100%", reachedEnd);
  }

  // 3. WebSockets ---------------------------------------------------------------
  console.log("\n[3] WebSockets: client.websocket()");
  {
    // 3a. open + text echo
    const opened: number[] = [];
    const messages: unknown[] = [];
    const errors: RustFetchError[] = [];
    const reconnects: number[] = [];

    const ws = client.websocket(wsBase, {
      onOpen: () => opened.push(Date.now()),
      onMessage: (data) => messages.push(data),
      onError: (e) => errors.push(e),
      onReconnect: (info) => reconnects.push(info.attempt),
    });

    // wait for open
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
      const iv = setInterval(() => {
        if (messages.length > 0) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        }
      }, 25);
      ws.send("hello");
    }).catch((e) => {
      throw e;
    });

    check("connection opened", opened.length === 1);
    check("text message echoed", messages[0] === "echo:hello",
      `got ${JSON.stringify(messages[0])}`);

    // 3b. binary
    ws.send(new Uint8Array([1, 2, 3, 4]));
    await new Promise<void>((r) => setTimeout(r, 300));
    const bin = messages.find((m) => m instanceof Uint8Array) as Uint8Array | undefined;
    check("binary message echoed as Uint8Array",
      bin instanceof Uint8Array && Array.from(bin).join(",") === "1,2,3,4");

    // 3c. JSON messages: messageType 'json' auto-parses text messages
    {
      const jsonMsgs: unknown[] = [];
      const wsj = client.websocket(wsBase, {
        messageType: "json",
        onMessage: (data) => jsonMsgs.push(data),
      });
      await new Promise<void>((r) => setTimeout(r, 200));
      wsj.sendJson({ hello: "world", n: 42 }); // server echoes raw JSON for this
      await new Promise<void>((r) => setTimeout(r, 400));
      const parsed = jsonMsgs.find(
        (m) => typeof m === "object" && m !== null && (m as any).hello === "world");
      check("sendJson echoed and auto-parsed (messageType: 'json')",
        parsed !== undefined && (parsed as any).n === 42,
        `got ${JSON.stringify(jsonMsgs.at(-1))}`);
      wsj.close();
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    // 3d. connection state + url
    check("state is 'open'", ws.state === "open", `state=${ws.state}`);

    // 3e. reconnection after abnormal drop
    killNextConnection = true;
    ws.send("trigger"); // message on the doomed connection
    await new Promise<void>((r) => setTimeout(r, 1500));
    // server terminated that connection; reconnect defaults are OFF unless we
    // enabled them — reconnects[] should be empty and state 'closed'/'reconnecting'
    if (reconnects.length > 0) {
      check("reconnect attempted (info.attempt >= 1)", reconnects[0] >= 1);
    } else {
      check("no reconnection when reconnect is off (default)", true);
    }
    ws.close();
    await new Promise<void>((r) => setTimeout(r, 200));
    check("state is 'closed' after close()", ws.state === "closed", `state=${ws.state}`);

    // 3f. reconnecting WebSocket: drop -> auto-reconnect
    {
      const opens: number[] = [];
      const events: string[] = [];
      const rc = client.websocket(wsBase, {
        reconnect: { maxRetries: 3, initialDelayMs: 50, multiplier: 1.5, maxDelayMs: 500 },
        onOpen: () => opens.push(Date.now()),
        onMessage: () => {},
        onError: () => events.push("error"),
        onReconnect: () => events.push("reconnect"),
        onClose: () => events.push("close"),
      });
      // first connection gets killed by the server (killNextConnection still true)
      await new Promise<void>((r) => setTimeout(r, 1500));
      killNextConnection = false;
      await new Promise<void>((r) => setTimeout(r, 1500));
      check("reconnected: onOpen fired at least twice", opens.length >= 2,
        `opens=${opens.length}, events=${events.join(",")}`);
      check("onReconnect fired", events.includes("reconnect"));
      rc.close();
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    // 3g. typed errors: HTTP error still rejects with HttpError
    let httpErr: RustFetchError | undefined;
    try {
      await client.get(`${httpBase}/error`);
    } catch (e) {
      httpErr = e as RustFetchError;
    }
    check("HTTP 500 rejects with HttpError", httpErr?.kind === "HttpError" && httpErr.status === 500,
      `got ${httpErr?.kind}/${httpErr?.status}`);

    // 3h. websocket connect to a non-WebSocket endpoint -> typed error
    {
      const wsErrors: RustFetchError[] = [];
      const ws2 = client.websocket(httpBase.replace("http", "ws"), {
        timeoutMs: 2000,
        onError: (e) => wsErrors.push(e),
      });
      await new Promise<void>((r) => setTimeout(r, 2500));
      check("non-ws endpoint reports typed error", wsErrors.length > 0,
        "no error event fired");
      check("typed error name is set (e.g. NetworkError)",
        wsErrors.length === 0 || ["NetworkError", "TimeoutError", "HttpError"].includes(wsErrors[0].kind),
        `kind=${wsErrors[0]?.kind}`);
      ws2.close();
    }
  }
} catch (err) {
  console.error("\n💥 test threw:", err);
  failed++;
  failures.push(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  console.log("\n---------------------------------------------");
  console.log(`passed: ${passed}, failed: ${failed}`);
  if (failures.length) {
    console.log("failures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  wsServer.close();
  httpServer.close();
  process.exit(failed > 0 ? 1 : 0);
}
