// stress.ts - open-loop fixed-rate + closed-loop sweep stress for the 4 HTTP clients.
//
// Main mode  : npx tsx stress.ts [TARGET_RPS] [DURATION_SECONDS]   (defaults 50000, 60)
//   Picks a free port and forks SERVER_WORKERS (default 6, env override) cluster workers
//   that share it, via cluster.setupPrimary({ exec: this file, execArgv: ["--import", "tsx"] })
//   + cluster.fork({ ROLE: "server", PORT }) (verified pattern, see deleted .scratch-cluster-test.ts).
//   Then spawns 4 isolated client worker processes (one per client library, so memory
//   attribution stays per-process), runs a multi-process raw node:http headroom probe,
//   prints a summary table and writes the results file (stress-results.json for a 15k
//   target; stress-results-<k>k.json otherwise).
// Worker mode: npx tsx stress.ts --worker <native|rust|axios-default|axios-keepalive>
//   (spawned by main; TARGET_RPS/DURATION_MS arrive via env) → warmup -> sustained open-loop
//   @target rps (cap 10k outstanding) -> closed-loop concurrency sweep. Prints ONE line:
//   "@@STRESS_RESULT@@{json}" on stdout (exactly); all diagnostics go to stderr.
//
// Spawn command (chosen): `process.execPath --expose-gc --import tsx <this-file> --worker <key>`
// with cwd = project root. "--import tsx" registers the tsx loader on plain node (tsx v4);
// "--expose-gc" enables global.gc for forced-GC memory sampling.

import http, { Agent } from "node:http";
import net from "node:net";
import cluster from "node:cluster";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { platform, release, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROJ_ROOT = dirname(fileURLToPath(import.meta.url));

// --- experiment constants ---------------------------------------------------
const DEFAULT_TARGET_RPS = 50_000; // npx tsx stress.ts [TARGET_RPS]
const DEFAULT_DURATION_MS = 60_000; // npx tsx stress.ts [TARGET_RPS] [DURATION_SECONDS]
let TARGET_RPS = DEFAULT_TARGET_RPS; // main: argv[2]; client workers: env.TARGET_RPS
let DURATION_MS = DEFAULT_DURATION_MS; // main: argv[3] seconds; client workers: env.DURATION_MS (ms)
const SERVER_WORKERS = Number(process.env.SERVER_WORKERS) || 6; // cluster server workers (main only)
const PROBE_PROCESSES = Number(process.env.PROBE_PROCESSES) || 4; // headroom probe child processes
const TICK_MS = 10; // TARGET_RPS/100 req/tick; fractional accumulator keeps the long-run rate exact
const MAX_OUTSTANDING = 10_000;
const DRAIN_TIMEOUT_MS = 30_000;
const SWEEP_LEVELS = [50, 100, 200, 500];
const SWEEP_DURATION_MS = 10_000;
const SWEEP_IDLE_MS = 2_000;
const WARMUP_N = 200;
const HEADROOM_MS = 15_000;
const HEADROOM_CONCURRENCY = 256;
const WORKER_TIMEOUT_MS = 300_000;
const clientKeys = ["native", "rust", "axios-default", "axios-keepalive"] as const;
type ClientKey = (typeof clientKeys)[number];

// --- payload + server (/small only, mirrors benchmark.ts) --------------------
const SMALL = JSON.stringify(
  Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
  })),
); // 534 B

// The /small request handler lives in the cluster server-worker branch (ROLE=server).

// --- shared helpers ----------------------------------------------------------
type Res = { status: number; body: unknown };
type ClientFn = (url: string) => Promise<Res>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a positive-number env/arg value, falling back to `d`. */
function numOr(raw: string | undefined, d: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
}

function gcNow() {
  try { (globalThis as { gc?: () => void }).gc?.(); } catch { /* no --expose-gc */ }
}

