// Full diagnostics benchmark — 5 stores × 3 queries, force_refresh, real telemetry.
// Run: deno run --allow-net scripts/full_diagnostics_bench.ts
const SUPABASE_URL = 'https://guynfpxitlwzndninzfo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eW5mcHhpdGx3em5kbmluemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NTYyODgsImV4cCI6MjA5MTEzMjI4OH0.Dk_bhtyKQcsacePdiKtVea9jWU9C_-Tvs81smR2axGQ';

const STORES = ['Amazon Egypt', 'Jumia', 'B.TECH', 'Noon', 'Carrefour'] as const;
const QUERIES = ['Samsung S24 Ultra', 'ايفون 15 برو 256', 'Oppo cheap phone'] as const;

interface Cell {
  store: string;
  query: string;
  latency_ms: number;
  items: number;
  stage: string;
  score: number;
  status: 'PASS' | 'DEGRADED' | 'FAIL';
  error?: string;
}

async function runCell(query: string, store: string): Promise<Cell> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/scrape-prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ query, store, force_refresh: true }),
    });
    const wallMs = Math.round(performance.now() - t0);
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data?.products) ? data.products.length : 0;
    const score = Math.round(Number(data?.avg_relevance_score ?? 0));
    const stage = String(data?.stage_used ?? 'UNKNOWN');
    let status: Cell['status'];
    if (items === 0) status = 'FAIL';
    else if (score >= 80) status = 'PASS';
    else status = 'DEGRADED';
    return {
      store, query,
      latency_ms: Number(data?.latency_ms ?? wallMs),
      items, stage, score, status,
      error: data?.error,
    };
  } catch (err) {
    return {
      store, query,
      latency_ms: Math.round(performance.now() - t0),
      items: 0, stage: 'ERROR', score: 0, status: 'FAIL',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const cells = STORES.flatMap((s) => QUERIES.map((q) => ({ s, q })));
console.error(`Running ${cells.length} cells in parallel (force_refresh=true)...`);
const results = await Promise.all(cells.map((c) => runCell(c.q, c.s)));

// ── 1. Raw table ──
console.log('\n# Full Diagnostics Benchmark — 5 Stores × 3 Queries\n');
console.log('## 1. Raw Results\n');
console.log('| Query | Store | Latency (ms) | Items | Stage | Score | Status |');
console.log('|-------|-------|--------------|-------|-------|-------|--------|');
for (const r of results) {
  const emoji = r.status === 'PASS' ? '✅' : r.status === 'DEGRADED' ? '⚠️' : '❌';
  console.log(`| ${r.query} | ${r.store} | ${r.latency_ms} | ${r.items} | ${r.stage} | ${r.score} | ${emoji} ${r.status} |`);
}

// ── 2. Per-store analysis ──
console.log('\n## 2. Store Analysis\n');

interface StoreAgg {
  rows: Cell[]; avgLat: number; avgScore: number; passRate: number;
  firecrawlPct: number; failPct: number; arabicScore: number;
}

function aggregate(store: string): StoreAgg {
  const rows = results.filter((r) => r.store === store);
  const avgLat = Math.round(rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length);
  const avgScore = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);
  const pass = rows.filter((r) => r.status === 'PASS').length;
  const fail = rows.filter((r) => r.status === 'FAIL').length;
  const firecrawl = rows.filter((r) => /firecrawl/i.test(r.stage)).length;
  const arabic = rows.find((r) => /[\u0600-\u06FF]/.test(r.query));
  return {
    rows,
    avgLat,
    avgScore,
    passRate: Math.round((pass / rows.length) * 100),
    failPct: Math.round((fail / rows.length) * 100),
    firecrawlPct: Math.round((firecrawl / rows.length) * 100),
    arabicScore: arabic ? arabic.score : 0,
  };
}

const aggs = Object.fromEntries(STORES.map((s) => [s, aggregate(s)]));

for (const store of STORES) {
  const a = aggs[store];
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (a.avgLat < 3000) strengths.push(`Fast: avg ${a.avgLat}ms latency`);
  if (a.avgLat >= 6000) weaknesses.push(`Slow: avg ${a.avgLat}ms latency`);
  if (a.avgScore >= 80) strengths.push(`High relevance: avg score ${a.avgScore}`);
  if (a.avgScore < 60 && a.avgScore > 0) weaknesses.push(`Low relevance: avg score ${a.avgScore}`);
  if (a.passRate >= 66) strengths.push(`Reliable: ${a.passRate}% pass rate`);
  if (a.failPct >= 33) weaknesses.push(`Unreliable: ${a.failPct}% failure rate`);
  if (a.firecrawlPct === 0) strengths.push('Native-only (no Firecrawl dependency)');
  if (a.firecrawlPct >= 66) weaknesses.push(`Heavy Firecrawl dependency: ${a.firecrawlPct}% of queries`);
  if (a.arabicScore >= 70) strengths.push(`Strong Arabic handling (score ${a.arabicScore})`);
  if (a.arabicScore > 0 && a.arabicScore < 50) weaknesses.push(`Weak Arabic handling (score ${a.arabicScore})`);
  if (a.arabicScore === 0) weaknesses.push('Arabic query returned 0 items');

  // Consistency check
  const scores = a.rows.map((r) => r.score);
  const variance = Math.max(...scores) - Math.min(...scores);
  if (variance <= 20 && a.avgScore > 0) strengths.push(`Consistent (score variance ${variance})`);
  if (variance >= 50) weaknesses.push(`Inconsistent (score variance ${variance})`);

  if (strengths.length === 0) strengths.push('—');
  if (weaknesses.length === 0) weaknesses.push('—');

  console.log(`### ${store}`);
  console.log(`- Avg latency: **${a.avgLat}ms** | Avg score: **${a.avgScore}** | Pass rate: **${a.passRate}%** | Firecrawl: **${a.firecrawlPct}%**`);
  console.log(`- **Strengths:** ${strengths.join('; ')}`);
  console.log(`- **Weaknesses:** ${weaknesses.join('; ')}\n`);
}

// ── 3. System verdicts ──
const ranked = STORES.map((s) => ({ s, a: aggs[s] }));
const fastest = [...ranked].sort((a, b) => a.a.avgLat - b.a.avgLat)[0];
const mostAccurate = [...ranked].sort((a, b) => b.a.avgScore - a.a.avgScore)[0];
const mostFirecrawl = [...ranked].sort((a, b) => b.a.firecrawlPct - a.a.firecrawlPct)[0];
const weakestArabic = [...ranked].sort((a, b) => a.a.arabicScore - b.a.arabicScore)[0];

console.log('## 3. System Verdicts\n');
console.log(`- 🏆 **Fastest store:** ${fastest.s} (${fastest.a.avgLat}ms avg)`);
console.log(`- 🎯 **Most accurate store:** ${mostAccurate.s} (score ${mostAccurate.a.avgScore})`);
console.log(`- 🔥 **Most Firecrawl-dependent:** ${mostFirecrawl.s} (${mostFirecrawl.a.firecrawlPct}%)`);
console.log(`- 🌍 **Weakest Arabic handling:** ${weakestArabic.s} (Arabic score ${weakestArabic.a.arabicScore})`);

const totalPass = results.filter((r) => r.status === 'PASS').length;
const totalDeg = results.filter((r) => r.status === 'DEGRADED').length;
const totalFail = results.filter((r) => r.status === 'FAIL').length;
const sysAvgLat = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length);
console.log(`\n### System Summary`);
console.log(`- Total cells: ${results.length} | ✅ PASS: ${totalPass} | ⚠️ DEGRADED: ${totalDeg} | ❌ FAIL: ${totalFail}`);
console.log(`- System avg latency: **${sysAvgLat}ms**`);

// Bottlenecks
const bottlenecks: string[] = [];
for (const { s, a } of ranked) {
  if (a.failPct >= 66) bottlenecks.push(`${s} — ${a.failPct}% of queries failing`);
  if (a.avgLat >= 8000) bottlenecks.push(`${s} — high latency (${a.avgLat}ms)`);
  if (a.firecrawlPct >= 66 && a.passRate < 50) bottlenecks.push(`${s} — Firecrawl-heavy AND unreliable`);
}
console.log(`\n### Detected Bottlenecks`);
if (bottlenecks.length === 0) console.log('- None');
else for (const b of bottlenecks) console.log(`- ⚠️ ${b}`);
