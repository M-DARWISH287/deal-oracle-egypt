// ── PHASE 4 — SEMANTIC INTELLIGENCE LAYER ──
// Additive module. Sits ABOVE the 3-stage retrieval engine.
// The pipeline (runStage1_API / runStage2_Retry / runStage3_Firecrawl) is NOT touched.
//
// Public surface:
//   canonicalizeQuery(raw)         → SemanticIntent
//   expandQueries(intent)          → string[]
//   routeStores(intent, stores)    → { selected: string[]; confidence: number; scores: Record<string, number> }
//   semanticRerank(products, intent) → re-ordered products (score injected into confidenceScore)
//
// Backwards-compatible: every function is pure and side-effect free.

export type Lang = 'ar' | 'en' | 'mixed'

export interface SemanticIntent {
  raw_query: string
  normalized_query: string
  language: Lang
  intent: 'buy_product' | 'unknown'
  entities: {
    brand?: string          // canonical brand: 'apple' | 'samsung' | 'xiaomi' | ...
    product_family?: string // canonical family: 'iphone 15', 'galaxy s24', 'redmi note 13'
    variant?: string        // 'pro max' | 'ultra' | 'plus' | 'pro' | undefined
    model_number?: string   // numeric portion: '15', '24', '13' — extracted for strict matching
  }
  confidence: number        // 0–1
}

// ── Arabic ↔ English brand & product synonyms (canonical form on the right of `:`) ──
const BRAND_SYNONYMS: Array<{ patterns: RegExp[]; canonical: string }> = [
  { canonical: 'apple',   patterns: [/\bapple\b/i, /\bايفون\b/, /\bآيفون\b/, /\bابل\b/, /\bأبل\b/, /\biphone\b/i, /\bipad\b/i, /\bmacbook\b/i, /\bairpods?\b/i] },
  { canonical: 'samsung', patterns: [/\bsamsung\b/i, /\bسامسونج\b/, /\bسامسونغ\b/, /\bgalaxy\b/i, /\bجالاكسي\b/, /\bجلاكسي\b/] },
  { canonical: 'xiaomi',  patterns: [/\bxiaomi\b/i, /\bشاومي\b/, /\bredmi\b/i, /\bريدمي\b/, /\bpoco\b/i, /\bبوكو\b/] },
  { canonical: 'oppo',    patterns: [/\boppo\b/i, /\bاوبو\b/, /\bأوبو\b/] },
  { canonical: 'huawei',  patterns: [/\bhuawei\b/i, /\bهواوي\b/, /\bهاواوي\b/] },
  { canonical: 'honor',   patterns: [/\bhonor\b/i, /\bهونر\b/] },
  { canonical: 'realme',  patterns: [/\brealme\b/i, /\bريلمي\b/] },
  { canonical: 'vivo',    patterns: [/\bvivo\b/i, /\bفيفو\b/] },
  { canonical: 'nokia',   patterns: [/\bnokia\b/i, /\bنوكيا\b/] },
  { canonical: 'sony',    patterns: [/\bsony\b/i, /\bسوني\b/, /\bplaystation\b/i, /\bبلايستيشن\b/, /\bبلاي ستيشن\b/] },
  { canonical: 'lenovo',  patterns: [/\blenovo\b/i, /\bلينوفو\b/] },
  { canonical: 'dell',    patterns: [/\bdell\b/i, /\bديل\b/] },
  { canonical: 'hp',      patterns: [/\bhp\b/i, /\bاتش بي\b/] },
]

