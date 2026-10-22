// benchmark.ts - rust-fetch vs native fetch vs axios against a local server.
//
// Methodology (mirrors the library's own bench): local loopback server, no
// network variance; each client warms up; per run, ROUNDS rounds with the
// client order rotating per round to cancel out order bias; the whole
// benchmark is repeated RUNS times and the run medians are aggregated
// (median, ratio vs native fetch, win count).
//
// Usage: npx tsx benchmark.ts [RUNS]   (default 10)

import http from "node:http";
import { Agent } from "node:http";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { platform, release, arch } from "node:os";
import { WasmClient } from "rust-fetch";
import axios from "axios";

const RUNS = Number(process.argv[2] ?? 10);
const ROUNDS = 5;
const RESULTS_FILE = "benchmark-results.json";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const SMALL = JSON.stringify(
  Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
  })),
);

const LARGE = JSON.stringify(
  Array.from({ length: 5_000 }, (_, i) => ({
    id: i,
    title: `Record ${i} with some padding to bulk this payload up`,
    nested: { a: i * 2, b: [1, 2, 3], ok: i % 2 === 0 },
  })),
); // ~0.6 MB

const BINARY = Buffer.alloc(8 * 1024 * 1024); // ~8 MB
let seed = 12345;
for (let i = 0; i < BINARY.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  BINARY[i] = seed & 0xff;
}

// ---------------------------------------------------------------------------
// Local server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/small") {
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(SMALL) });
    res.end(SMALL);
  } else if (req.url === "/large") {
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(LARGE) });
    res.end(LARGE);
  } else if (req.url === "/binary") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": BINARY.length });
    res.end(BINARY);
  } else {
    res.writeHead(404).end();
  }
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type Body = unknown;
type Kind = "json" | "binary";
type BenchFn = (url: string, kind: Kind) => Promise<{ status: number; body: Body }>;

// 1. Native fetch (undici, connection pooling built in)
const nativeGet: BenchFn = async (url, kind) => {
  const res = await fetch(url);
  const body = kind === "json" ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body };
};

// 2. rust-fetch (wasm core + lean node:http transport, globalAgent keep-alive)
const rust = new WasmClient({ timeoutMs: 30_000 }); // retries off, like the others
const rustGet: BenchFn = async (url) => rust.get(url); // body already decoded

// 3. axios defaults (http adapter, NO keep-alive agent by default in 1.20)
const axiosDefault = axios.create({ timeout: 30_000, validateStatus: () => true });
const axiosDefaultGet: BenchFn = async (url, kind) => {
  const res = await axiosDefault.get(url, { responseType: kind === "json" ? "json" : "arraybuffer" });
  return { status: res.status, body: res.data };
};

// 4. axios with an explicit keep-alive agent (isolates config vs engine overhead)
const axiosKeepAlive = axios.create({
  timeout: 30_000,
  validateStatus: () => true,
  httpAgent: new Agent({ keepAlive: true, maxSockets: 128 }),
});
const axiosKeepAliveGet: BenchFn = async (url, kind) => {
  const res = await axiosKeepAlive.get(url, { responseType: kind === "json" ? "json" : "arraybuffer" });
  return { status: res.status, body: res.data };
};

