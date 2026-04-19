// Parallel benchmark: 3 stores × 2 queries × 3 runs, runs cells in parallel per store
import { runOnce, relevanceScore, isInvalid } from './benchmark_lib.ts';

const STORES = ['B.TECH', 'Amazon Egypt', 'Jumia'];
const QUERIES = ['Samsung S24 Ultra', 'ايفون 15'];
const RUNS = 3;

interface Agg {
  store: string; query: string; avgLatency: number; items: number;
  stage: string; relevanceScore: number; invalidItems: number;
  invalidBreakdown: Record<string, number>; status: string;
}

async function benchmarkOne(query: string, store: string): Promise<Agg> {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await runOnce(query, store));
  const avgLatency = Math.round(runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length);
  const last = runs[runs.length - 1];
  const items = last.items;
  let stage: string;
  if (items === 0) stage = 'NONE';
  else if (last.usedFallback) stage = 'Firecrawl';
  else if (avgLatency < 3500) stage = 'API';
  else stage = 'Smart Retry';
  let totalScore = 0, invalidCount = 0;
  const breakdown: Record<string, number> = {};
  for (const p of last.products) {
    totalScore += relevanceScore(query, p.name);
    const inv = isInvalid(query, p.name);
    if (inv.invalid) { invalidCount++; breakdown[inv.reason!] = (breakdown[inv.reason!] ?? 0) + 1; }
  }
  const avgScore = items > 0 ? Math.round(totalScore / items) : 0;
  let status: string;
  if (items === 0) status = 'FAIL';
  else if (invalidCount > 2 || avgScore < 70) status = 'DEGRADED';
  else status = 'PASS';
  console.error(`✓ ${store}/${query}: ${items} items, ${avgLatency}ms, score=${avgScore}, ${status}`);
  return { store, query, avgLatency, items, stage, relevanceScore: avgScore, invalidItems: invalidCount, invalidBreakdown: breakdown, status };
}

const cells = STORES.flatMap((s) => QUERIES.map((q) => ({ s, q })));
console.error(`Running ${cells.length} cells in parallel (${RUNS} runs each)...`);
const results = await Promise.all(cells.map((c) => benchmarkOne(c.q, c.s)));

console.log('\n## 3-Stage Architecture Validation Results\n');
console.log('| Store | Query | Avg Latency (ms) | Items | Stage | Relevance | Invalid | Status |');
console.log('|-------|-------|------------------|-------|-------|-----------|---------|--------|');
for (const r of results) {
  const emoji = r.status === 'PASS' ? '✅' : r.status === 'DEGRADED' ? '⚠️' : '❌';
  const inv = Object.keys(r.invalidBreakdown).length > 0
    ? `${r.invalidItems} (${Object.entries(r.invalidBreakdown).map(([k, v]) => `${v} ${k}`).join(', ')})`
    : String(r.invalidItems);
  console.log(`| ${r.store} | ${r.query} | ${r.avgLatency} | ${r.items} | ${r.stage} | ${r.relevanceScore} | ${inv} | ${emoji} ${r.status} |`);
}
const pass = results.filter((r) => r.status === 'PASS').length;
const deg = results.filter((r) => r.status === 'DEGRADED').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const avgLat = Math.round(results.reduce((s, r) => s + r.avgLatency, 0) / results.length);
console.log(`\n### Summary\n- ✅ PASS: ${pass}/${results.length}\n- ⚠️ DEGRADED: ${deg}/${results.length}\n- ❌ FAIL: ${fail}/${results.length}\n- Avg latency: **${avgLat}ms** (target <3000ms)\n- Cells <3000ms: ${results.filter((r) => r.avgLatency < 3000).length}/${results.length}\n- Cells with relevance ≥80: ${results.filter((r) => r.relevanceScore >= 80).length}/${results.length}`);