/** Nearest-rank percentile over an ascending-sorted array. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const mb = (bytes: number) => r1(bytes / 1024 / 1024);

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`phase timeout: ${label} (${ms}ms)`)), ms);
  });
  try { return await Promise.race([p, guard]); }
  finally { if (timer) clearTimeout(timer); }
}

const ok = (res: Res): boolean =>
  res.status === 200 && Array.isArray(res.body) && (res.body as unknown[]).length === 10;

// --- client factory (worker-mode only; dynamic imports isolate libs per process)
async function makeClient(key: ClientKey): Promise<ClientFn> {
  switch (key) {
    case "native":
      return async (url) => {
        const res = await fetch(url);
        return { status: res.status, body: await res.json() };
      };
    case "rust": {
      const { WasmClient } = await import("rust-fetch");
      const c = new WasmClient({ timeoutMs: 30_000 });
      return (url) => c.get(url) as Promise<Res>;
    }
    case "axios-default": {
      const { default: axios } = await import("axios");
      const c = axios.create({ timeout: 30_000, validateStatus: () => true });
      return async (url) => {
        const res = await c.get(url, { responseType: "json" });
        return { status: res.status, body: res.data };
      };
    }
    case "axios-keepalive": {
      const { default: axios } = await import("axios");
      const c = axios.create({
        timeout: 30_000,
        validateStatus: () => true,
        httpAgent: new Agent({ keepAlive: true, maxSockets: 128 }),
      });
      return async (url) => {
        const res = await c.get(url, { responseType: "json" });
        return { status: res.status, body: res.data };
      };
    }
  }
}

// --- phase A: warmup (unmeasured) ---------------------------------------------
async function warmup(get: ClientFn, url: string) {
  for (let i = 0; i < WARMUP_N; i++) {
    const res = await get(url);
    if (!ok(res)) throw new Error(`warmup verify failed at #${i}`);
  }
}

// --- phase B: sustained open-loop ---------------------------------------------
type SustainedResult = {
  scheduled: number;
  fired: number;
  completed: number;
  errors: number;
  skipped: number;
  achievedRps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  schedulerDriftP95Ms: number;
  drainMs: number;
  errorTypes: Record<string, number>;
  rssStartMB: number;
  rssPeakMB: number;
  rssEndMB: number;
  heapUsedEndMB: number;
};

async function sustainedPhase(get: ClientFn, url: string): Promise<SustainedResult> {
  gcNow();
  const rssStartMB = mb(process.memoryUsage().rss);
  let rssPeak = process.memoryUsage().rss;
  const memTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 500);

  const inFlight = new Set<number>();
  const lat: number[] = [];
  const drift: number[] = [];
  const errorTypes = new Map<string, number>();
  let scheduled = 0, fired = 0, skipped = 0, completed = 0, errors = 0, seq = 0;
  let firstDispatch = 0, lastCompletion = 0;

  const fire = () => {
    const t0 = performance.now();
    if (firstDispatch === 0) firstDispatch = t0;
    const id = seq++;
    inFlight.add(id);
    const settle = (t1: number, bad: boolean, err?: unknown) => {
      inFlight.delete(id);
      completed++;
      lat.push(t1 - t0);
      if (bad) {
        errors++;
        let key: string;
        if (err === undefined) key = "bad-response";
        else {
          const code = (err as { code?: string })?.code;
          const msg = err instanceof Error ? err.message : String(err);
          key = code ?? (msg.length > 60 ? msg.slice(0, 60) : msg);
        }
        errorTypes.set(key, (errorTypes.get(key) ?? 0) + 1);
      }
      lastCompletion = t1;
    };
    get(url).then(
      (res) => settle(performance.now(), !ok(res)),
      (e) => settle(performance.now(), true, e),
    );
  };

  // Fixed-rate scheduler: fire floor(acc) per tick, no awaiting; skip when capped.
  let acc = 0;
  const idealStart = performance.now();
  let nextTick = idealStart + TICK_MS;
  while (performance.now() - idealStart < DURATION_MS) {
    const wait = nextTick - performance.now();
    if (wait > 0) await sleep(wait);
    drift.push(performance.now() - nextTick); // scheduler lateness
    acc += (TARGET_RPS * TICK_MS) / 1000; // 150
    const n = Math.floor(acc);
    acc -= n;
    scheduled += n;
    let i = 0;
    while (i < n && inFlight.size < MAX_OUTSTANDING) {
      fire();
      i++;
    }
    fired += i;
    skipped += n - i;
    nextTick += TICK_MS;
  }

  // Stop firing; wait up to 30 s for outstanding requests to settle.
  const drainStart = performance.now();
  while (inFlight.size > 0 && performance.now() - drainStart < DRAIN_TIMEOUT_MS) await sleep(10);
  const drainMs = performance.now() - drainStart;

  clearInterval(memTimer);
  const memEnd = process.memoryUsage();
  const sorted = lat.slice().sort((a, b) => a - b);
  const driftSorted = drift.slice().sort((a, b) => a - b);
  const spanSec = lastCompletion > 0 ? (lastCompletion - firstDispatch) / 1000 : 0;
  return {
    scheduled,
    fired,
    completed,
    errors,
    skipped,
    achievedRps: r1(spanSec > 0 ? completed / spanSec : 0),
    p50: r2(pct(sorted, 0.5)),
    p95: r2(pct(sorted, 0.95)),
    p99: r2(pct(sorted, 0.99)),
    max: r2(sorted[sorted.length - 1] ?? 0),
    mean: r2(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0),
    schedulerDriftP95Ms: r2(pct(driftSorted, 0.95)),
    drainMs: r1(drainMs),
    errorTypes: Object.fromEntries(errorTypes),
    rssStartMB,
    rssPeakMB: mb(rssPeak),
    rssEndMB: mb(memEnd.rss),
    heapUsedEndMB: mb(memEnd.heapUsed),
  };
}

// --- phase C: closed-loop concurrency sweep ------------------------------------
type SweepEntry = { concurrency: number; rps: number; p50: number; p95: number; p99: number; errors: number };

async function sweepOnce(get: ClientFn, url: string, concurrency: number): Promise<SweepEntry> {
  gcNow();
  const lat: number[] = [];
  let errors = 0;
  const start = performance.now();
  const deadline = start + SWEEP_DURATION_MS;
  const slot = async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await get(url);
        const t1 = performance.now();
        lat.push(t1 - t0);
        if (!ok(res)) errors++;
      } catch {
        lat.push(performance.now() - t0);
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => slot()));
  const elapsed = (performance.now() - start) / 1000;
  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    concurrency,
    rps: r1(elapsed > 0 ? lat.length / elapsed : 0),
    p50: r2(pct(sorted, 0.5)),
    p95: r2(pct(sorted, 0.95)),
    p99: r2(pct(sorted, 0.99)),
    errors,
  };
}

// --- worker mode ---------------------------------------------------------------
async function runWorker(key: ClientKey) {
  const get = await makeClient(key);
  const url = `${process.env.BASE_URL}/small`;
  console.error(`[worker] ${key} warmup x${WARMUP_N}...`);
  await withTimeout(warmup(get, url), 30_000, "warmup");
  console.error(`[worker] ${key} sustained ${TARGET_RPS} rps x ${DURATION_MS / 1000}s...`);
  const sustained = await withTimeout(sustainedPhase(get, url), DURATION_MS + DRAIN_TIMEOUT_MS + 5_000, "sustained");
  const sweep: SweepEntry[] = [];
  for (let i = 0; i < SWEEP_LEVELS.length; i++) {
    console.error(`[worker] ${key} sweep @${SWEEP_LEVELS[i]}...`);
    sweep.push(await withTimeout(sweepOnce(get, url, SWEEP_LEVELS[i]), 30_000, `sweep@${SWEEP_LEVELS[i]}`));
    if (i < SWEEP_LEVELS.length - 1) await sleep(SWEEP_IDLE_MS);
  }
  // Must bypass the console.log->stderr redirect below (kept stdout clean): write to
  // the real stdout stream directly so the parent can parse the result line.
  process.stdout.write(`@@STRESS_RESULT@@${JSON.stringify({ client: key, sustained, sweep })}\n`);
}

// --- main mode: worker isolation + headroom ------------------------------------
type WorkerPayload = { client: string; sustained: SustainedResult; sweep: SweepEntry[]; failed: false };
type SpawnOutcome = WorkerPayload | { failed: true; timedOut: boolean; stderrTail: string };

async function spawnWorker(key: ClientKey, base: string): Promise<SpawnOutcome> {
  // Spawn: node --expose-gc --import tsx <this file> --worker <key>  (cwd = project root)
  const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), "--worker", key], {
    cwd: PROJ_ROOT,
    env: { ...process.env, BASE_URL: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d));
  child.stderr.on("data", (d: Buffer) => (stderr += d));
  let timedOut = false;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve(null);
    }, WORKER_TIMEOUT_MS);
    child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
  const line = stdout.split("\n").filter((l) => l.startsWith("@@STRESS_RESULT@@")).pop();
  if (code !== 0 || !line) return { failed: true, timedOut, stderrTail: stderr.slice(-2000) };
  const payload = JSON.parse(line.slice("@@STRESS_RESULT@@".length)) as WorkerPayload;
  return { ...payload, failed: false };
}

/** Each probe child runs raw node:http + a keep-alive Agent(256) in a closed loop for
 *  HEADROOM_MS and prints exactly one JSON line: {"rps":...,"p99":...}. */
