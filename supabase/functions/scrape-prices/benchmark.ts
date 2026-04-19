// ── DETERMINISTIC POST-MORTEM BENCHMARK SCORER ──
// Pure function, runs in <1ms, zero network calls, zero LLM.
// Scores every search request from runtime telemetry only.
// Output is appended to the response as `benchmark` and included in the structured log.

import type { SemanticIntent } from './semantic.ts'

export interface BenchmarkInput {
  query: string
  intent: SemanticIntent
  expanded_queries: string[]
  used_query: string | null
  stage_used: 'API' | 'RETRY' | 'FIRECRAWL' | 'FAIL'
  attempts: number
  products_count: number
  latency_ms: number
  invalid_items_count: number
  selected_stores: string[]
  routing_scores: Record<string, number>
}

export interface BenchmarkReport {
  query: string
  intent_accuracy: number
  expansion_quality: number
  retrieval_health: number
  performance: number
  overall_score: number
  status: 'PASS' | 'DEGRADED' | 'FAIL'
  key_issues: string[]
  key_strengths: string[]
  detected_bottleneck: 'semantic' | 'expansion' | 'scraping' | 'routing' | 'performance' | 'none'
}

// ── helpers ──────────────────────────────────────────────────────────────────
function rawHasArabic(s: string): boolean { return /[\u0600-\u06FF]/.test(s) }
function rawHasLatin(s: string): boolean { return /[a-zA-Z]/.test(s) }
function rawDetectVariant(q: string): string | null {
  const s = q.toLowerCase()
  if (/pro\s*max|برو\s*ماكس|بروماكس/.test(s)) return 'pro max'
  if (/\bultra\b|الترا|اولترا/.test(s)) return 'ultra'
  if (/\bplus\b|بلس|بلاس/.test(s)) return 'plus'
  if (/\bpro\b|\bبرو\b/.test(s)) return 'pro'
  if (/\bmini\b|ميني/.test(s)) return 'mini'
  if (/\blite\b|لايت/.test(s)) return 'lite'
  return null
}
function rawHasNumber(q: string): boolean {
  return /\d/.test(q) || /[٠-٩۰-۹]/.test(q)
}
function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// ── 1. Intent Accuracy (0–100) ──────────────────────────────────────────────
function scoreIntentAccuracy(input: BenchmarkInput): { score: number; issues: string[]; strengths: string[] } {
  const { query, intent } = input
  const issues: string[] = []
  const strengths: string[] = []
  let s = 0

  // Brand: only credited when query implies one
  const queryHasBrand = !!intent.entities.brand
  if (queryHasBrand) {
    s += 25
    strengths.push(`brand=${intent.entities.brand}`)
  } else if (rawHasArabic(query) || rawHasLatin(query)) {
    // Don't penalize generic queries like "cheap phone"
  }

  // Family
  if (intent.entities.product_family) {
    s += 25
    strengths.push(`family=${intent.entities.product_family}`)
  } else if (intent.entities.brand) {
    issues.push('family not detected despite known brand')
  }

  // Variant: only credited when raw query contains one
  const rawVariant = rawDetectVariant(query)
  if (rawVariant) {
    if (intent.entities.variant === rawVariant) {
      s += 20
      strengths.push(`variant=${rawVariant} preserved`)
    } else {
      issues.push(`variant "${rawVariant}" lost (got ${intent.entities.variant ?? 'null'})`)
    }
  } else {
    s += 20  // nothing to lose, full credit
  }

  // Model number — must be alphanumeric-preserving when applicable
  if (rawHasNumber(query)) {
    if (intent.entities.model_number) {
      s += 20
      strengths.push(`model=${intent.entities.model_number}`)
    } else {
      issues.push('model number present in query but not extracted')
    }
  } else {
    s += 20
  }

  // Language
  const langOk =
    (rawHasArabic(query) && rawHasLatin(query) && intent.language === 'mixed') ||
    (rawHasArabic(query) && !rawHasLatin(query) && intent.language === 'ar') ||
    (!rawHasArabic(query) && rawHasLatin(query) && intent.language === 'en')
  if (langOk) { s += 10; strengths.push(`lang=${intent.language}`) }
  else issues.push(`language mis-detected (${intent.language})`)

  return { score: clamp(s), issues, strengths }
}

