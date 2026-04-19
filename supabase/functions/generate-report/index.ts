// ── Benchmark Report Generator ──
// GET /generate-report → downloadable JSON aggregating the last 10 days
// of `regression_logs` (the project's benchmark store).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

interface Row {
  query: string
  store: string | null
  status: 'PASS' | 'DEGRADED' | 'FAIL'
  intent_accuracy: number | null
  expansion_quality: number | null
  retrieval_health: number | null
  performance: number | null
  overall_score: number | null
  bottleneck: string | null
  key_issues: string[] | null
  stage_used: string | null
}

const round = (n: number) => Math.round(n * 10) / 10
const avg = (xs: number[]) => xs.length === 0 ? 0 : round(xs.reduce((a, b) => a + b, 0) / xs.length)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(url, key)

    const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    // Page through to bypass the 1000-row default limit.
    const all: Row[] = []
    const PAGE = 1000
    let offset = 0
    while (true) {
      const { data, error } = await supabase
        .from('regression_logs')
        .select('query,store,status,intent_accuracy,expansion_quality,retrieval_health,performance,overall_score,bottleneck,key_issues,stage_used')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1)
      if (error) throw error
      const rows = (data ?? []) as Row[]
      all.push(...rows)
      if (rows.length < PAGE) break
      offset += PAGE
    }

    const total = all.length
    const passes = all.filter(r => r.status === 'PASS').length
    const fails = all.filter(r => r.status === 'FAIL').length

    // Bottleneck histogram (excluding 'none')
    const bottleneckCounts = new Map<string, number>()
    for (const r of all) {
      const b = r.bottleneck
      if (!b || b === 'none') continue
      bottleneckCounts.set(b, (bottleneckCounts.get(b) ?? 0) + 1)
    }
    const top_bottlenecks = [...bottleneckCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }))

    // Failed queries — pick first key_issue as reason, dedupe by query+store
    const failedSeen = new Set<string>()
    const top_failed_queries: Array<{ query: string; store: string; reason: string }> = []
    for (const r of all) {
      if (r.status !== 'FAIL') continue
      const k = `${r.query}|${r.store ?? ''}`
      if (failedSeen.has(k)) continue
      failedSeen.add(k)
      const reason = (r.key_issues && r.key_issues.length > 0)
        ? r.key_issues[0]
        : (r.stage_used === 'FAIL' ? 'pipeline failed' : 'low overall score')
      top_failed_queries.push({ query: r.query, store: r.store ?? '', reason })
      if (top_failed_queries.length >= 10) break
    }

    // Best performing — group by query, take highest overall_score per query
    const bestByQuery = new Map<string, number>()
    for (const r of all) {
      const s = r.overall_score ?? 0
      if (s > (bestByQuery.get(r.query) ?? -1)) bestByQuery.set(r.query, s)
    }
    const best_performing_queries = [...bestByQuery.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([query, score]) => ({ query, score }))

    // Store performance — group by store
    const storeBuckets = new Map<string, { scores: number[]; fails: number; total: number }>()
    for (const r of all) {
      const s = r.store ?? 'unknown'
      const b = storeBuckets.get(s) ?? { scores: [], fails: 0, total: 0 }
      b.total += 1
      if (r.overall_score != null) b.scores.push(r.overall_score)
      if (r.status === 'FAIL') b.fails += 1
      storeBuckets.set(s, b)
    }
    const store_performance = [...storeBuckets.entries()]
      .map(([store, b]) => ({
        store,
        avg_score: avg(b.scores),
        failure_rate: b.total === 0 ? 0 : round((b.fails / b.total) * 100),
      }))
      .sort((a, b) => b.avg_score - a.avg_score)

    const report = {
      period: 'last_10_days',
      total_requests: total,
      success_rate: total === 0 ? 0 : round((passes / total) * 100),
      failure_rate: total === 0 ? 0 : round((fails / total) * 100),
      avg_scores: {
        intent_accuracy: avg(all.map(r => r.intent_accuracy ?? 0)),
        expansion_quality: avg(all.map(r => r.expansion_quality ?? 0)),
        retrieval_health: avg(all.map(r => r.retrieval_health ?? 0)),
        performance: avg(all.map(r => r.performance ?? 0)),
        overall_score: avg(all.map(r => r.overall_score ?? 0)),
      },
      top_bottlenecks,
      top_failed_queries,
      best_performing_queries,
      store_performance,
    }

    return new Response(JSON.stringify(report, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="benchmark-report-last-10-days.json"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
