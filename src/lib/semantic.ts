// Client-side mirror of the server semantic layer.
// Used by SearchResults to:
//  1. Canonicalize the user's query
//  2. Pick the top-N most relevant stores (Smart Store Router)
//  3. Re-rank grouped products before display
//
// Server still runs its own canonicalize + expand + rerank (defense in depth).

export type Lang = 'ar' | 'en' | 'mixed'

export interface SemanticIntent {
  raw_query: string
  normalized_query: string
  language: Lang
  intent: 'buy_product' | 'unknown'
  entities: {
    brand?: string
    product_family?: string
    variant?: string
    model_number?: string
  }
  confidence: number
}

const BRAND_SYNONYMS: Array<{ patterns: RegExp[]; canonical: string }> = [
  { canonical: 'apple',   patterns: [/\bapple\b/i, /\bايفون\b/, /\bآيفون\b/, /\bابل\b/, /\bأبل\b/, /\biphone\b/i, /\bipad\b/i, /\bmacbook\b/i, /\bairpods?\b/i] },
  { canonical: 'samsung', patterns: [/\bsamsung\b/i, /\bسامسونج\b/, /\bسامسونغ\b/, /\bgalaxy\b/i, /\bجالاكسي\b/, /\bجلاكسي\b/] },
  { canonical: 'xiaomi',  patterns: [/\bxiaomi\b/i, /\bشاومي\b/, /\bredmi\b/i, /\bريدمي\b/, /\bpoco\b/i, /\bبوكو\b/] },
  { canonical: 'oppo',    patterns: [/\boppo\b/i, /\bاوبو\b/, /\bأوبو\b/] },
  { canonical: 'huawei',  patterns: [/\bhuawei\b/i, /\bهواوي\b/] },
  { canonical: 'honor',   patterns: [/\bhonor\b/i, /\bهونر\b/] },
  { canonical: 'realme',  patterns: [/\brealme\b/i, /\bريلمي\b/] },
  { canonical: 'sony',    patterns: [/\bsony\b/i, /\bسوني\b/, /\bplaystation\b/i, /\bبلايستيشن\b/] },
  { canonical: 'lenovo',  patterns: [/\blenovo\b/i, /\bلينوفو\b/] },
  { canonical: 'dell',    patterns: [/\bdell\b/i, /\bديل\b/] },
  { canonical: 'hp',      patterns: [/\bhp\b/i] },
]

const FAMILY_SYNONYMS: Array<{ patterns: RegExp[]; brand: string; family: string }> = [
  { brand: 'apple',   family: 'iphone',     patterns: [/\biphone\b/i, /\bايفون\b/, /\bآيفون\b/] },
  { brand: 'apple',   family: 'ipad',       patterns: [/\bipad\b/i, /\bايباد\b/] },
  { brand: 'apple',   family: 'macbook',    patterns: [/\bmacbook\b/i, /\bماك ?بوك\b/] },
  { brand: 'apple',   family: 'airpods',    patterns: [/\bairpods?\b/i, /\bايربودز\b/] },
  { brand: 'samsung', family: 'galaxy s',   patterns: [/\bgalaxy ?s\b/i, /\bجالاكسي ?s\b/i] },
  { brand: 'samsung', family: 'galaxy a',   patterns: [/\bgalaxy ?a\b/i] },
  { brand: 'samsung', family: 'galaxy note', patterns: [/\bgalaxy ?note\b/i, /\bنوت\b/] },
  { brand: 'xiaomi',  family: 'redmi note', patterns: [/\bredmi ?note\b/i, /\bريدمي ?نوت\b/] },
  { brand: 'xiaomi',  family: 'redmi',      patterns: [/\bredmi\b/i, /\bريدمي\b/] },
  { brand: 'xiaomi',  family: 'poco',       patterns: [/\bpoco\b/i, /\bبوكو\b/] },
  { brand: 'sony',    family: 'playstation', patterns: [/\bplaystation\b/i, /\bبلايستيشن\b/] },
]