const PROBE_SCRIPT = `
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const url = process.env.BASE_URL + "/small";
const agent = new http.Agent({ keepAlive: true, maxSockets: ${HEADROOM_CONCURRENCY} });
const lat = [];
const start = performance.now();
const deadline = start + ${HEADROOM_MS};
const slot = () => new Promise((resolve) => {
  const t0 = performance.now();
  http.get(url, { agent }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const t1 = performance.now();
      if (res.statusCode === 200 && Buffer.concat(chunks).length > 0) lat.push(t1 - t0);
      resolve();
    });
  }).on("error", () => { lat.push(performance.now() - t0); resolve(); });
});
(async () => {
  while (performance.now() < deadline) await slot();
  agent.destroy();
  const elapsed = (performance.now() - start) / 1000;
  const sorted = lat.slice().sort((a, b) => a - b);
  const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.99 * sorted.length) - 1))] : 0;
  process.stdout.write(JSON.stringify({ rps: Math.round((lat.length / elapsed) * 10) / 10, p99: Math.round(p99 * 100) / 100 }) + "\\n");
})();
`;

type ProbeResult = { rps: number; p99: number };

/** Stop cluster server workers gracefully (disconnect -> workers exit), SIGKILL stragglers. */
async function stopServerWorkers(): Promise<void> {
  if (!cluster.isPrimary) return;
  try {
    cluster.disconnect(); // server workers exit on their 'disconnect' handler
  } catch { /* already disconnected */ }
  await sleep(2_000);
  const workers = cluster.workers ?? {};
  for (const id of Object.keys(workers)) {
    const w = workers[id];
    if (w && !w.isDead()) {
      console.error(`[primary] SIGKILL straggler server worker ${w.process.pid}`);
      w.kill("SIGKILL");
    }
  }
}

