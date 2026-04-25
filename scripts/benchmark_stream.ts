#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * NDJSON Stream Benchmark — scrape-prices-router
 * ─────────────────────────────────────────────────────────────
 * Runs a fixed query set against the deployed edge function,
 * measures TTFB + per-store latency, and prints a console report
 * including the first product URL from each successful store so
 * URL sanitization can be eyeballed.
 *
 * Usage:
 *   deno run --allow-net --allow-env scripts/benchmark_stream.ts
 *   # or
 *   bunx tsx scripts/benchmark_stream.ts   (Node also works)
 *
 * Env (optional — falls back to project defaults):
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 */

const SUPABASE_URL =
  (typeof process !== 'undefined' && process.env?.SUPABASE_URL) ||
  // @ts-ignore — Deno global
  (typeof Deno !== 'undefined' && Deno.env.get('SUPABASE_URL')) ||
  'https://guynfpxitlwzndninzfo.supabase.co';

const SUPABASE_ANON_KEY =
  (typeof process !== 'undefined' && process.env?.SUPABASE_ANON_KEY) ||
  // @ts-ignore — Deno global
  (typeof Deno !== 'undefined' && Deno.env.get('SUPABASE_ANON_KEY')) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eW5mcHhpdGx3em5kbmluemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NTYyODgsImV4cCI6MjA5MTEzMjI4OH0.Dk_bhtyKQcsacePdiKtVea9jWU9C_-Tvs81smR2axGQ';

const ENDPOINT = `${SUPABASE_URL}/functions/v1/scrape-prices-router`;

const QUERIES = [
  'iPhone 15 Pro Max 256GB',
  'Samsung Galaxy S24 Ultra',
  'Vivo V30 5G',
];

interface StreamLine {
  store: string;
  strategy?: 'NATIVE' | 'FIRECRAWL';
  status: 'success' | 'error' | 'empty' | 'blocked' | 'failed';
  products?: Array<{ name?: string; price?: number; url?: string }>;
  error?: string;
  latencyMs?: number;
}

interface StoreResult {
  store: string;
  strategy: string;
  status: string;
  latencyMs: number;
  productCount: number;
  firstUrl: string | null;
  error?: string;
}

// ANSI helpers
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m',
};