const clients: { name: string; get: BenchFn }[] = [
  { name: "native fetch", get: nativeGet },
  { name: "rust-fetch", get: rustGet },
  { name: "axios (default)", get: axiosDefaultGet },
  { name: "axios (keepAlive)", get: axiosKeepAliveGet },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(fn: BenchFn, url: string, kind: Kind, total: number, concurrent: number): Promise<number> {
  const start = performance.now();
  if (concurrent === 1) {
    for (let i = 0; i < total; i++) await fn(url, kind);
  } else {
    for (let done = 0; done < total; done += concurrent) {
      const batch = Math.min(concurrent, total - done);
      await Promise.all(Array.from({ length: batch }, () => fn(url, kind)));
    }
  }
  const seconds = (performance.now() - start) / 1000;
  return total / seconds;
}

interface Scenario {
  name: string;
  url: string;
  kind: Kind;
  total: number;
  concurrent: number;
  verify: (body: Body) => void;
}

const scenarios: Scenario[] = [
  {
    name: "Small JSON, sequential",
    url: "/small",
    kind: "json",
    total: 1_000,
    concurrent: 1,
    verify: (body) => {
      if (!Array.isArray(body) || body.length !== 10) throw new Error("small JSON mismatch");
    },
  },
  {
    name: "Small JSON, 50 concurrent",
    url: "/small",
    kind: "json",
    total: 300,
    concurrent: 50,
    verify: (body) => {
      if (!Array.isArray(body) || body.length !== 10) throw new Error("small JSON mismatch");
    },
  },
  {
    name: "Large JSON (0.6 MB)",
    url: "/large",
    kind: "json",
    total: 20,
    concurrent: 1,
    verify: (body) => {
      if (!Array.isArray(body) || body.length !== 5_000) throw new Error("large JSON mismatch");
    },
  },
  {
    name: "Binary 8 MB",
    url: "/binary",
    kind: "binary",
    total: 8,
    concurrent: 1,
    verify: (body) => {
      const size = body instanceof ArrayBuffer ? body.byteLength : (body as Uint8Array).byteLength;
      if (size !== BINARY.length) throw new Error(`binary mismatch: ${size}`);
    },
  },
];

let BASE = "";

/** One full benchmark run: all scenarios, ROUNDS rounds, client order rotating. */
async function benchmarkRun(scenario: Scenario): Promise<Record<string, number>> {
  const perClient: Record<string, number[]> = {};
  for (const c of clients) perClient[c.name] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (let c = 0; c < clients.length; c++) {
      const client = clients[(round + c) % clients.length]; // rotate order per round
      const reqs = await measure(client.get, BASE + scenario.url, scenario.kind, scenario.total, scenario.concurrent);
      perClient[client.name].push(reqs);
    }
  }

  const result: Record<string, number> = {};
  for (const [name, values] of Object.entries(perClient)) result[name] = median(values);
  return result;
}

async function run() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}`;

  // Warm up every client (wasm init, keep-alive sockets, parse caches)
  for (const s of scenarios) {
    for (let i = 0; i < 3; i++) {
      for (const c of clients) {
        const r = await c.get(BASE + s.url, s.kind);
        s.verify(r.body);
      }
    }
  }
  console.log(`Warm-up done. ${clients.length} clients, ${RUNS} runs x ${ROUNDS} rounds, order rotating.\n`);

  // Aggregate: per scenario, one result per client per run
  const aggregate: Record<string, Record<string, number[]>> = {};
  for (const s of scenarios) {
    aggregate[s.name] = {};
    for (const c of clients) aggregate[s.name][c.name] = [];
  }

  for (let run = 1; run <= RUNS; run++) {
    for (const s of scenarios) {
      const result = await benchmarkRun(s);
      for (const c of clients) aggregate[s.name][c.name].push(result[c.name]);
    }
    process.stdout.write(`run ${run}/${RUNS} done\n`);
  }

  // Raw data dump for the published report (one median per client per run per scenario)
  const versionOf = (name: string) =>
    JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
  const resultsFile = {
    meta: {
      date: new Date().toISOString(),
      machine: `${platform()} ${release()} (${arch()})`,
      node: process.version,
      rustFetch: versionOf("rust-fetch"),
      axios: versionOf("axios"),
      runs: RUNS,
      rounds: ROUNDS,
      scenarioParams: scenarios.map((s) => ({
        name: s.name,
        url: s.url,
        total: s.total,
        concurrent: s.concurrent,
        payloadBytes: s.url === "/small" ? Buffer.byteLength(SMALL) : s.url === "/large" ? Buffer.byteLength(LARGE) : BINARY.length,
      })),
    },
    scenarios: aggregate,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(resultsFile, null, 2));
  console.log(`\nRaw per-run data written to ${RESULTS_FILE}`);

  console.log("\nAggregate over all runs (req/s; ratios vs native fetch):\n");
  const rows = scenarios.map((s) => {
    const med = (name: string) => Math.round(median(aggregate[s.name][name]));
    const ratio = (name: string) => `${((median(aggregate[s.name][name]) / median(aggregate[s.name]["native fetch"])) * 100).toFixed(0)}%`;
    const wins = (name: string) =>
      aggregate[s.name][name].filter((v, i) => v > aggregate[s.name]["native fetch"][i]).length;
    return {
      Scenario: s.name,
      "native fetch": med("native fetch"),
      "rust-fetch": med("rust-fetch"),
      axios: med("axios (default)"),
      "axios+ka": med("axios (keepAlive)"),
      "rust/fetch": ratio("rust-fetch"),
      "axios/fetch": ratio("axios (default)"),
      "axios+ka/fetch": ratio("axios (keepAlive)"),
      "rust wins": `${wins("rust-fetch")}/${RUNS}`,
      "axios+ka wins": `${wins("axios (keepAlive)")}/${RUNS}`,
    };
  });
  console.table(rows);

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

run().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});