/** Multi-process raw node:http ceiling probe (runs in main, after client workers). */
async function headroomProbe(base: string): Promise<{ rps: number; p99: number; concurrency: number; durationMs: number; processes: number }> {
  const procs = Array.from({ length: PROBE_PROCESSES }, () =>
    spawn(process.execPath, ["-e", PROBE_SCRIPT], {
      env: { ...process.env, BASE_URL: base },
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const run = (child: ChildProcess): Promise<ProbeResult | null> => {
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d));
    return new Promise((resolve) => {
      child.on("close", (code) => {
        if (code !== 0) return resolve(null);
        const line = stdout.split("\n").filter((l) => l.startsWith("{")).pop();
        try {
          resolve(line ? (JSON.parse(line) as ProbeResult) : null);
        } catch {
          resolve(null);
        }
      });
      child.on("error", () => resolve(null));
    });
  };
  let timedOut = false;
  const results = (await Promise.race<Array<ProbeResult | null>>([
    Promise.all(procs.map(run)),
    sleep(HEADROOM_MS + 20_000).then(() => {
      timedOut = true;
      return procs.map(() => null);
    }),
  ])) as Array<ProbeResult | null>;
  if (timedOut) for (const c of procs) c.kill("SIGKILL");
  const ok = results.filter((r): r is ProbeResult => r !== null);
  return {
    rps: r1(ok.reduce((a, r) => a + r.rps, 0)),
    p99: ok.length ? r2(Math.max(...ok.map((r) => r.p99))) : 0,
    concurrency: HEADROOM_CONCURRENCY * PROBE_PROCESSES,
    durationMs: HEADROOM_MS,
    processes: PROBE_PROCESSES,
  };
}

async function runMain() {
  try {
    // Pick a free port, then fork SERVER_WORKERS cluster workers that share it (SO_REUSEPORT).
    const port = await new Promise<number>((resolve) => {
      const t = net.createServer();
      t.listen(0, "127.0.0.1", () => {
        const p = (t.address() as net.AddressInfo).port;
        t.close(() => resolve(p));
      });
    });

    cluster.setupPrimary({
      exec: fileURLToPath(import.meta.url),
      execArgv: ["--import", "tsx"],
    });
    const allServerReady = new Promise<void>((resolve, reject) => {
      let readyCount = 0;
      for (let i = 0; i < SERVER_WORKERS; i++) {
        const w = cluster.fork({ ROLE: "server", PORT: String(port) });
        w.on("message", (m) => {
          if ((m as { type?: string }).type === "listening" && ++readyCount === SERVER_WORKERS) resolve();
        });
        w.on("exit", (code, sig) => {
          if (readyCount < SERVER_WORKERS) reject(new Error(`server worker ${w.process.pid} exited before ready (code=${code} sig=${sig})`));
        });
      }
    });
    await withTimeout(allServerReady, 30_000, "server workers ready");

    const base = `http://127.0.0.1:${port}`;
    console.log(
      `stress: ${base} · target ${TARGET_RPS} rps x ${DURATION_MS / 1000}s · tick ${TICK_MS}ms · sweep ${SWEEP_LEVELS.join("/")} · 4 isolated workers · ${SERVER_WORKERS} server workers\nstarting workers...`,
    );

    const results = {} as Record<ClientKey, SpawnOutcome>;
    // Sequential, one worker at a time: parallel workers would share the server and the
    // CPU, so per-client latency/throughput would measure cross-client contention, not
    // the client engine.
    // CLIENTS env: comma-separated subset/order of client keys (default: all, canonical
    // order) — lets overload experiments isolate run-order confounds (e.g. TIME_WAIT
    // port debt inherited from a previous worker's connection storm).
    const order = (process.env.CLIENTS ?? clientKeys.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ClientKey => (clientKeys as readonly string[]).includes(s));
    const cooldownMs = Number(process.env.COOLDOWN_MS ?? 0);
    for (const k of order) {
      results[k] = await spawnWorker(k, base);
      if (k !== order[order.length - 1] && cooldownMs > 0) {
        console.log(`cooling down ${cooldownMs / 1000}s before next worker (TIME_WAIT clearance)...`);
        await sleep(cooldownMs);
      }
    }
    console.log("workers done; running headroom probe...");
    const headroom = await headroomProbe(base);

    const versionOf = (name: string) =>
      JSON.parse(readFileSync(join(PROJ_ROOT, `node_modules/${name}/package.json`), "utf8")).version;
    const report = {
      meta: {
        date: new Date().toISOString(),
        machine: `${platform()} ${release()} (${arch()})`,
        node: process.version,
        rustFetch: versionOf("rust-fetch"),
        axios: versionOf("axios"),
        targetRps: TARGET_RPS,
        durationMs: DURATION_MS,
        tickMs: TICK_MS,
        sweep: SWEEP_LEVELS,
        serverWorkers: SERVER_WORKERS,
      },
      headroom,
      clients: results,
    };
    const resultsFile =
      TARGET_RPS === 15_000 ? "stress-results.json" : `stress-results-${Math.round(TARGET_RPS / 1000)}k.json`;
    writeFileSync(join(PROJ_ROOT, resultsFile), JSON.stringify(report, null, 2));
    console.log(`\nresults written to ${resultsFile}`);

    console.log(
      `\nHeadroom (raw node:http, ${headroom.processes} procs x ${HEADROOM_CONCURRENCY} conns): ${headroom.rps} rps, p99 ${headroom.p99} ms — caveat for whether ${TARGET_RPS} rps stresses clients or server\n`,
    );
    if (headroom.rps < TARGET_RPS * 1.1) {
      console.error(
        `\n!!! WARNING: headroom probe total ${headroom.rps} rps < 1.1x target (${Math.round(TARGET_RPS * 1.1)} rps) — clients may be bottlenecked by the server!\n`,
      );
    }

    const rows = order.map((k) => {
      const r = results[k];
      if (r.failed) return { client: k, status: "FAILED", timedOut: r.timedOut, stderrTail: r.stderrTail.slice(0, 80) };
      const s = r.sustained;
      const top = r.sweep[r.sweep.length - 1];
      return {
        client: k,
        achievedRps: s.achievedRps,
        "%ofTarget": Math.round((s.achievedRps / TARGET_RPS) * 100),
        errors: s.errors,
        skipped: s.skipped,
        p50Ms: s.p50,
        p95Ms: s.p95,
        p99Ms: s.p99,
        maxMs: s.max,
        driftP95Ms: s.schedulerDriftP95Ms,
        drainMs: s.drainMs,
        rssPeakMB: s.rssPeakMB,
        sweep500: `${top.rps} rps @ p99 ${top.p99}ms`,
      };
    });
    console.table(rows);

    if (order.some((k) => results[k].failed)) {
      console.error("one or more workers failed");
      process.exitCode = 1;
    }
  } finally {
    await stopServerWorkers(); // no orphan server workers, even on error paths
  }
}

// --- entry ---------------------------------------------------------------------
const workerIdx = process.argv.indexOf("--worker");
if (workerIdx !== -1) {
  // Client worker mode: spawned by main; target/duration arrive via env.
  TARGET_RPS = numOr(process.env.TARGET_RPS, DEFAULT_TARGET_RPS);
  DURATION_MS = numOr(process.env.DURATION_MS, DEFAULT_DURATION_MS);
  console.log = (...a: unknown[]) => console.error("[worker:log]", ...a); // keep stdout clean
  const key = process.argv[workerIdx + 1] as ClientKey;
  console.error(`[worker] ${key} starting (node ${process.version})`);
  runWorker(key)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`[worker] ${key} FAILED:`, e instanceof Error ? e.stack : e);
      process.exit(1);
    });
} else if (process.env.ROLE === "server") {
  // Cluster server worker: serve /small on the shared port (forked by main via cluster).
  const server = http.createServer((req, res) => {
    if (req.url === "/small") {
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(SMALL) });
      res.end(SMALL);
    } else {
      res.writeHead(404).end();
    }
  });
  const port = Number(process.env.PORT);
  server.listen(port, "127.0.0.1", () => {
    process.send?.({ type: "listening" }); // signal readiness to the primary
  });
  server.on("error", (e) => {
    console.error(`[server-worker ${process.pid}] listen error on ${port}:`, e.message);
    process.exit(1);
  });
  process.on("disconnect", () => process.exit(0)); // primary asked us to stop
} else if (cluster.isPrimary) {
  // Main mode: npx tsx stress.ts [TARGET_RPS] [DURATION_SECONDS]
  const rpsArg = Number(process.argv[2]);
  const durArg = Number(process.argv[3]);
  TARGET_RPS = Number.isFinite(rpsArg) && rpsArg > 0 ? Math.round(rpsArg) : DEFAULT_TARGET_RPS;
  DURATION_MS = Number.isFinite(durArg) && durArg > 0 ? Math.round(durArg * 1000) : DEFAULT_DURATION_MS;
  process.env.TARGET_RPS = String(TARGET_RPS); // pass through to client worker children
  process.env.DURATION_MS = String(DURATION_MS);
  runMain().catch((e) => {
    console.error("stress failed:", e);
    process.exit(1);
  });
} else {
  console.error("unexpected role");
  process.exit(2);
}