const VARIANT_SYNONYMS: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: 'pro max', patterns: [/\bpro ?max\b/i, /\bبرو ?ماكس\b/, /\bبروماكس\b/] },
  { canonical: 'ultra',   patterns: [/\bultra\b/i, /\bالترا\b/] },
  { canonical: 'plus',    patterns: [/\bplus\b/i, /\bبلس\b/] },
  { canonical: 'pro',     patterns: [/\bpro\b/i, /\bبرو\b/] },
  { canonical: 'mini',    patterns: [/\bmini\b/i, /\bميني\b/] },
  { canonical: 'lite',    patterns: [/\blite\b/i, /\bلايت\b/] },
  { canonical: 'fe',      patterns: [/\bfe\b/i] },
]

function arabicNumeralsToAscii(s: string) {
  return s
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
}
function normalizeArabic(s: string) {
  return s
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
}
function detectLanguage(s: string): Lang {
  const ar = /[\u0600-\u06FF]/.test(s); const en = /[a-zA-Z]/.test(s)
  if (ar && en) return 'mixed'; if (ar) return 'ar'; return 'en'
}

export function canonicalizeQuery(raw: string): SemanticIntent {
  const trimmed = (raw || '').trim()
  if (!trimmed) return { raw_query: raw, normalized_query: '', language: 'en', intent: 'unknown', entities: {}, confidence: 0 }
  const language = detectLanguage(trimmed)
  const normalized = normalizeArabic(arabicNumeralsToAscii(trimmed.toLowerCase())).replace(/\s+/g, ' ').trim()
  let brand: string | undefined
  for (const b of BRAND_SYNONYMS) if (b.patterns.some(p => p.test(normalized))) { brand = b.canonical; break }
  let family: string | undefined
  const candidates = brand ? FAMILY_SYNONYMS.filter(f => f.brand === brand) : FAMILY_SYNONYMS
  for (const f of candidates) if (f.patterns.some(p => p.test(normalized))) { family = f.family; break }
  let variant: string | undefined
  for (const v of VARIANT_SYNONYMS) if (v.patterns.some(p => p.test(normalized))) { variant = v.canonical; break }
  const numMatch = normalized.match(/\b(\d{1,3})\b/)
  const model_number = numMatch ? numMatch[1] : undefined
  let confidence = 0
  if (brand) confidence += 0.4; if (family) confidence += 0.3
  if (model_number) confidence += 0.2; if (variant) confidence += 0.1
  return {
    raw_query: raw, normalized_query: normalized, language,
    intent: (brand || family || model_number) ? 'buy_product' : 'unknown',
    entities: { brand, product_family: family, variant, model_number },
    confidence: Math.round(confidence * 100) / 100,
  }
}

const STORE_AFFINITY: Record<string, Record<string, number>> = {
  apple:   { 'Amazon Egypt': 0.95, 'B.TECH': 0.85, 'Noon': 0.80, 'Jumia': 0.55, '2B Egypt': 0.50 },
  samsung: { 'B.TECH': 0.95, 'Amazon Egypt': 0.90, 'Noon': 0.80, '2B Egypt': 0.65, 'Jumia': 0.60 },
  xiaomi:  { 'Amazon Egypt': 0.85, 'Jumia': 0.80, 'Noon': 0.75, 'B.TECH': 0.70, '2B Egypt': 0.55 },
  oppo:    { 'Jumia': 0.85, 'Amazon Egypt': 0.80, 'Noon': 0.75, 'B.TECH': 0.65, '2B Egypt': 0.55 },
  huawei:  { 'Jumia': 0.80, 'Amazon Egypt': 0.75, 'Noon': 0.70, 'B.TECH': 0.65, '2B Egypt': 0.55 },
  honor:   { 'Jumia': 0.80, 'Amazon Egypt': 0.75, 'Noon': 0.70, 'B.TECH': 0.65, '2B Egypt': 0.55 },
  sony:    { 'B.TECH': 0.90, '2B Egypt': 0.85, 'Amazon Egypt': 0.75, 'Noon': 0.70, 'Jumia': 0.65 },
  lenovo:  { '2B Egypt': 0.90, 'B.TECH': 0.85, 'Amazon Egypt': 0.75, 'Noon': 0.70, 'Jumia': 0.65 },
  dell:    { '2B Egypt': 0.90, 'B.TECH': 0.85, 'Amazon Egypt': 0.75, 'Noon': 0.65, 'Jumia': 0.60 },
  hp:      { '2B Egypt': 0.90, 'B.TECH': 0.85, 'Amazon Egypt': 0.75, 'Noon': 0.65, 'Jumia': 0.60 },
}
const DEFAULT_AFFINITY: Record<string, number> = {
  'Amazon Egypt': 0.75, 'Noon': 0.70, 'B.TECH': 0.70, 'Jumia': 0.65, '2B Egypt': 0.60,
}

