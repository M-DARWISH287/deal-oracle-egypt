// Final benchmark — reads REAL telemetry from edge function response.
// Run: deno run --allow-net scripts/benchmark.ts
const SUPABASE_URL = 'https://guynfpxitlwzndninzfo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eW5mcHhpdGx3em5kbmluemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NTYyODgsImV4cCI6MjA5MTEzMjI4OH0.Dk_bhtyKQcsacePdiKtVea9jWU9C_-Tvs81smR2axGQ';

const STORES = ['B.TECH', 'Amazon Egypt', 'Jumia'] as const;
const QUERIES = ['Samsung S24 Ultra', 'ايفون 15'] as const;

interface Telemetry {
  store: string;
  query: string;
  stage_used: string;
  attempts: number;
  latency_ms: number;
  products: number;
  avg_relevance: number;
  invalid_items: number;
  status: 'PASS' | 'DEGRADED' | 'FAIL';
  error?: string;
}

async function runOne(query: string, store: string): Promise<Telemetry> {
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
    const data = await res.json();
    const wallMs = Math.round(performance.now() - t0);
    const products = Array.isArray(data?.products) ? data.products.length : 0;
    const avgRel = Number(data?.avg_relevance_score ?? 0);
    let status: Telemetry['status'];
    if (products === 0) status = 'FAIL';
    else if (avgRel >= 80) status = 'PASS';
    else if (avgRel >= 60) status = 'DEGRADED';
    else status = 'DEGRADED';
    return {
      store, query,
      stage_used: String(data?.stage_used ?? 'UNKNOWN'),
      attempts: Number(data?.attempts ?? 0),
      latency_ms: Number(data?.latency_ms ?? wallMs),
      products,
      avg_relevance: Math.round(avgRel),
      invalid_items: Number(data?.invalid_items_count ?? 0),
      status,
      error: data?.error,
    };
  } catch (err) {
    return {
      store, query, stage_used: 'ERROR', attempts: 0,
      latency_ms: Math.round(performance.now() - t0),
      products: 0, avg_relevance: 0, invalid_items: 0,
      status: 'FAIL', error: err instanceof Error ? err.message : String(err),
    };
  }
}

const cells = STORES.flatMap((s) => QUERIES.map((q) => ({ s, q })));
console.error(`Running ${cells.length} cells in parallel (force_refresh=true)...`);
const results = await Promise.all(cells.map((c) => runOne(c.q, c.s)));

console.log('\n## Final 3-Stage Benchmark — Real Telemetry\n');
console.log('| Store | Query | Stage Used | Attempts | Latency ms | Products | Avg Relevance | Invalid Items | Status |');
console.log('|-------|-------|------------|----------|------------|----------|---------------|---------------|--------|');
for (const r of results) {
  const emoji = r.status === 'PASS' ? '✅' : r.status === 'DEGRADED' ? '⚠️' : '❌';
  console.log(`| ${r.store} | ${r.query} | ${r.stage_used} | ${r.attempts} | ${r.latency_ms} | ${r.products} | ${r.avg_relevance} | ${r.invalid_items} | ${emoji} ${r.status} |`);
}

const pass = results.filter((r) => r.status === 'PASS').length;
const deg = results.filter((r) => r.status === 'DEGRADED').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const avgLat = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length);
console.log(`\n### Summary\n- ✅ PASS: ${pass}/${results.length}\n- ⚠️ DEGRADED: ${deg}/${results.length}\n- ❌ FAIL: ${fail}/${results.length}\n- Avg latency: **${avgLat}ms**`);