function statusBadge(s: string): string {
  if (s === 'success') return `${c.green}✅ SUCCESS${c.reset}`;
  if (s === 'empty')   return `${c.yellow}○  EMPTY  ${c.reset}`;
  if (s === 'blocked') return `${c.yellow}⛔ BLOCKED${c.reset}`;
  return `${c.red}❌ ${s.toUpperCase().padEnd(7)}${c.reset}`;
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function runQuery(query: string): Promise<{
  ttfbMs: number | null;
  totalMs: number;
  results: StoreResult[];
  streamError?: string;
}> {
  const results: StoreResult[] = [];
  const t0 = performance.now();
  let ttfbMs: number | null = null;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    return { ttfbMs: null, totalMs: performance.now() - t0, results, streamError: `fetch failed: ${err}` };
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    return { ttfbMs: null, totalMs: performance.now() - t0, results, streamError: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const handleLine = (raw: string) => {
    if (!raw) return;
    if (ttfbMs === null) ttfbMs = performance.now() - t0;
    let parsed: StreamLine;
    try { parsed = JSON.parse(raw) as StreamLine; }
    catch (e) {
      console.warn(`${c.dim}  ⚠ Skipping malformed line: ${raw.slice(0, 80)}${c.reset}`);
      return;
    }
    const products = Array.isArray(parsed.products) ? parsed.products : [];
    results.push({
      store: parsed.store ?? 'Unknown',
      strategy: parsed.strategy ?? '—',
      status: parsed.status ?? 'empty',
      latencyMs: Math.round(parsed.latencyMs ?? (performance.now() - t0)),
      productCount: products.length,
      firstUrl: products[0]?.url ?? null,
      error: parsed.error,
    });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());

  return { ttfbMs, totalMs: performance.now() - t0, results };
}

function printReport(query: string, idx: number, total: number, run: Awaited<ReturnType<typeof runQuery>>) {
  const { ttfbMs, totalMs, results, streamError } = run;
  const bar = '═'.repeat(78);
  console.log(`\n${c.bold}${c.cyan}${bar}${c.reset}`);
  console.log(`${c.bold}${c.cyan}[${idx}/${total}] ${c.magenta}QUERY:${c.reset} ${c.bold}"${query}"${c.reset}`);
  console.log(`${c.bold}${c.cyan}${bar}${c.reset}`);

  if (streamError) {
    console.log(`${c.red}STREAM ERROR: ${streamError}${c.reset}`);
    return;
  }

  console.log(
    `${c.dim}TTFB:${c.reset} ${ttfbMs !== null ? c.green + Math.round(ttfbMs) + 'ms' + c.reset : c.red + 'n/a' + c.reset}` +
    `   ${c.dim}TOTAL:${c.reset} ${c.blue}${Math.round(totalMs)}ms${c.reset}` +
    `   ${c.dim}LINES:${c.reset} ${results.length}`
  );

  console.log(
    `\n${c.bold}  ${pad('STORE', 18)} ${pad('TIER', 11)} ${pad('STATUS', 12)} ${pad('LAT', 8)} ${pad('CNT', 5)} FIRST URL${c.reset}`
  );
  console.log(`  ${c.dim}${'─'.repeat(76)}${c.reset}`);

  for (const r of results) {
    const url = r.firstUrl ? r.firstUrl : (r.error ? `${c.red}${r.error.slice(0, 50)}${c.reset}` : `${c.dim}—${c.reset}`);
    console.log(
      `  ${pad(r.store, 18)} ${pad(r.strategy, 11)} ${statusBadge(r.status)} ` +
      `${pad(r.latencyMs + 'ms', 8)} ${pad(String(r.productCount), 5)} ${url}`
    );
  }

  // Summary
  const ok = results.filter(r => r.status === 'success' && r.productCount > 0).length;
  const empty = results.filter(r => r.status === 'success' && r.productCount === 0 || r.status === 'empty').length;
  const fail = results.filter(r => r.status !== 'success' && r.status !== 'empty').length;
  const totalProducts = results.reduce((s, r) => s + r.productCount, 0);
  console.log(
    `\n${c.dim}  Summary:${c.reset} ${c.green}${ok} ok${c.reset} · ` +
    `${c.yellow}${empty} empty${c.reset} · ` +
    `${c.red}${fail} failed${c.reset} · ` +
    `${c.bold}${totalProducts}${c.reset} total products`
  );
}

async function main() {
  console.log(`${c.bold}${c.magenta}\n🚀 NDJSON Stream Benchmark${c.reset}`);
  console.log(`${c.dim}Endpoint: ${ENDPOINT}${c.reset}`);
  console.log(`${c.dim}Queries:  ${QUERIES.length}${c.reset}`);

  const ttfbs: number[] = [];
  const totals: number[] = [];
  let totalProducts = 0;
  let successStores = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const run = await runQuery(q);
    printReport(q, i + 1, QUERIES.length, run);
    if (run.ttfbMs !== null) ttfbs.push(run.ttfbMs);
    totals.push(run.totalMs);
    totalProducts += run.results.reduce((s, r) => s + r.productCount, 0);
    successStores += run.results.filter(r => r.status === 'success' && r.productCount > 0).length;
  }

  const avg = (a: number[]) => a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : 0;
  const bar = '═'.repeat(78);
  console.log(`\n${c.bold}${c.cyan}${bar}${c.reset}`);
  console.log(`${c.bold}${c.cyan}📊 AGGREGATE RESULTS${c.reset}`);
  console.log(`${c.bold}${c.cyan}${bar}${c.reset}`);
  console.log(`  ${c.dim}Avg TTFB:${c.reset}  ${c.green}${avg(ttfbs)}ms${c.reset}`);
  console.log(`  ${c.dim}Avg Total:${c.reset} ${c.blue}${avg(totals)}ms${c.reset}`);
  console.log(`  ${c.dim}Successful stores:${c.reset} ${c.green}${successStores}${c.reset}`);
  console.log(`  ${c.dim}Total products:${c.reset}    ${c.bold}${totalProducts}${c.reset}\n`);
}

main().catch(err => {
  console.error(`${c.red}FATAL: ${err}${c.reset}`);
  // @ts-ignore
  if (typeof process !== 'undefined') process.exit(1);
  // @ts-ignore
  if (typeof Deno !== 'undefined') Deno.exit(1);
});