// ── 2. Expansion Quality (0–100) ────────────────────────────────────────────
function scoreExpansionQuality(input: BenchmarkInput): { score: number; issues: string[]; strengths: string[] } {
  const { query, intent, expanded_queries, used_query } = input
  const issues: string[] = []
  const strengths: string[] = []
  let s = 0

  const norm = intent.normalized_query
  const variant = intent.entities.variant
  const num = intent.entities.model_number
  const family = intent.entities.product_family
  const brand = intent.entities.brand

  // (a) Full canonical query included? Look for an expansion containing brand+family+num+variant.
  const hasFullCanonical = expanded_queries.some(q => {
    const lq = q.toLowerCase()
    const okBrand = !brand || lq.includes(brand)
    const okFamily = !family || lq.includes(family)
    const okNum = !num || lq.includes(num)
    const okVariant = !variant || lq.includes(variant)
    return okBrand && okFamily && okNum && okVariant
  })
  if (hasFullCanonical || expanded_queries.includes(query)) {
    s += 40
    strengths.push('full canonical present')
  } else {
    issues.push('full canonical query missing from expansions')
  }

  // (b) No variant loss: every expansion containing the family/num MUST also contain the variant
  // (in EITHER its English OR Arabic form, since canonical AR/EN expansions are equivalent).
  if (variant) {
    const variantAr: Record<string, string> = {
      'pro max': 'برو ماكس', ultra: 'الترا', plus: 'بلس', pro: 'برو',
      mini: 'ميني', lite: 'لايت', fe: 'fe',
    }
    const arForm = variantAr[variant]
    const reductive = expanded_queries.find(q => {
      const lq = q.toLowerCase()
      const looksLikeProductQuery = (family && lq.includes(family)) || (num && lq.includes(num))
      const hasVariantToken = lq.includes(variant) || (arForm ? lq.includes(arForm) : false)
      return looksLikeProductQuery && !hasVariantToken
    })
    if (!reductive) { s += 30; strengths.push(`variant "${variant}" preserved across expansions`) }
    else issues.push(`reductive expansion "${reductive}" drops variant`)
  } else {
    s += 30
  }

  // (c) AR + EN both present when query is mixed/Arabic
  const queryNeedsBoth = rawHasArabic(query) || rawHasLatin(query)
  if (queryNeedsBoth && intent.intent === 'buy_product') {
    const hasAr = expanded_queries.some(q => rawHasArabic(q))
    const hasEn = expanded_queries.some(q => rawHasLatin(q))
    if (hasAr && hasEn) { s += 20; strengths.push('AR+EN expansions') }
    else issues.push(`only ${hasAr ? 'AR' : 'EN'} expansions generated`)
  } else {
    s += 20
  }

  // (d) used_query is not the destructive "family+num without variant" form.
  if (variant && used_query) {
    const variantAr2: Record<string, string> = {
      'pro max': 'برو ماكس', ultra: 'الترا', plus: 'بلس', pro: 'برو',
      mini: 'ميني', lite: 'لايت', fe: 'fe',
    }
    const arForm = variantAr2[variant]
    const lu = used_query.toLowerCase()
    const hasVariantToken = lu.includes(variant) || (arForm ? lu.includes(arForm) : false)
    const looksReductive = ((!!family && lu.includes(family)) || (!!num && lu.includes(num))) && !hasVariantToken
    if (!looksReductive) { s += 10; strengths.push('non-destructive used_query') }
    else issues.push(`used_query "${used_query}" stripped variant`)
  } else {
    s += 10
  }

  void norm
  return { score: clamp(s), issues, strengths }
}

// ── 3. Retrieval Health (0–100) ─────────────────────────────────────────────
function scoreRetrievalHealth(input: BenchmarkInput): { score: number; issues: string[]; strengths: string[] } {
  const issues: string[] = []
  const strengths: string[] = []
  let s = 0
  if (input.products_count > 0) { s = 100; strengths.push(`returned ${input.products_count} products`) }
  if (input.stage_used === 'FAIL') { s -= 30; issues.push('stage_used=FAIL') }
  if (input.attempts > 2) { s -= 20; issues.push(`attempts=${input.attempts}`) }
  if (input.invalid_items_count > 0) { s -= 20; issues.push(`invalid_items=${input.invalid_items_count}`) }
  return { score: clamp(s), issues, strengths }
}

// ── 4. Performance (0–100) ──────────────────────────────────────────────────
function scorePerformance(input: BenchmarkInput): { score: number; issues: string[]; strengths: string[] } {
  const issues: string[] = []
  const strengths: string[] = []
  let s = 100
  if (input.latency_ms > 1000) {
    const overage = input.latency_ms - 1000
    s -= Math.floor(overage / 100)
  }
  if (input.latency_ms > 3000) { s -= 20; issues.push(`slow (${input.latency_ms}ms)`) }
  if (input.stage_used === 'FAIL') { s -= 40; issues.push('failure penalty') }
  if (input.latency_ms < 1500 && input.stage_used !== 'FAIL') strengths.push(`fast (${input.latency_ms}ms)`)
  return { score: clamp(s), issues, strengths }
}

// ── Bottleneck detector (deterministic) ─────────────────────────────────────
function detectBottleneck(
  intent: number, expansion: number, retrieval: number, performance: number,
): BenchmarkReport['detected_bottleneck'] {
  const scores: Array<[BenchmarkReport['detected_bottleneck'], number]> = [
    ['semantic', intent],
    ['expansion', expansion],
    ['scraping', retrieval],
    ['performance', performance],
  ]
  scores.sort((a, b) => a[1] - b[1])
  const [worstName, worstScore] = scores[0]
  if (worstScore >= 80) return 'none'
  return worstName
}

export function runBenchmark(input: BenchmarkInput): BenchmarkReport {
  const intent = scoreIntentAccuracy(input)
  const expansion = scoreExpansionQuality(input)
  const retrieval = scoreRetrievalHealth(input)
  const performance = scorePerformance(input)

  const overall = Math.round(
    intent.score * 0.25 + expansion.score * 0.25 + retrieval.score * 0.30 + performance.score * 0.20,
  )

  let status: BenchmarkReport['status']
  if (input.stage_used === 'FAIL' || input.products_count === 0 || overall < 50) status = 'FAIL'
  else if (overall >= 80) status = 'PASS'
  else status = 'DEGRADED'

  return {
    query: input.query,
    intent_accuracy: intent.score,
    expansion_quality: expansion.score,
    retrieval_health: retrieval.score,
    performance: performance.score,
    overall_score: overall,
    status,
    key_issues: [...intent.issues, ...expansion.issues, ...retrieval.issues, ...performance.issues],
    key_strengths: [...intent.strengths, ...expansion.strengths, ...retrieval.strengths, ...performance.strengths],
    detected_bottleneck: detectBottleneck(intent.score, expansion.score, retrieval.score, performance.score),
  }
}
