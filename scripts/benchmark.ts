// 3-Stage Architecture Validation & Quality Benchmark
// Run with: deno run --allow-net --allow-env scripts/benchmark.ts
// (Reads SUPABASE_URL + SUPABASE_ANON_KEY from env, falls back to hardcoded project.)

const SUPABASE_URL = Deno.env.get('VITE_SUPABASE_URL') ?? 'https://guynfpxitlwzndninzfo.supabase.co';
const SUPABASE_ANON_KEY = Deno.env.get('VITE_SUPABASE_PUBLISHABLE_KEY') ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eW5mcHhpdGx3em5kbmluemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NTYyODgsImV4cCI6MjA5MTEzMjI4OH0.Dk_bhtyKQcsacePdiKtVea9jWU9C_-Tvs81smR2axGQ';

const STORES = ['B.TECH', 'Amazon Egypt', 'Jumia'] as const;
const QUERIES = ['Samsung S24 Ultra', 'ايفون 15'] as const;
const RUNS = 3;

// ── Accessory keywords (mirrors client filter) ──
const ACCESSORY_KW = [
  'case', 'cover', 'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder', 'stand', 'mount',
  'earphone', 'earbuds', 'headset', 'strap', 'band', 'pouch', 'sleeve',
  'film', 'lens protector', 'camera protector',
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة', 'سكرين', 'حماية',
];

const BRAND_MAP: Record<string, string[]> = {
  iphone: ['apple', 'iphone', 'ايفون', 'آيفون'],
  apple: ['apple', 'iphone', 'ipad', 'macbook', 'ايفون'],
  samsung: ['samsung', 'galaxy', 'سامسونج'],
  galaxy: ['samsung', 'galaxy'],
  xiaomi: ['xiaomi', 'redmi', 'poco', 'mi '],
  redmi: ['xiaomi', 'redmi'],
};
const ALL_BRANDS = ['apple', 'iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi', 'oppo', 'huawei', 'honor', 'vivo', 'realme', 'tecno', 'infinix', 'nokia', 'lg ', 'sony'];