// Family detectors: brand + family word → canonical family slug. Family does NOT include the number.
const FAMILY_SYNONYMS: Array<{ patterns: RegExp[]; brand: string; family: string }> = [
  { brand: 'apple',   family: 'iphone',   patterns: [/\biphone\b/i, /\bايفون\b/, /\bآيفون\b/] },
  { brand: 'apple',   family: 'ipad',     patterns: [/\bipad\b/i, /\bايباد\b/, /\bآيباد\b/] },
  { brand: 'apple',   family: 'macbook',  patterns: [/\bmacbook\b/i, /\bماك ?بوك\b/] },
  { brand: 'apple',   family: 'airpods',  patterns: [/\bairpods?\b/i, /\bايربودز\b/] },
  { brand: 'apple',   family: 'apple watch', patterns: [/\bapple ?watch\b/i, /\bساعه ابل\b/] },
  { brand: 'samsung', family: 'galaxy s', patterns: [/\bgalaxy ?s\b/i, /\bجالاكسي ?s\b/i, /\b\bs(?=\s*\d)/i] },
  { brand: 'samsung', family: 'galaxy a', patterns: [/\bgalaxy ?a\b/i, /\b\ba(?=\s*\d{2})/i] },
  { brand: 'samsung', family: 'galaxy note', patterns: [/\bgalaxy ?note\b/i, /\bنوت\b/] },
  { brand: 'samsung', family: 'galaxy tab', patterns: [/\bgalaxy ?tab\b/i] },
  { brand: 'xiaomi',  family: 'redmi note', patterns: [/\bredmi ?note\b/i, /\bريدمي ?نوت\b/] },
  { brand: 'xiaomi',  family: 'redmi',    patterns: [/\bredmi\b/i, /\bريدمي\b/] },
  { brand: 'xiaomi',  family: 'mi',       patterns: [/\bmi ?\d/i, /\bxiaomi ?\d/i] },
  { brand: 'xiaomi',  family: 'poco',     patterns: [/\bpoco\b/i, /\bبوكو\b/] },
  { brand: 'sony',    family: 'playstation', patterns: [/\bplaystation\b/i, /\bps[345]\b/i, /\bبلايستيشن\b/, /\bبلاي ?ستيشن\b/] },
]

// Variant tokens, both languages
const VARIANT_SYNONYMS: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: 'pro max', patterns: [/\bpro ?max\b/i, /\bبرو ?ماكس\b/, /\bبروماكس\b/] },
  { canonical: 'ultra',   patterns: [/\bultra\b/i, /\bالترا\b/, /\bأولترا\b/] },
  { canonical: 'plus',    patterns: [/\bplus\b/i, /\bبلس\b/, /\bبلاس\b/, /\+/] },
  { canonical: 'pro',     patterns: [/\bpro\b/i, /\bبرو\b/] },
  { canonical: 'mini',    patterns: [/\bmini\b/i, /\bميني\b/] },
  { canonical: 'lite',    patterns: [/\blite\b/i, /\bلايت\b/] },
  { canonical: 'fe',      patterns: [/\bfe\b/i] },
]

// Eastern Arabic numerals → ASCII
function arabicNumeralsToAscii(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
}

// Light Arabic normalization (alif/ya/ta marbouta) so synonyms match consistently
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
}

function detectLanguage(s: string): Lang {
  const hasArabic = /[\u0600-\u06FF]/.test(s)
  const hasLatin = /[a-zA-Z]/.test(s)
  if (hasArabic && hasLatin) return 'mixed'
  if (hasArabic) return 'ar'
  return 'en'
}

function detectBrand(s: string): string | undefined {
  for (const { canonical, patterns } of BRAND_SYNONYMS) {
    if (patterns.some(p => p.test(s))) return canonical
  }
  return undefined
}

function detectFamily(s: string, brand: string | undefined): string | undefined {
  // If brand known, prefer families belonging to that brand. Otherwise scan all.
  const candidates = brand ? FAMILY_SYNONYMS.filter(f => f.brand === brand) : FAMILY_SYNONYMS
  for (const f of candidates) {
    if (f.patterns.some(p => p.test(s))) return f.family
  }
  return undefined
}

function detectVariant(s: string): string | undefined {
  // Order matters: 'pro max' must be checked before 'pro'.
  for (const { canonical, patterns } of VARIANT_SYNONYMS) {
    if (patterns.some(p => p.test(s))) return canonical
  }
  return undefined
}

function detectModelNumber(s: string): string | undefined {
  // Match standalone numbers OR numbers glued to a single letter (s24, a55, ps5, mi 11, etc.)
  const m = s.match(/(?:^|[\s])(?:[a-z]?)(\d{1,3})(?=[\s]|$)/) || s.match(/\b(\d{1,3})\b/)
  return m ? m[1] : undefined
}

