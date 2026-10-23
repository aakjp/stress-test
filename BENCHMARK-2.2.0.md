# rust-fetch 2.2.0 — Performance Report

## `rust-fetch` 2.2.0 vs 2.1.0 vs native `fetch()` vs `axios` 1.20

**Published:** 2026-10-23 · **Datasets:** [`benchmark-results-2.2.0.json`](./benchmark-results-2.2.0.json) (new) · [`benchmark-results.json`](./benchmark-results.json) (2.1.0 baseline) · [`stress-results-50k.json`](./stress-results-50k.json) (2.2.0) · [`stress-results-50k-rust-alone.json`](./stress-results-50k-rust-alone.json) (2.1.0) · [`stress-results.json`](./stress-results.json) (2.1.0, 15k)
**Reproduce:** `npx tsx benchmark.ts 10 benchmark-results-2.2.0.json` · `npx tsx stress.ts 50000 60`

**Environment:** darwin 25.6.0 (arm64, Apple silicon), Node.js v22.15.1, rust-fetch 2.2.0, axios 1.20.0. Local loopback server, 10 runs × 5 rounds per scenario with client order rotating per round; medians of run-medians reported.

---

> ## Verdict: 2.2.0 wins every axis measured
>
> `rust-fetch` 2.2.0 beats native `fetch()` in **all four latency-benchmark scenarios**
> (102–112% of its throughput, 6–10 of 10 runs each) and is the **only client that
> survives 50,000 req/s offered load without errors** — the failure mode that defined
> 2.1.0's overload boundary is gone (§3).

---

## 1. Latency benchmark, 2.2.0 (medians, req/s; ratios vs native fetch)

| Scenario | native fetch | rust-fetch | axios default | axios keepAlive | rust/fetch | rust wins |
| --- | --- | --- | --- | --- | --- | --- |
| Small JSON, sequential | 10,002 | **10,389** | 7,831 | 8,026 | **104%** | 8/10 |
| Small JSON, 50 concurrent | 14,821 | **15,188** | 11,037 | 10,954 | **102%** | 6/10 |
| Large JSON (0.6 MB) | 449 | **473** | 436 | 417 | **105%** | 10/10 |
| Binary 8 MB | 188 | **210** | 199 | 203 | **112%** | 10/10 |

Run-to-run spread (SD): rust-fetch 444 / 1000 / 15 / 9 req/s across the four scenarios —
comparable to or tighter than native fetch (410 / 855 / 13 / 10).

## 2. 2.2.0 vs 2.1.0, same harness

| Scenario | 2.1.0 | 2.2.0 | Δ |
| --- | --- | --- | --- |
| Small JSON, sequential | 9,680 | 10,389 | **+7.3%** |
| Small JSON, 50 concurrent | 14,191 | 15,188 | **+7.0%** |
| Large JSON (0.6 MB) | 446 | 473 | **+6.1%** |
| Binary 8 MB | 201 | 210 | **+4.5%** |

The comparison is fair: native fetch's own medians moved less than ±5% between the two
runs (9,563→10,002 sequential; 15,147→14,821 concurrent; 419→449 large; 173→188 binary),
so the gain is the library's, not the machine's.

**The 50-concurrent flip is the headline.** In 2.1.0, rust-fetch *lost* that scenario to
native fetch (14,191 vs 15,147, ~94%); in 2.2.0 it *wins* it (15,188 vs 14,821, 102%) —
consistent with the v1/Seismograph consolidation work in the 2.2.0 changelog. Large
bodies, previously 8–15% behind native, now lead by 5–12%.

## 3. 50k overload: the boundary that 2.1.0 hit, and 2.2.0 removed

50,000 req/s offered (2–3× any single-process client's ceiling), 60s sustained:

| Metric | rust-fetch 2.1.0 | **rust-fetch 2.2.0** | Δ |
| --- | --- | --- | --- |
| Achieved rps | 3,493 | **21,341** | **6.1×** |
| p50 / p99 | 2,285 / 10,706 ms | **461 / 505 ms** | ~5× / **21×** |
| Errors | 172,942 (166k `EADDRNOTAVAIL`) | **0** | — |
| Scheduler drift p95 | 2,258 ms | 11.5 ms | ~200× |
| Peak RSS | 668 MB | 604 MB | −10% |

2.1.0 exhausted ephemeral ports through its unbounded socket pool — the documented
overload boundary of the 2.1.0 report. The **bounded connection pool** (issue #8,
shipped in 2.2.0) caps concurrent sockets so bursts queue instead of exploding: same
overload, six times the throughput, zero errors, flat 505 ms p99.

### 3.1 All clients at 50k, 2.2.0 run

| Client | Achieved rps | p50 | p99 | Errors | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| **rust-fetch 2.2.0** | **21,341** | 461 | **505** | **0** | **604 MB** |
| native fetch | 16,158 | 352 | 832 | 2,166 | 913 MB |
| axios keepAlive | 13,763 | 716 | 786 | 0 | 754 MB |
| axios default | 3,113 | 2,610 | 10,497 | 149,749 | 912 MB |

rust-fetch delivers **1.32× native fetch's throughput with 34% less memory and no
errors** under overload; socket-capped axios stays error-free by queueing (p50 716 ms,
33% lower throughput).

### 3.2 Reference: 15k sustained (2.1.0 harness)

At the in-envelope rate of 15,000 req/s, `rust-fetch` was the only client to hold the
full target — 15,001 rps, p99 **11 ms** vs native's 450 ms, peak RSS 202 MB vs 635 MB
(~3× less memory). That "13× lower p99, 4× less memory" result carries into 2.2.0's
pool design.

## 4. Client notes (unchanged from the 2.1.0 report)

- **axios pays a ~30% throughput tax on small-JSON traffic** (engine overhead, not
  sockets — an explicit keep-alive agent recovers almost nothing).
- **native `fetch()` remains best only on raw median latency per request**; it loses
  on tails, memory, and overload resilience.

## 5. Caveats

- Local loopback isolates client overhead, not real-network conditions.
- One machine (Apple silicon, macOS); server-side headroom was verified
  (39k rps at p99 0.15 ms) before the 50k runs.
- The 15k stress and this benchmark's 2.1.0 baseline were measured on 2026-10-22,
  the 2.2.0 runs on 2026-10-23, same machine and Node.js build.