// ── Normalization (Arabic-aware, mirrors edge function) ──
function normalize(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function tokenize(s: string): string[] {
  return normalize(s).split(/[^a-z0-9\u0600-\u06FF]+/).filter((t) => t.length >= 2);
}

// ── Relevance scorer ──
function relevanceScore(query: string, title: string): number {
  const q = tokenize(query);
  const t = new Set(tokenize(title));
  if (q.length === 0 || t.size === 0) return 0;
  const qNums = q.filter((x) => /^\d+$/.test(x));
  const qWords = q.filter((x) => !/^\d+$/.test(x));
  // Number mismatch = instant 0
  for (const n of qNums) if (!t.has(n)) return 0;
  let hits = 0;
  for (const w of qWords) if (t.has(w)) hits++;
  const total = qWords.length + qNums.length;
  const overlap = total > 0 ? ((hits + qNums.length) / total) * 100 : 0;
  const nq = normalize(query);
  const nt = normalize(title);
  const bonus = nq && nt.includes(nq) ? 20 : 0;
  return Math.min(100, Math.round(overlap + bonus));
}

// ── Invalid item detector ──
function isInvalid(query: string, title: string): { invalid: boolean; reason?: string } {
  const t = normalize(title);
  // Accessory
  for (const kw of ACCESSORY_KW) {
    if (t.includes(normalize(kw))) return { invalid: true, reason: 'accessory' };
  }
  // Sponsored
  if (/\b(sponsored|ad|إعلان)\b/i.test(title)) return { invalid: true, reason: 'sponsored' };
  // Brand mismatch
  const q = normalize(query);
  let expected: string[] | null = null;
  for (const [kw, brands] of Object.entries(BRAND_MAP)) {
    if (q.includes(kw)) { expected = brands.map(normalize); break; }
  }
  if (expected) {
    const matchesExpected = expected.some((b) => t.includes(b));
    if (!matchesExpected) {
      const matchesOther = ALL_BRANDS.map(normalize).some((b) => t.includes(b));
      if (matchesOther) return { invalid: true, reason: 'wrong-brand' };
    }
  }
  return { invalid: false };
}

interface RunResult {
  latencyMs: number;
  items: number;
  cached: boolean;
  usedFallback: boolean;
  products: Array<{ name: string; price: number }>;
  error?: string;
}

async function runOnce(query: string, store: string): Promise<RunResult> {
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
    const ms = Math.round(performance.now() - t0);
    const data = await res.json();
    return {
      latencyMs: ms,
      items: Array.isArray(data?.products) ? data.products.length : 0,
      cached: !!data?.cached,
      usedFallback: !!data?.usedFallback,
      products: (data?.products ?? []).map((p: any) => ({ name: p.name ?? '', price: p.price ?? 0 })),
      error: data?.error,
    };
  } catch (err) {
    return {
      latencyMs: Math.round(performance.now() - t0),
      items: 0, cached: false, usedFallback: false, products: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Aggregated {
  store: string;
  query: string;
  avgLatency: number;
  items: number;
  stage: 'API' | 'Smart Retry' | 'Firecrawl' | 'NONE';
  relevanceScore: number;
  invalidItems: number;
  invalidBreakdown: Record<string, number>;
  status: 'PASS' | 'FAIL' | 'DEGRADED';
}

async function benchmarkOne(query: string, store: string): Promise<Aggregated> {
  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr?.write?.(`  run ${i + 1}/${RUNS} ${store} "${query}"...\n`) ??
      console.error(`  run ${i + 1}/${RUNS} ${store} "${query}"...`);
    runs.push(await runOnce(query, store));
  }
  const avgLatency = Math.round(runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length);
  // Use last run's products (fresh, force_refresh ensures it's a true scrape)
  const last = runs[runs.length - 1];
  const items = last.items;
  // Stage inference: usedFallback=true => Firecrawl. Otherwise API or Smart Retry.
  // We can't directly distinguish API vs Smart Retry from the response, so we use latency:
  //   < 3500ms → API (Stage 1)
  //   3500-7000ms → Smart Retry (Stage 2)  
  //   > 7000ms or usedFallback → Firecrawl (Stage 3)
  let stage: Aggregated['stage'];
  if (items === 0) stage = 'NONE';
  else if (last.usedFallback) stage = 'Firecrawl';
  else if (avgLatency < 3500) stage = 'API';
  else stage = 'Smart Retry';

  // Quality
  let totalScore = 0;
  let invalidCount = 0;
  const breakdown: Record<string, number> = {};
  for (const p of last.products) {
    totalScore += relevanceScore(query, p.name);
    const inv = isInvalid(query, p.name);
    if (inv.invalid) {
      invalidCount++;
      breakdown[inv.reason!] = (breakdown[inv.reason!] ?? 0) + 1;
    }
  }
  const avgScore = items > 0 ? Math.round(totalScore / items) : 0;
  // Status
  let status: Aggregated['status'];
  if (items === 0) status = 'FAIL';
  else if (invalidCount > 2 || avgScore < 70) status = 'DEGRADED';
  else status = 'PASS';

  return {
    store, query, avgLatency, items, stage,
    relevanceScore: avgScore, invalidItems: invalidCount,
    invalidBreakdown: breakdown, status,
  };
}

async function main() {
  console.error(`\n🔬 3-STAGE ARCHITECTURE BENCHMARK — ${STORES.length}×${QUERIES.length} = ${STORES.length * QUERIES.length} cells × ${RUNS} runs each\n`);
  const results: Aggregated[] = [];
  for (const store of STORES) {
    for (const query of QUERIES) {
      console.error(`\n▶ ${store} / "${query}"`);
      results.push(await benchmarkOne(query, store));
    }
  }

  // Print Markdown table
  console.log('\n## 3-Stage Architecture Validation Results\n');
  console.log('| Store | Query | Avg Latency (ms) | Items | Stage | Relevance Score | Invalid Items | Status |');
  console.log('|-------|-------|------------------|-------|-------|-----------------|---------------|--------|');
  for (const r of results) {
    const emoji = r.status === 'PASS' ? '✅' : r.status === 'DEGRADED' ? '⚠️' : '❌';
    const invDetail = Object.keys(r.invalidBreakdown).length > 0
      ? `${r.invalidItems} (${Object.entries(r.invalidBreakdown).map(([k, v]) => `${v} ${k}`).join(', ')})`
      : String(r.invalidItems);
    console.log(`| ${r.store} | ${r.query} | ${r.avgLatency} | ${r.items} | ${r.stage} | ${r.relevanceScore} | ${invDetail} | ${emoji} ${r.status} |`);
  }

  // Summary
  const pass = results.filter((r) => r.status === 'PASS').length;
  const degraded = results.filter((r) => r.status === 'DEGRADED').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const avgLat = Math.round(results.reduce((s, r) => s + r.avgLatency, 0) / results.length);
  console.log(`\n### Summary\n`);
  console.log(`- ✅ PASS: ${pass}/${results.length}`);
  console.log(`- ⚠️ DEGRADED: ${degraded}/${results.length}`);
  console.log(`- ❌ FAIL: ${fail}/${results.length}`);
  console.log(`- Avg latency across all cells: **${avgLat}ms** (target <3000ms)`);
  console.log(`- Cells meeting <3000ms target: ${results.filter((r) => r.avgLatency < 3000).length}/${results.length}`);
  console.log(`- Cells meeting >80 relevance target: ${results.filter((r) => r.relevanceScore >= 80).length}/${results.length}`);
}

main().catch((err) => { console.error(err); Deno.exit(1); });