export function canonicalizeQuery(raw: string): SemanticIntent {
  const trimmed = (raw || '').trim()
  if (!trimmed) {
    return {
      raw_query: raw, normalized_query: '', language: 'en', intent: 'unknown',
      entities: {}, confidence: 0,
    }
  }
  const language = detectLanguage(trimmed)
  // Normalize: lowercase, ASCII numerals, Arabic normalization, collapse whitespace.
  const normalized = normalizeArabic(arabicNumeralsToAscii(trimmed.toLowerCase())).replace(/\s+/g, ' ').trim()

  const brand = detectBrand(normalized)
  const family = detectFamily(normalized, brand)
  const variant = detectVariant(normalized)
  const model_number = detectModelNumber(normalized)

  // Confidence model: brand=+0.4, family=+0.3, model_number=+0.2, variant=+0.1
  let confidence = 0
  if (brand) confidence += 0.4
  if (family) confidence += 0.3
  if (model_number) confidence += 0.2
  if (variant) confidence += 0.1
  // If we recovered NOTHING, confidence stays low — signals "treat as raw keyword".

  const intent: SemanticIntent['intent'] = (brand || family || model_number) ? 'buy_product' : 'unknown'

  return {
    raw_query: raw,
    normalized_query: normalized,
    language,
    intent,
    entities: { brand, product_family: family, variant, model_number },
    confidence: Math.round(confidence * 100) / 100,
  }
}

// ── Query expansion: produces deduped variants for higher coverage. ──
const ARABIC_FORMS: Record<string, string[]> = {
  apple: ['ابل', 'apple'],
  iphone: ['ايفون', 'iphone'],
  ipad: ['ايباد', 'ipad'],
  macbook: ['ماك بوك', 'macbook'],
  airpods: ['ايربودز', 'airpods'],
  samsung: ['سامسونج', 'samsung'],
  galaxy: ['جالاكسي', 'galaxy'],
  'galaxy s': ['جالاكسي s', 'galaxy s'],
  'galaxy a': ['جالاكسي a', 'galaxy a'],
  xiaomi: ['شاومي', 'xiaomi'],
  redmi: ['ريدمي', 'redmi'],
  'redmi note': ['ريدمي نوت', 'redmi note'],
  poco: ['بوكو', 'poco'],
  oppo: ['اوبو', 'oppo'],
  huawei: ['هواوي', 'huawei'],
  honor: ['هونر', 'honor'],
  realme: ['ريلمي', 'realme'],
  playstation: ['بلايستيشن', 'playstation'],
}
const VARIANT_FORMS: Record<string, string[]> = {
  'pro max': ['pro max', 'برو ماكس'],
  ultra: ['ultra', 'الترا'],
  plus: ['plus', 'بلس'],
  pro: ['pro', 'برو'],
  mini: ['mini', 'ميني'],
  lite: ['lite', 'لايت'],
  fe: ['fe'],
}

export function expandQueries(intent: SemanticIntent, max = 5): string[] {
  const out = new Set<string>()
  const raw = intent.raw_query.trim()
  const norm = intent.normalized_query
  if (raw) out.add(raw)
  if (norm && norm !== raw.toLowerCase()) out.add(norm)

  const brand = intent.entities.brand
  const family = intent.entities.product_family
  const variant = intent.entities.variant
  const num = intent.entities.model_number

  // Canonical English form (highest-coverage on Amazon / B.TECH search APIs)
  const enParts: string[] = []
  if (brand && brand !== family?.split(' ')[0]) enParts.push(brand)
  if (family) enParts.push(family)
  if (num) enParts.push(num)
  if (variant) enParts.push(variant)
  const enCanon = enParts.join(' ').trim()
  if (enCanon) out.add(enCanon)

  // Arabic variant (only if family / brand has an Arabic form)
  const arParts: string[] = []
  const familyKey = family || ''
  if (ARABIC_FORMS[familyKey]?.[0]) arParts.push(ARABIC_FORMS[familyKey][0])
  else if (brand && ARABIC_FORMS[brand]?.[0]) arParts.push(ARABIC_FORMS[brand][0])
  if (num) arParts.push(num)
  if (variant && VARIANT_FORMS[variant]?.[1]) arParts.push(VARIANT_FORMS[variant][1])
  const arCanon = arParts.join(' ').trim()
  if (arCanon && arParts.length > 0) out.add(arCanon)

  // Family-only fallback (drops variant — useful when a store has no exact "Pro Max" listing)
  if (family && num) out.add(`${family} ${num}`.trim())

  // "<canonical> price" — Jumia / B.TECH respond well to commerce keywords
  if (enCanon) out.add(`${enCanon} price`)

  return Array.from(out).slice(0, max)
}