export interface RoutingResult {
  selected: string[]
  confidence: number
  scores: Record<string, number>
}

/**
 * Pick the top-N stores most likely to satisfy the intent.
 * Low-confidence intent (<0.3) → broadcast to ALL stores to preserve coverage.
 */
export function routeStores(
  intent: SemanticIntent,
  availableStores: readonly string[],
  topN = 3,
): RoutingResult {
  const brand = intent.entities.brand
  const affinityMap = brand && STORE_AFFINITY[brand] ? STORE_AFFINITY[brand] : DEFAULT_AFFINITY
  const scores: Record<string, number> = {}
  for (const s of availableStores) scores[s] = affinityMap[s] ?? 0.5
  if (intent.confidence < 0.3) {
    return { selected: [...availableStores], confidence: intent.confidence, scores }
  }
  const ranked = [...availableStores].sort((a, b) => scores[b] - scores[a])
  const selected = ranked.slice(0, Math.max(topN, 1))
  const routingConf = selected.reduce((acc, s) => acc + scores[s], 0) / selected.length
  return { selected, confidence: Math.round(routingConf * 100) / 100, scores }
}

const ACCESSORY_REGEX = /\b(case|cover|wallet|protector|tempered|charger|cable|adapter|holder|stand|mount|earphone|earbuds|headset|strap|band|pouch|sleeve|film|lens protector|جراب|كفر|شاحن|كابل|حامل|واقي شاشه|سكرين|حماي)\b/i

export interface RerankableProduct {
  name: { en: string; ar: string }
  confidenceScore?: number
}

/** Re-rank only — never deletes a product. Score is injected as max(base, computed). */
export function semanticRerank<T extends RerankableProduct>(products: T[], intent: SemanticIntent): T[] {
  if (products.length === 0) return products
  const { brand, product_family: family, variant, model_number: num } = intent.entities
  const isPhoneIntent = ['iphone', 'galaxy s', 'galaxy a', 'galaxy note', 'redmi', 'redmi note', 'mi', 'poco'].includes(family || '')
  const scored = products.map((p) => {
    const titleRaw = `${p.name.en} ${p.name.ar}`
    const title = normalizeArabic(arabicNumeralsToAscii(titleRaw.toLowerCase()))
    let bonus = 0
    if (brand && title.includes(brand)) bonus += 8
    if (family && title.includes(family)) bonus += 12
    if (variant && title.includes(variant)) bonus += 6
    if (num && new RegExp(`\\b${num}\\b`).test(title)) bonus += 8
    if (isPhoneIntent && ACCESSORY_REGEX.test(titleRaw)) bonus -= 25
    const base = p.confidenceScore ?? 0
    const newScore = Math.max(0, Math.min(100, base + bonus))
    return { p, newScore }
  })
  for (const { p, newScore } of scored) {
    p.confidenceScore = Math.max(p.confidenceScore ?? 0, newScore)
  }
  return scored.sort((a, b) => b.newScore - a.newScore).map(x => x.p)
}
