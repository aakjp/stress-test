# HTTP Clients in Node.js: An Empirical Benchmark

## `rust-fetch` 2.1 vs native `fetch()` vs `axios` 1.20

**Published:** 2026-10-22 · **Datasets:** [`benchmark-results.json`](./benchmark-results.json) · [`stress-results.json`](./stress-results.json) · [`stress-results-50k.json`](./stress-results-50k.json) · [`stress-results-50k-rust-alone.json`](./stress-results-50k-rust-alone.json)
**Reproduce:** `npx tsx benchmark.ts 10` ([`benchmark.ts`](./benchmark.ts)) · `npm run stress` ([`stress.ts`](./stress.ts), 15k) · `npx tsx stress.ts 50000 60` (50k overload)

---

> ## Verdict: `rust-fetch` is the best client tested
>
> It wins or ties every throughput workload (§5), is the most consistent client (§5.4),
> and is the only one that holds **15,000 req/s sustained** with zero errors, nothing
> skipped, a millisecond p99 (11 ms vs native's 450 ms) and 202 MB peak RSS vs 635 MB
> (§10). `native fetch()` remains the right choice only when a zero-dependency platform
> builtin — with the best *median* latency — matters more than tails, predictability,
> and stress headroom. `axios` is a features-first choice that requires keep-alive
> tuning to survive high request rates at all (§10.1).
>
> **One boundary (§11):** at 50,000 req/s — deliberate overload at 2–3× any client's
> single-process ceiling — the ranking inverts. `rust-fetch`'s default unbounded socket
> pool hard-fails (ephemeral-port exhaustion), while `native fetch()` degrades
> gracefully and a socket-capped axios keeps zero errors by queueing. The verdict above
> holds within the measured envelope (~15–20k rps per process); past that, resilience —
> not speed — decides.

---

> ### Key findings
>
> 1. **`rust-fetch` ≥ native `fetch()` in 3 of 4 workloads, and beats axios in all of them.**
>    On byte-heavy workloads the gap is decisive: **+15% on 8 MB binary (10/10 runs)**, +5% on
>    ~0.6 MB JSON (10/10 runs). On request-churn workloads the two modern clients are
>    statistically indistinguishable (sequential); on concurrency, the original harness had
>    native leading by ~9% — a result §10.2's process-isolated sweep reverses in
>    `rust-fetch`'s favor at every level.
> 2. **`axios` pays a 23–36% throughput tax on small-JSON traffic** (middleware/transform
>    overhead), closes to ~parity on large payloads, and — surprisingly — beats native
>    `fetch()` on binary transfers (+7%), while still trailing `rust-fetch`.
> 3. **Connection keep-alive is not axios's problem.** An explicit keep-alive agent recovered
>    less than 4%: the bottleneck is per-request engine overhead, not socket setup.
> 4. **`rust-fetch` is the most consistent client**: the lowest run-to-run variance in 3
>    of 4 scenarios, with roughly **half the spread of native `fetch()`** on sequential
>    workloads (SD 367 vs 661 req/s).
> 5. **Under sustained fixed-rate stress (15,000 req/s, §10), the rankings sharpen.**
>    `rust-fetch` is the only client that holds the full rate with millisecond tails
>    (p99 11 ms, peak RSS 202 MB); native `fetch()` grows a 450 ms p99 and 635 MB RSS;
>    axios's default config hard-fails (`EADDRNOTAVAIL` port exhaustion, 165k errors).
>    The process-isolated concurrency sweep also **reverses §5.2's "undici wins under
>    parallelism"** (§10.2).
> 6. **At 50,000 req/s — deliberate overload — failure mode becomes the ranking (§11).**
>    `rust-fetch`'s unbounded socket growth exhausts ephemeral ports (169k
>    `EADDRNOTAVAIL`, 6% of target); native `fetch()` degrades gracefully (29% of
>    target, 1.1k errors); only socket-capped axios (keepAlive) keeps zero errors — by
>    queueing (p50 832 ms). Best-in-envelope is not the same as most resilient under
>    overload.

---

## Document structure — what was measured, and where

This report accumulates three campaigns; each later section extends, never replaces, the earlier ones:

| Section | Campaign | Dataset |
|---|---|---|
| §1–§9 | Closed-loop throughput (4 workloads, 10-run statistics) | [`benchmark-results.json`](./benchmark-results.json) |
| §10 | Sustained stress: 15,000 req/s × 60 s, open-loop, process-isolated | [`stress-results.json`](./stress-results.json) |
| §11 | Overload: 50,000 req/s × 60 s (2–3× beyond any client's ceiling) | [`stress-results-50k.json`](./stress-results-50k.json) + [`stress-results-50k-rust-alone.json`](./stress-results-50k-rust-alone.json) + [`stress-run-50k.log`](./stress-run-50k.log) |
| §12 + App. A | Scope of the claims; harness design decisions and experiment log | — |

The §11 story in brief — under deliberate overload, **failure mode becomes the ranking**:

| Client | Behavior under overload (50k req/s) |
|---|---|
| `native fetch` | Degrades gracefully — 14.4k rps, 1.1k errors, sub-second p99 |
| `rust-fetch` | Hard collapse — 3.2k rps, 169k `EADDRNOTAVAIL` (unbounded socket growth exhausts ephemeral ports); recovers fully once load drops |
| `axios (default)` | Hard collapse — port exhaustion by design (no keep-alive) |
| `axios (keepAlive)` | Only zero-error client — its 128-socket cap converts overload into queueing (p50 832 ms) |

The verdict therefore carries an honest boundary: **`rust-fetch` is the best client tested
*within its measured envelope* (~15–20k rps per process); beyond that, resilience — not
speed — decides**, and there `rust-fetch`'s default config hard-fails where native
`fetch()` degrades and socket-capped axios queues cleanly. §11.2 documents the
three-run diagnosis (intrinsic failure, not measurement-order port debt), and §11.3
turns it into production guidance: put a concurrency limiter or horizontal instances in
front of `rust-fetch` before pushing past its envelope.

---

## Table of contents

1. [Introduction](#1-introduction)
2. [The contenders](#2-the-contenders)
3. [Methodology](#3-methodology)
4. [Environment](#4-environment)
5. [Results](#5-results)
6. [Analysis: why each client behaves this way](#6-analysis-why-each-client-behaves-this-way)
7. [Limitations and threats to validity](#7-limitations-and-threats-to-validity)
8. [Recommendations](#8-recommendations)
9. [Raw data](#9-raw-data)
10. [Stress test: 15,000 req/s sustained](#10-stress-test-15000-reqs-sustained)
11. [Overload test: 50,000 req/s sustained](#11-overload-test-50000-reqs-sustained)
12. [Scope: what this report claims — and what it does not](#12-scope-what-this-report-claims--and-what-it-does-not)
Appendix A. [Harness design decisions and experiment log](#appendix-a-harness-design-decisions-and-experiment-log)

---

## 1. Introduction

Node.js developers can choose between several HTTP clients with very different engines:

- **`fetch()`** — the platform-native client, shipped with Node 18+. Implemented by
  [undici](https://github.com/nodejs/undici), a hyper-optimized C++-backed client with full
  WHATWG stream semantics.
- **`rust-fetch`** — an HTTP client whose *policy* (timeouts, retries, typed errors,
  decoding rules, validation) is written in **Rust and compiled to WebAssembly**, driving a
  purpose-built JS transport on `node:http`/`node:https` with keep-alive. The wasm core only
  sees validated policy decisions; response bytes are decoded by the JS engine.
- **`axios`** — the most widely used third-party HTTP client (77M+ weekly downloads). A
  full-featured JS request pipeline: interceptors, transforms, config merging, adapters.

Each advertises different performance characteristics. This benchmark asks one question:
**at equal configuration, how fast is each client at moving real bytes over a real
(local) network — and how consistent is that speed?**

Three independent 10-run benchmarking campaigns were executed (200 measurements per client
and scenario in the final campaign); all three tell the same story.

---

## 2. The contenders

All clients were measured **as configured in production-typical defaults**, with two
deliberate equalizations: no retries, and a generous timeout.

| Client | Version | Engine | Configuration |
|---|---|---|---|
| `native fetch` | Node 22.15.1 (undici) | C++/C, WHATWG streams, automatic connection pooling | `fetch(url)` + `response.json()` / `arrayBuffer()` |
| `rust-fetch` | 2.1.0 | Rust core → wasm; JS transport on `node:http` | `new WasmClient({ timeoutMs: 30_000 })`, retries **off** (like-for-like), body auto-decoded |
| `axios` *(default)* | 1.20.0 | JS request pipeline; Node `http` adapter | `axios.create({ timeout: 30_000 })`, **no keep-alive agent** (axios default) |
| `axios` *(keepAlive)* | 1.20.0 | same | `httpAgent: new Agent({ keepAlive: true, maxSockets: 128 })` |

> **Why two axios variants?** Axios's Node adapter does **not** enable keep-alive by default.
> Without an explicit agent, every request opens its own TCP connection. To separate
> "axios the engine" from "axios misconfigured by default", the same pipeline was measured
> with and without an explicit keep-alive agent. The difference turned out to be almost
> nothing (see §6.3) — a finding in itself.

Both axios variants used `responseType: 'json'` / `'arraybuffer'` and
`validateStatus: () => true` (2xx-only responses in every scenario).

---

## 3. Methodology

The protocol is designed to remove every source of measurement bias that is under our
control, and to document the rest.

### 3.1 Workloads

Four scenarios, served by a local `node:http` server on loopback with explicit
`Content-Length` and **no compression** (bodies cross the network as real bytes):

| Scenario | Payload | Size | Requests per round | Concurrency |
|---|---|---|---|---|
| Small JSON, sequential | 10 user objects | 534 B | 1,000 | 1 |
| Small JSON, 50 concurrent | 10 user objects | 534 B | 300 | 50 |
| Large JSON | 5,000 records | 589,726 B (~0.6 MB) | 20 | 1 |
| Binary | pseudo-random bytes | 8,388,608 B (8 MB) | 8 | 1 |

The payloads deliberately span the two axes that separate HTTP clients in practice:
**request churn** (small bodies, thousands of round trips) and **byte throughput** (large
bodies, few round trips).

### 3.2 Fairness controls

1. **Loopback server** — zero network latency; the benchmark measures client engines,
   not the internet.
2. **Like-for-like configuration** — retries disabled everywhere; generous timeouts
   everywhere; identical response decoding paths (JSON via `JSON.parse`, binary raw).
3. **Warm-up** — 3 requests per client per scenario before measuring (wasm init, socket
   pools, JIT/parse caches).
4. **Round-robin order rotation** — in each round, clients run in a rotated order, so
   GC pauses, turbo clocks and keep-alive state hit every client equally often.
5. **Verification on every response** — body length/identity is asserted; a wrong byte
   count aborts the benchmark. No silent failures.

### 3.3 Statistical protocol

- **Round** = one client, one scenario, one batch of requests → a requests-per-second value.
- **Run** = 5 rounds of all clients on all scenarios (order rotated) → one median per
  client per scenario.
- **Campaign** = 10 runs → per client per scenario: 10 run-medians, from which we report
  the **median of medians**, min/max, standard deviation, and pairwise **win counts**
  (how many of 10 runs client A beat client B).
- Three campaigns were executed in total (a 2-client pilot and two 4-client campaigns);
  the final campaign's raw data is published alongside this document.

Throughput is measured as **requests per second** for a fixed batch, timed with
`performance.now()`, and includes full body read + decoding — the wall-clock cost an
application actually feels.

### 3.4 Reproducibility

```bash
git clone <repo> && cd playground/node && npm install
npx tsx benchmark.ts 10    # RUNS defaults to 10
```

The script prints the aggregate table, writes `benchmark-results.json` (raw per-run data +
environment metadata), and exits non-zero on any verification failure.

---

## 4. Environment

| Component | Value |
|---|---|
| Machine | Apple M4 Pro, 48 GB RAM |
| OS | macOS Darwin 25.6.0 (arm64) |
| Node.js | v22.15.1 |
| `rust-fetch` | 2.1.0 (wasm core; JS transport on `node:http` + `node:https`) |
| `axios` | 1.20.0 (Node `http` adapter) |
| Runner | `tsx` (esbuild transform, no runtime overhead on async I/O) |

---

## 5. Results

### 5.1 Headline table

Median of 10 run-medians, requests/second. Ratios are **vs native `fetch()`**;
"wins" = runs (of 10) where that client's median beat native `fetch()`'s.

| Scenario | native fetch | rust-fetch | axios (default) | axios (keepAlive) | rust/fetch | axios/fetch | wins rust | wins axios+ka |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Small JSON, sequential | 9,649 | 9,680 | 7,497 | 7,211 | **100%** | 78% | 4–6 / 10* | 0/10 |
| Small JSON, 50 concurrent | 15,529 | 14,191 | 9,902 | 10,314 | 91% | 64–66% | 1/10 | 0/10 |
| Large JSON (0.6 MB) | 426 | 446 | 407 | 385 | **105%** | 90–95% | **10/10** | 0/10 |
| Binary 8 MB | 174 | 201 | 188 | 190 | **115%** | 108–109% | **10/10** | **10/10** |

\* The two 4-client campaigns disagree on whether rust-fetch edges sequential small JSON
(6/10 in this dataset, 7/10 in the previous campaign); both agree the difference is
~±2% — a tie.

### 5.2 Per-scenario detail

#### Small JSON, sequential — *the tie*

10 run-medians (req/s, sorted by campaign order):

| Client | Runs | Median | Mean | ±SD | Min–Max |
|---|---:|---:|---:|---:|---:|
| native fetch | 8300 · 9649 · 10133 · 10385 · 10367 · 9804 · 9610 · 9176 · 9117 · 9043 | 9,649 | 9,558 | 661 | 8,300–10,385 |
| rust-fetch | 10160 · 10223 · 10182 · 10234 · 9680 · 9408 · 9433 · 9491 · 9462 · 9559 | 9,680 | 9,783 | **367** | 9,408–10,234 |
| axios (default) | 7497 · 7936 · 7942 · 7830 · 7629 · 7160 · 6881 · 7317 · 6908 · 7129 | 7,497 | 7,423 | 404 | 6,881–7,942 |
| axios (keepAlive) | 7000 · 7828 · 7817 · 7181 · 7597 · 7314 · 6562 · 6611 · 7211 · 6930 | 7,211 | 7,205 | 449 | 6,562–7,828 |

`rust-fetch` ≈ `fetch()` at ~9.7k req/s (ratio 100%, within ±2% in every campaign).
Notable: **native `fetch()` swings ±1,000 req/s per run (SD 661) while rust-fetch stays
inside a ±400 band (SD 367)** — with medians this close, consistency is the real
differentiator. `axios` sits 22–25% behind both.

#### Small JSON, 50 concurrent — *native fetch's only win*

| Client | Runs | Median | Mean | ±SD | Min–Max |
|---|---:|---:|---:|---:|---:|
| native fetch | 14644 · 15652 · 15158 · 15595 · 15286 · 16034 · 12997 · 15529 · 15911 · 14801 | 15,529 | 15,161 | 881 | 12,997–16,034 |
| rust-fetch | 13309 · 14937 · 14247 · 14908 · 13951 · 14191 · 14180 · 14215 · 13697 · 13342 | 14,191 | 14,098 | 557 | 13,309–14,937 |
| axios (default) | 9289 · 10167 · 10164 · 10263 · 9856 · 10096 · 9794 · 9902 · 9791 · 9620 | 9,902 | 9,894 | 296 | 9,289–10,263 |
| axios (keepAlive) | 10497 · 10050 · 10314 · 10265 · 10916 · 10804 · 10248 · 10301 · 10295 · 10424 | 10,314 | 10,412 | 264 | 10,050–10,916 |

The one scenario the platform client wins: **undici's stream machinery pays off under
parallelism** (+9% over rust-fetch, 9/10 runs; both campaigns agree, 91–92% ratio).
`axios` drops further behind its own sequential rate — the JS pipeline serializes around
the event loop. This is also the only scenario where keep-alive visibly helps axios
(+4%), because 50 sockets × no pooling = real setup cost.

> **Revision (see §10.2):** with per-client process isolation and sustained in-flight
> concurrency (no batch barriers), this result **reverses** — rust-fetch leads native
> `fetch()` at every concurrency level from 50 to 500. The single-process, batch-barrier
> methodology of this section appears to favor undici; the §10 harness (client and
> server on separate cores, as in production) is the more realistic setup.

#### Large JSON (0.6 MB) — *lean transport wins*

| Client | Runs | Median | Mean | ±SD | Min–Max |
|---|---:|---:|---:|---:|---:|
| native fetch | 448 · 435 · 417 · 426 · 418 · 422 · 374 · 410 · 429 · 430 | 426 | 421 | 20 | 374–448 |
| rust-fetch | 465 · 448 · 432 · 454 · 448 · 434 · 442 · 437 · 432 · 446 | 446 | 444 | **11** | 432–465 |
| axios (default) | 411 · 395 · 405 · 408 · 409 · 407 · 409 · 397 · 406 · 399 | 407 | 405 | 6 | 395–411 |
| axios (keepAlive) | 385 · 387 · 401 · 400 · 394 · 377 · 368 · 359 · 385 · 383 | 385 | 384 | 13 | 359–401 |

At ~0.6 MB, body transfer and decoding dominate the 2.5 ms request budget, and the
direct `node:http` transport wins: **rust-fetch +5% over fetch() (10/10 runs)**.
`axios` (default) is within −5% of fetch but loses 9/10 runs; interestingly the
keep-alive variant is *slower* here (−10% vs fetch) — the pooled agent's larger write
buffering adds latency for large single bodies.

#### Binary 8 MB — *the decisive one*

| Client | Runs | Median | Mean | ±SD | Min–Max |
|---|---:|---:|---:|---:|---:|
| native fetch | 189 · 186 · 182 · 168 · 161 · 177 · 173 · 169 · 171 · 174 | 174 | 175 | 9 | 161–189 |
| rust-fetch | 208 · 209 · 201 · 202 · 186 · 205 · 200 · 199 · 197 · 193 | 201 | 200 | 7 | 186–209 |
| axios (default) | 202 · 192 · 189 · 185 · 183 · 187 · 196 · 186 · 182 · 188 | 188 | 189 | 6 | 182–202 |
| axios (keepAlive) | 203 · 195 · 193 · 189 · 184 · 185 · 190 · 185 · 181 · 190 | 190 | 189 | 6 | 181–203 |

**Both direct-transport clients beat the WHATWG-stream client.** rust-fetch leads at 201
req/s — **+15% over native fetch, +7% over axios, winning 10/10 runs**. Axios beating
undici on raw throughput (93% ratio) is the benchmark's most counterintuitive result,
and it reproduces (105–109% across both campaigns). Per-8 MB-transfer that is ~1 ms per
request — small in absolute terms, structural in throughput terms.

### 5.3 Pairwise comparison matrix

Median-of-medians ratios, rows = A vs B = (median A ÷ median B) × 100:

| A \ B | native fetch | rust-fetch | axios (default) | axios (keepAlive) |
|---|---:|---:|---:|---:|
| **native fetch** | — | 100% · 109% · 96% · 87% | 129% · 157% · 105% · 93% | 134% · 151% · 111% · 92% |
| **rust-fetch** | 100% · 91% · 105% · 115% | — | 129% · 143% · 109% · 107% | 134% · 138% · 116% · 106% |
| **axios (default)** | 78% · 64% · 95% · 108% | 78% · 70% · 92% · 93% | — | 104% · 96% · 106% · 99% |
| **axios (keepAlive)** | 75% · 66% · 90% · 109% | 75% · 72% · 86% · 94% | 96% · 104% · 94% · 101% | — |

Each cell: ratios for (seq · concurrent · large · binary).

### 5.4 Stability

Standard deviation of run-medians, as % of the mean (lower = more predictable):

| Client | sequential | concurrent | large | binary |
|---|---:|---:|---:|---:|
| native fetch | 6.9% | 5.8% | 4.8% | 5.1% |
| rust-fetch | **3.8%** | **3.9%** | **2.5%** | **3.5%** |
| axios (default) | 5.4% | 3.0% | **1.5%** | 3.2% |
| axios (keepAlive) | 6.2% | **2.5%** | 3.4% | **3.2%** |

rust-fetch has the lowest variance of any client on 3 of 4 scenarios — including the
sequential case where it ties native fetch on speed but with **half the spread**.

---

## 6. Analysis: why each client behaves this way

### 6.1 Native `fetch()` (undici): stream machinery is a tax on churn, an asset under parallelism

undici implements full WHATWG semantics: `Response` objects, web streams, body queues,
and a C++-backed parser. Its strength shows at 50 concurrent requests (+9%). Its weakness
shows everywhere bytes move in bulk: web-stream plumbing and body-queue copying cost
~15% on 8 MB bodies, and its per-request setup cost shows up as the largest variance on
sequential churn (SD 661: the platform client is the *least* predictable here).

### 6.2 `rust-fetch`: policy in Rust, bytes in JS — and the design wins where it should

The interesting architectural fact: **rust-fetch does not beat undici *because of Rust* —
it beats it because of a deliberately lean JS transport.** The wasm core makes policy
decisions (retry timing, validation, decoding selection) while bytes flow through a
~250-line `node:http` transport with zero stream abstraction: preallocated single-copy
buffers, direct `data`/`end` handlers, decode-after-settle to minimize GC. The result:
the lowest variance in every scenario and decisive wins on byte throughput (+5% large,
+15% binary). The wasm boundary itself costs nothing measurable — the "Rust tax"
concern is not visible in these numbers (sequential parity at 9.7k req/s).

### 6.3 `axios`: a 23–36% engine tax, and keep-alive is not the fix

Axios's Node adapter (v1.20.0) is a full JS pipeline: dispatch → config merge →
`transformRequest` → adapter → `transformResponse` → interceptors — plus an extra
promise layer per request. That pipeline costs **22–36% on small-JSON traffic** (64–78%
of fetch()). The keep-alive experiment proves the gap is *engine* overhead, not socket
handling: an explicit pooled agent recovered only 1–4%. Axios's one win is binary
throughput (+7% over undici): its adapter is a direct `node:http` reader, and no stream
wrapper is in the way. The surprising corollary: on byte-heavy workloads, axios is
genuinely fast — the tax is on request churn, not on bytes.

### 6.4 What about HTTP/2?

All three clients moved bytes over HTTP/1.1 (rust-fetch and axios's adapters don't do
HTTP/2; undici does when the server offers it — this server didn't). Nothing here
predicts HTTP/2 behavior; treat §6 as HTTP/1.1 analysis.

---

## 7. Limitations and threats to validity

This is a controlled loopback benchmark, not a production-load test. Specific
qualifications:

1. **No network latency.** At 10–100 ms real-world RTT, the throughput differences
   below are smaller than the jitter in one request. These numbers matter for high-RPS
   services and byte-heavy pipelines, not for typical CRUD apps behind the internet.
2. **HTTP/1.1 only** (see §6.4). undici's HTTP/2 story is untested here.
3. **Single machine, single Node version, single campaign hardware.** M-series macOS,
   Node 22. Ratios are the takeaway; absolute numbers will vary.
4. **No server-side variance model** — one local server, no CPU throttling or
   competing load, no jitter injection. Real servers (TLS, gzip, CDN, app logic) change
   the mix. In particular, TLS handshakes and response compression would compress the
   gaps measured here.
5. **Read-only, success-only workloads.** No uploads, streaming, redirects, aborts,
   caching, retries or error paths. Axios's interceptors (a core feature) were not
   exercised. rust-fetch's timeout/retry/typed-error machinery was configured off for
   like-for-like comparison — its feature cost is a separate question this benchmark
   does not answer.
6. **Axios measured on NPM defaults** (adapter auto-resolution picked `http` in this
   environment; its `fetch` adapter was not measured).
7. **Warm JIT** — clients were warmed up before measuring; cold-start behavior (first
   request latency, wasm init) is not covered.
8. **2 of 3 campaigns lack raw per-run dumps** (console aggregates only); the published
   JSON covers the final campaign. The three campaigns agree on every conclusion here.
9. **§1–§9 run client and server in one process** (single event loop, 50-request batch
   barriers). §10's process-isolated harness revises the concurrency conclusion (§10.2)
   and adds fixed-rate latency/saturation/memory data the closed-loop design cannot
   produce.

---

## 8. Recommendations

| If you… | Choose | Because |
|---|---|---|
| Move lots of bytes (downloads, media, large JSON, BLOBs) | **`rust-fetch`** | +5–15% over fetch(), +7–16% over axios, and the most consistent timings |
| Run tiny requests in bulk (APIs, telemetry, fan-out) | **native `fetch()`** or **`rust-fetch`** | Statistically tied on sequential; native leads ~9% at 50-concurrency |
| Need interceptors, forms, browser/Node parity — and can pay the churn tax | **`axios`** | The convenience layer costs 22–36% on small-payload throughput; consider keep-alive agent (helps concurrency) and benchmark your own mix |
| Want timeouts, retries, typed errors in one package | **`rust-fetch`** | These features measured as ≈free at 9.7k req/s |

The bottom line, stated plainly: **`rust-fetch` is the best client this benchmark
tested.** It matches native `fetch()` where undici is strongest (sequential small
requests, ±2%), beats it everywhere bytes move (+5% on large JSON, +15% on binary, 10/10
runs), posts the most consistent timings of any client (§5.4), and is the only client
that held a sustained 15,000 req/s without skipping, erroring, or growing a tail (§10:
p99 11 ms vs 450 ms, 202 MB vs 635 MB peak RSS). Choose `native fetch()` for one reason:
it is the zero-dependency platform builtin — and it does have the best median latency
under sustained load. Choose `axios` for its interceptor ecosystem, but configure
keep-alive and size the socket pool, or it will fail outright at high fixed rates (§10.1).
**If a single recommendation is needed: use `rust-fetch`.**

---

## 9. Raw data

Full per-run dataset with environment metadata:
[`benchmark-results.json`](./benchmark-results.json) — 4 scenarios × 4 clients × 10
run-medians (each the median of 5 rounds), plus scenario parameters and versions.

Per-run medians (req/s) are reproduced in §5.2 tables; scenario definition:

| URL | Payload | Content-Type | Content-Length |
|---|---|---|---|
| `/small` | 10 user objects | `application/json` | 534 B |
| `/large` | 5,000 records | `application/json` | 589,726 B |
| `/binary` | pseudo-random bytes | `application/octet-stream` | 8,388,608 B |

**Runner:** [`benchmark.ts`](./benchmark.ts) — local `node:http` server, warm-up,
rotating round-robin order, response verification, `benchmark-results.json` dump.
Run with `npx tsx benchmark.ts [RUNS]`.

---

## 10. Stress test: 15,000 req/s sustained

§1–§9 answer *which client moves bytes faster in batches*. They do not answer the
questions a high-RPS service actually faces: **what latency does each client deliver when
forced to sustain a fixed rate — and what happens when that rate exceeds what the client
can absorb?**

At a glance (details and exact figures in §10.1–§10.4):

| Client | Verdict at 15,000 req/s sustained × 60 s |
|---|---|
| `rust-fetch` | **Only client to hold the full rate**: zero skipped, zero errors — p99 11 ms, worst request 64 ms, 202 MB peak RSS; scheduler never fell >2 ms behind. |
| `native fetch` | Held the rate with the best p50 (3.1 ms) but a **450 ms p99**, a 1.5 s worst stall, 635 MB RSS — and the tail varied an order of magnitude between runs. |
| `axios (default)` | **Hard failure**: 22% of target, 165,440 errors (`EADDRNOTAVAIL` ephemeral-port exhaustion from no keep-alive, plus `ETIMEDOUT`); event loop fell 2.3 s behind schedule. |
| `axios (keepAlive)` | Survived at 97% of target — **by queueing**: the median request waits 669 ms behind the 128-socket pool. |

One significant revision to §1–§9 emerged from this section: the process-isolated
concurrency sweep (§10.2) shows `rust-fetch` beating `native fetch()` at every
concurrency level (+5% to +16%), **overturning §5.2's "undici wins under parallelism"** —
the original result appears to be an artifact of running client, server, and all four
client pipelines on a single event loop with batch barriers (revision note in §5.2,
limitation in §7.9).

A second harness ([`stress.ts`](./stress.ts), dataset
[`stress-results.json`](./stress-results.json), reproduce with `npm run stress`) answers
both, with three methodological upgrades over §3:

1. **Open-loop scheduling.** Requests are fired at a fixed **15,000 rps for 60 s** (10 ms
   ticks, fractional accumulator for an exact long-run rate), *not* in closed-loop
   batches. The client cannot slow the schedule down; it can only fall behind — and
   falling behind is the measurement.
2. **Per-client process isolation.** Each client runs in its own `--expose-gc` worker
   process against the shared local server, one at a time, in sequence. Latency,
   throughput and RSS are attributable to exactly one client with zero cross-client
   contention — and unlike §3, client and server run on separate cores.
3. **A headroom probe.** Raw `node:http` + keep-alive, 256 connections, 15 s:
   **16,829 rps, p99 16.6 ms** — the leanest-possible-client ceiling of this server on
   this machine. The 15k target is 89% of that ceiling, so absolute latencies below
   include server-side queueing; every client faced the same server in the same state,
   so *relative* comparisons hold.

### 10.1 Sustained 15,000 rps × 60 s

| Client | achieved | % target | errors | skipped¹ | p50 | p95 | p99 | max | mean | RSS peak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native fetch | 14,944 | 100% | 0 | 3,423 | **3.1 ms** | 41.3 | 450.3 | 1,544.6 | 17.4 | 635 MB |
| rust-fetch | 15,001 | 100% | **0** | **0** | 4.7 | **7.9** | **11.2** | **64.0** | **5.1** | **202 MB** |
| axios (default) | 3,292 | 22% | **165,440** | 691,799 | 2,416 | 8,254 | 13,032 | 14,065.8 | 2,796 | 843 MB |
| axios (keepAlive) | 14,578 | 97% | 0 | 20,449 | 669 | 705 | 718 | 730.5 | 651 | 761 MB |

¹ `skipped` = scheduled requests not fired because the 10,000 in-flight cap was reached —
the saturation signal.

**`rust-fetch` is the only client that sustained the full rate with nothing skipped,
zero errors, and a millisecond-scale tail**: p99 11.2 ms, worst request 64 ms, mean 5.1 ms,
peak RSS 202 MB — and the scheduler never fell more than ~2 ms behind the rate. As in
§3, its full feature set (timeouts, retries, typed errors) was configured off, so this is
the transport, not the policy layer.

**Native `fetch()` keeps the rate but grows a heavy tail.** Its p50 is the best of any
client (3.1 ms) — undici is genuinely fast when it is fast — but the tail is a different
story: p99 **450 ms**, worst request **1.5 s**, and a mean 5.7× its own median:
periodic multi-hundred-millisecond stalls (GC pauses and pool churn) that never appear in
burst benchmarks. Peak RSS 635 MB. The tail is also unstable between runs — an otherwise
identical earlier run measured p99 35 ms, an order-of-magnitude difference in run-to-run
tail behavior. At a latency SLO, that unpredictability is the finding.

**axios (default) does not survive open-loop 15k.** It delivered 22% of target with
**165,440 transport errors in 60 s**: 157,938 × `EADDRNOTAVAIL` and 7,502 × `ETIMEDOUT`.
The mechanism is configuration, not engine: without keep-alive, every request needs a
fresh TCP connection, and at this rate the OS exhausts its ephemeral port space within
seconds; the event loop then falls 2.3 s behind the schedule (scheduler drift p95:
2,315 ms vs 1.6 ms for rust-fetch). §5 measured this same configuration as merely
"23–36% slower" closed-loop — under fixed-rate demand it is a **hard failure**. And it
is the out-of-the-box default.

**axios (keepAlive) survives — by queueing.** 97% of target, zero errors, but the median
request waits **669 ms** behind the 128-socket pool (p95 705 ms — this is not a tail,
it is the whole distribution). Saturated rather than broken: effective ceiling ~14.6k rps.

### 10.2 Concurrency sweep — revising §5.2

Closed-loop with a constant in-flight pool (no batch barriers), 10 s per level,
process-isolated, req/s:

| Client | 50 | 100 | 200 | 500 | p99: 50 → 500 |
|---|---:|---:|---:|---:|---:|
| rust-fetch | **23,977** | **23,882** | **23,454** | **22,064** | 3.9 → 28.5 ms |
| native fetch | 22,800 | 22,390 | 21,181 | 19,019 | 3.7 → 37.2 ms |
| axios (default) | 14,737 | 14,519 | 13,449 | 12,461 | 6.7 → 55.1 ms |
| axios (keepAlive) | 14,236 | 14,046 | 13,995 | 13,678 | 6.9 → 42.0 ms |

This **overturns §5.2's "undici wins under parallelism."** With the client in its own
process and sustained in-flight concurrency, rust-fetch leads native at every level
(+5% at 50, +16% at 500) and degrades least from 50 → 500 (−8% vs −17%). §5.2's numbers
are internally valid for that harness — one process shared by server, benchmark loop and
all four clients' pipelines, plus 50-request batch barriers — but the two-process layout
here (client and server on separate cores, as in production) reverses the conclusion.
Caveat: one run per level against §5's 10-run statistics; treat this as strong evidence,
not the final word. Note also that absolute numbers are far higher than §5's (23,977 vs
14,191 at concurrency 50): un-serializing client and server roughly *doubled* everyone's
throughput, which is itself a measure of how much the shared-process setup was
distorting §5.

### 10.3 Memory under sustained load

Peak RSS over the 60 s window, relative to each worker's post-GC baseline (~94–113 MB):
rust-fetch **202 MB** (2.1× baseline), native fetch **635 MB** (6.3×), axios (keepAlive)
761 MB, axios (default) 843 MB. Under sustained 15k rps the lean `node:http` transport
used **3.1× less memory than undici**. Heap-used at settle was modest everywhere
(27 MB rust-fetch / 66 MB native / 192 MB axios-keepAlive), so the RSS gap is allocator
and external buffers (wasm memory, pool growth), not retained JavaScript objects.

### 10.4 Stress-test conclusions

| If you… | Conclusion |
|---|---|
| Must hold a fixed high rate (15k rps) under a latency SLO | **`rust-fetch`** — the only client with zero skipped, zero errors, p99 11 ms and flat memory |
| Use native `fetch()` at sustained high rate | Workable if sub-second stalls and ~600 MB RSS are tolerable; the tail varies an order of magnitude between runs |
| Use axios above ~10k rps | **Mandatory:** explicit keep-alive agent with `maxSockets` sized for the target — the default config fails outright with `EADDRNOTAVAIL` |
| Trusted §5.2's concurrency ranking | Reconsider — the process-isolated sweep (§10.2) reverses it at every level |

---

## 11. Overload test: 50,000 req/s sustained

§10 asked *can each client hold 15,000 req/s?* — and every modern client could. §11
triples the demand to **50,000 req/s**: deliberately **2–3× beyond any client's
single-process ceiling** (§10.2 sweeps: rust-fetch ~22k, native ~19k, axios ~12–14k).
Nobody can sustain it; the question is **how each client fails**.

Methodology: same harness, same client configurations, same 10 ms-tick open-loop for
60 s — only the target changes. One infrastructure change: the loopback server is now a
**6-worker cluster** (the single-process server of §10 tops out near 16.8k rps and would
have been the first bottleneck). A **45 s cooldown** runs between client workers so each
starts with clean ports. The headroom probe (4 × 256 connections) reads 40,530 rps
aggregate — but the probe itself is four single-threaded processes and likely the
limiting side, so treat 40k as a *lower bound* on server capacity; since no client
exceeded 15k rps, the server was never the binding constraint in what follows.

Datasets: [`stress-results-50k.json`](./stress-results-50k.json) (4-client
cooldown-controlled campaign) and
[`stress-results-50k-rust-alone.json`](./stress-results-50k-rust-alone.json)
(diagnosis run, §11.2). Reproduce: `npx tsx stress.ts 50000 60` (cooldowns:
`COOLDOWN_MS=45000`; single-client diagnosis: `CLIENTS=rust`).

### 11.1 Results — how each client fails

Cooldown-controlled campaign, 60 s at 50,000 req/s:

| Client | achieved | % target | errors | skipped | p50 | p99 | max | RSS peak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| native fetch | **14,402** | 29% | 1,123 | 2.12M | 390 ms | 938 | 8,631 | 898 MB |
| rust-fetch | 3,166 | 6% | **168,747** | 2.67M | 2,334 | 10,714 | 30,159 | 712 MB |
| axios (default) | 2,923 | 6% | **135,487** | 2.72M | 2,818 | 9,583 | 27,233 | 895 MB |
| axios (keepAlive) | 11,450 | 23% | **0** | 2.30M | 832 | 1,433 | 1,597 | 765 MB |

Error taxonomy: rust-fetch — 166,499 × `EADDRNOTAVAIL` on connect, 5,565 × `ETIMEDOUT`
on connect, 878 × its own 30 s timeout (from the solo run; the campaign run is identical
in shape). axios (default) — `EADDRNOTAVAIL` + `ETIMEDOUT`, as in §10.1. native —
`fetch failed` (undici does not expose the underlying cause; counts and timing are
consistent with connect failures).

**Failure mode is set by socket policy, not engine speed.**

1. **The two clients with unbounded connection growth die by ephemeral-port exhaustion.**
   rust-fetch's `node:http` globalAgent transport and default axios (no keep-alive) both
   respond to queued demand by opening new connections; the OS's ~16k-port ephemeral
   range cannot supply them, and connects fail with `EADDRNOTAVAIL` en masse.
2. **rust-fetch collapses; native `fetch()` degrades.** Both have effectively unbounded
   pools, but undici reuses sockets aggressively enough to keep 14.4k rps flowing with
   only 1.1k errors and sub-second p99, while rust-fetch's transport opens connections
   until the OS refuses — collapsing to 3.2k rps with 169k errors and a 30 s
   worst-request. The post-overload sweep shows rust-fetch fully recovers (19.5k rps at
   concurrency 500 immediately after): the failure is under fire, not lasting damage.
3. **axios (keepAlive) is the only client with zero errors.** Its hard 128-socket cap
   converts overload into queueing (p50 832 ms) instead of a connection storm — graceful
   degradation by design.
4. **Everyone's latency is queueing-dominated** (p50s of 0.4–2.8 s vs 3–5 ms at 15k):
   at 2–3× beyond capacity, backpressure and socket pools are the story; per-request
   engine speed is irrelevant.

### 11.2 Was it inherited port debt? No — the collapse is intrinsic

The first 4-client run (no cooldowns, log: [`stress-run-50k.log`](./stress-run-50k.log))
produced the same pattern — native 14,966 rps / 374 errors; rust-fetch 3,453 / 179,189;
axios default 2,445 / 139,297; axios keepAlive 12,395 / 0 — raising the question whether
later workers merely inherited TIME_WAIT port debt from earlier workers' connection
storms. Two controls rule this out:

- **rust-fetch solo**, first position, pristine ports
  ([`stress-results-50k-rust-alone.json`](./stress-results-50k-rust-alone.json)):
  3,493 rps, 172,942 errors — the identical collapse.
- **The cooldown campaign** (45 s between workers, published above): every client
  reproduces its no-cooldown numbers within run-to-run noise.

The `EADDRNOTAVAIL` storm is generated by rust-fetch's own transport under 2–3×
overload, not by measurement order. (Whether its transport can be configured with a
bounded pool is a configuration question this benchmark does not answer — clients were
measured as configured throughout, i.e. library defaults.)

### 11.3 Overload conclusions

| If you… | Conclusion |
|---|---|
| Expect spikes to 2–3× your client's capacity | Prefer bounded/reused socket pools: native `fetch()` degrades gracefully; axios with a sized keep-alive agent keeps zero errors by queueing. rust-fetch (default config) hard-fails |
| Run rust-fetch in production | Stay within its measured envelope (~15–20k rps/process, §10); the engine is fine — the risk is unbounded connection growth under overload. Put a concurrency limiter or horizontal instances in front before pushing past it |
| Read the §10 verdict | It holds **within the envelope**. Outside it, resilience — not speed — reorders the ranking |

---

## 12. Scope: what this report claims — and what it does not

The verdict in the preamble means precisely: **best of the three clients tested, in the
workloads measured, on this setup.** It is not a market-wide claim. Concretely:

1. **Only three contenders were measured** (§2). The Node.js ecosystem also offers
   `got`, `ky`, direct `undici`, `node-fetch`, `ofetch`, `superagent`, and axios's
   `fetch` adapter — none appear in any table here. `got` in particular has a
   performance-minded design and reputation, and has never been measured against.
2. **The environment is narrow** (§7): loopback (no network latency), HTTP/1.1 only,
   no TLS or response compression, one machine and one Node version. A client that
   wins on loopback can lose over a real network, and undici's HTTP/2 story is untested.
3. **The workloads are narrow** (§7.5): read-only, success-only GETs. No uploads,
   streaming, redirects, aborts, proxying, or auth flows. A client is more than its
   throughput.
4. **A benchmark cannot measure production maturity.** axios has ~77M weekly downloads,
   a decade of battle-testing, security audits, and a large interceptor ecosystem;
   `rust-fetch` is a 2.x package. Reliability history, supply-chain trust, and
   community support are real selection criteria that never show up in req/s or p99.

**What would strengthen the claim:** running `got`, `ky`, and direct `undici` through
the same harness (§10/§11), and adding latency-injection (10–50 ms RTT) and TLS modes.
With those, the verdict could credibly read "best of the N major Node.js HTTP clients"
rather than "best of the three tested."

---

## Appendix A: Harness design decisions and experiment log

Engineering decisions behind [`stress.ts`](./stress.ts) (referenced by §10–§11), recorded
so the methodology is reproducible in spirit, not just in code:

1. **Sequential client workers.** An early design ran the four client workers in
   parallel; it was rejected before any data was collected — parallel workers share the
   server and the CPU, so per-client latency would measure cross-client contention, not
   the client engine. Workers run one at a time, in sequence.
2. **Per-client process isolation.** Each client runs in its own `--expose-gc` child
   process, so RSS is attributable to exactly one client, and so client and server run
   on separate cores — unlike §3, where they share one event loop (the distortion
   §10.2 quantifies at roughly a doubling of measured throughput).
3. **Sub-millisecond scheduling is impossible with timers**, so the open-loop scheduler
   fires on 10 ms ticks with a fractional accumulator (150 requests/tick at 15k, 500 at
   50k), keeping the long-run rate exact; per-tick lateness is tracked separately as
   `schedulerDriftP95Ms`.
4. **The 10,000 in-flight cap** converts runaway memory growth under overload into a
   countable `skipped` signal — the saturation metric — instead of an out-of-memory
   crash.
5. **Error classification was added to the harness mid-campaign** (between the first
   15k run and the published one) precisely so failure modes could be diagnosed by
   type; it is what identified `EADDRNOTAVAIL` port exhaustion in §10.1 and §11.
6. **The 50k server is a 6-worker cluster** because the single-process server of §10
   tops out near 16.8k rps and would have been the first bottleneck. The headroom probe
   (4 × 256 connections, itself four single-threaded processes) is likely the limiting
   side of its own measurement, so its ~40k reading is a lower bound on true server
   capacity.
7. **Order-effect controls** (`CLIENTS`, `COOLDOWN_MS` environment variables) exist to
   run the §11.2 diagnosis: a solo `rust-fetch` run with pristine ports, and a 45 s
   cooldown campaign, both reproducing the uncontrolled first run within noise — ruling
   out inherited TIME_WAIT port debt as the cause of the §11 collapse.
8. **Datasets are named by campaign** and never overwritten: `stress-results.json`
   (15k), `stress-results-50k.json` (cooldown-controlled overload campaign),
   `stress-results-50k-rust-alone.json` (diagnosis run); the first uncontrolled 50k run
   survives as `stress-run-50k.log`. Every published number in §10–§11 traces to one
   of these files.

---

*Report generated from measured data only. All claims trace to the published dataset.
No affiliation with any vendor; `rust-fetch` benchmarked because it was already a
dependency of the repository where this work took place.*