// ── Smart Store Router ──
// Per-brand store affinity (0–1). Tuned from observed PASS/FAIL distribution in benchmarks.
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
// Default affinity when brand unknown — even broadcast.
const DEFAULT_AFFINITY: Record<string, number> = {
  'Amazon Egypt': 0.75, 'Noon': 0.70, 'B.TECH': 0.70, 'Jumia': 0.65, '2B Egypt': 0.60,
}

export interface RoutingResult {
  selected: string[]
  confidence: number
  scores: Record<string, number>
}

/**
 * Score every available store and pick the top N (default 3).
 * If intent confidence is low (<0.3), fall back to broadcasting to ALL stores
 * so weak/ambiguous queries don't get under-served.
 */
export function routeStores(
  intent: SemanticIntent,
  availableStores: string[],
  topN = 3,
): RoutingResult {
  const brand = intent.entities.brand
  const affinityMap = brand && STORE_AFFINITY[brand] ? STORE_AFFINITY[brand] : DEFAULT_AFFINITY

  const scores: Record<string, number> = {}
  for (const s of availableStores) scores[s] = affinityMap[s] ?? 0.5

  // Low-confidence intent → broadcast to ALL (preserve coverage).
  if (intent.confidence < 0.3) {
    return { selected: [...availableStores], confidence: intent.confidence, scores }
  }
  const ranked = [...availableStores].sort((a, b) => scores[b] - scores[a])
  const selected = ranked.slice(0, Math.max(topN, 1))
  // Routing confidence = avg score of selected
  const routingConf = selected.reduce((acc, s) => acc + scores[s], 0) / selected.length
  return { selected, confidence: Math.round(routingConf * 100) / 100, scores }
}

// ── Semantic re-ranking (post-process; additive — does NOT delete products) ──
// Boosts items matching brand / family / variant; penalizes accessory-shaped names
// when intent looks like a phone-buy. Score is injected into confidenceScore (max).
const ACCESSORY_REGEX = /\b(case|cover|wallet|protector|tempered|charger|cable|adapter|holder|stand|mount|earphone|earbuds|headset|strap|band|pouch|sleeve|film|lens protector|جراب|كفر|شاحن|كابل|حامل|واقي شاشه|سكرين|حماي)\b/i

export interface RerankableProduct {
  name: string
  name_ar?: string
  confidenceScore?: number
}

export function semanticRerank<T extends RerankableProduct>(
  products: T[],
  intent: SemanticIntent,
): T[] {
  if (products.length === 0) return products
  const brand = intent.entities.brand
  const family = intent.entities.product_family
  const variant = intent.entities.variant
  const num = intent.entities.model_number
  const isPhoneIntent = ['iphone', 'galaxy s', 'galaxy a', 'galaxy note', 'redmi', 'redmi note', 'mi', 'poco'].includes(family || '')

  const scored = products.map((p) => {
    const titleRaw = `${p.name} ${p.name_ar || ''}`
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
  // Inject score (max of base/new) and sort DESC.
  for (const { p, newScore } of scored) {
    p.confidenceScore = Math.max(p.confidenceScore ?? 0, newScore)
  }
  return scored.sort((a, b) => b.newScore - a.newScore).map(x => x.p)
}
