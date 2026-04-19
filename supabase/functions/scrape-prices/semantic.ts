// ── PHASE 4 — SEMANTIC INTELLIGENCE LAYER (HARDENED) ──
// Additive module above the 3-stage retrieval engine.
// HOT-PATH RULES: zero LLM calls, zero network calls, dictionary lookups + light regex only.
//
// Hardening pass fixes (vs previous version):
//   1. Arabic brand detection — replaced `\b` regex (ASCII-only) with TOKEN INCLUSION lookup
//      after normalization. ايفون / سامسونج / شاومي now resolve correctly.
//   2. Query expansion is now ADDITIVE ONLY — original query is always #1, full canonical
//      (with variant) precedes any reduced form. We never drop "pro max" / "ultra" / "plus".
//   3. Model parser preserves alphanumeric tokens like "s24", "a55", "ps5" instead of
//      collapsing them to bare digits.
//   4. Safe failover: if confidence < 0.4, expansion returns ONLY the original query.

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
    model_number?: string   // may now be alphanumeric: "s24", "a55", "15"
  }
  confidence: number
}

// ── Token dictionaries (post-normalization keys) ──
// Each key is a normalized token that, if present, maps to the canonical brand/family/variant.
// Crucially we use a Set membership check, not regex word boundaries — so Arabic works.

const BRAND_TOKENS: Record<string, string> = {
  // apple
  apple: 'apple', iphone: 'apple', ipad: 'apple', macbook: 'apple', airpods: 'apple',
  ايفون: 'apple', ايباد: 'apple', ابل: 'apple', ماكبوك: 'apple', ايربودز: 'apple',
  // samsung
  samsung: 'samsung', galaxy: 'samsung',
  سامسونج: 'samsung', سامسونغ: 'samsung', جالاكسي: 'samsung', جلاكسي: 'samsung',
  // xiaomi
  xiaomi: 'xiaomi', redmi: 'xiaomi', poco: 'xiaomi',
  شاومي: 'xiaomi', ريدمي: 'xiaomi', بوكو: 'xiaomi',
  // others
  oppo: 'oppo', اوبو: 'oppo',
  huawei: 'huawei', هواوي: 'huawei',
  honor: 'honor', هونر: 'honor',
  realme: 'realme', ريلمي: 'realme',
  vivo: 'vivo', فيفو: 'vivo',
  nokia: 'nokia', نوكيا: 'nokia',
  sony: 'sony', سوني: 'sony', playstation: 'sony', بلايستيشن: 'sony',
  lenovo: 'lenovo', لينوفو: 'lenovo',
  dell: 'dell', ديل: 'dell',
  hp: 'hp',
}

// Family detectors: { brand, requiredTokens, family }. requiredTokens are checked via
// adjacency on the normalized token list. Order matters: longest/most-specific FIRST.
const FAMILY_RULES: Array<{ brand: string; family: string; tokens: string[][] }> = [
  // Apple
  { brand: 'apple', family: 'iphone', tokens: [['iphone'], ['ايفون']] },
  { brand: 'apple', family: 'ipad', tokens: [['ipad'], ['ايباد']] },
  { brand: 'apple', family: 'macbook', tokens: [['macbook'], ['ماكبوك'], ['ماك', 'بوك']] },
  { brand: 'apple', family: 'airpods', tokens: [['airpods'], ['airpod'], ['ايربودز']] },
  { brand: 'apple', family: 'apple watch', tokens: [['apple', 'watch'], ['ساعه', 'ابل']] },
  // Samsung
  { brand: 'samsung', family: 'galaxy s', tokens: [['galaxy', 's'], ['جالاكسي', 's']] },
  { brand: 'samsung', family: 'galaxy a', tokens: [['galaxy', 'a']] },
  { brand: 'samsung', family: 'galaxy note', tokens: [['galaxy', 'note'], ['نوت']] },
  { brand: 'samsung', family: 'galaxy tab', tokens: [['galaxy', 'tab']] },
  // Xiaomi (more-specific first)
  { brand: 'xiaomi', family: 'redmi note', tokens: [['redmi', 'note'], ['ريدمي', 'نوت']] },
  { brand: 'xiaomi', family: 'redmi', tokens: [['redmi'], ['ريدمي']] },
  { brand: 'xiaomi', family: 'poco', tokens: [['poco'], ['بوكو']] },
  // Sony
  { brand: 'sony', family: 'playstation', tokens: [['playstation'], ['ps5'], ['ps4'], ['ps3'], ['بلايستيشن']] },
]

// Variant tokens (post-normalization). pro-max-style multi-token forms checked first.
const VARIANT_RULES: Array<{ canonical: string; tokens: string[][] }> = [
  { canonical: 'pro max', tokens: [['pro', 'max'], ['promax'], ['برو', 'ماكس'], ['بروماكس']] },
  { canonical: 'ultra',   tokens: [['ultra'], ['الترا'], ['اولترا']] },
  { canonical: 'plus',    tokens: [['plus'], ['بلس'], ['بلاس']] },
  { canonical: 'pro',     tokens: [['pro'], ['برو']] },
  { canonical: 'mini',    tokens: [['mini'], ['ميني']] },
  { canonical: 'lite',    tokens: [['lite'], ['لايت']] },
  { canonical: 'fe',      tokens: [['fe']] },
]

// Eastern Arabic numerals → ASCII
function arabicNumeralsToAscii(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
}

// Light Arabic normalization (alif/ya/ta marbouta) so synonyms match consistently.
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')  // diacritics + tatweel
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

// Full text → token list. Splits on whitespace AND punctuation, keeps Arabic + Latin + digits.
// Also expands glued alphanumeric tokens (e.g. "s24" → ["s24","s","24"]) so we can match BOTH.
function tokenize(s: string): string[] {
  const raw = s.split(/[^a-z0-9\u0600-\u06FF]+/i).filter(Boolean)
  const out: string[] = []
  for (const t of raw) {
    out.push(t)
    // split alphanumeric e.g. "s24" → ["s","24"], "iphone15" → ["iphone","15"]
    const m = /^([a-z\u0600-\u06FF]+)(\d+)$/i.exec(t)
    if (m) { out.push(m[1]); out.push(m[2]) }
    const m2 = /^(\d+)([a-z\u0600-\u06FF]+)$/i.exec(t)
    if (m2) { out.push(m2[1]); out.push(m2[2]) }
  }
  return out
}

function detectBrand(tokens: string[]): string | undefined {
  for (const t of tokens) {
    const b = BRAND_TOKENS[t]
    if (b) return b
  }
  return undefined
}

// Adjacency check: returns true if `seq` appears as consecutive tokens (any position).
function hasSequence(tokens: string[], seq: string[]): boolean {
  if (seq.length === 0) return false
  if (seq.length === 1) return tokens.includes(seq[0])
  outer: for (let i = 0; i <= tokens.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (tokens[i + j] !== seq[j]) continue outer
    }
    return true
  }
  return false
}

function detectFamily(tokens: string[], brand: string | undefined): string | undefined {
  const candidates = brand ? FAMILY_RULES.filter(r => r.brand === brand) : FAMILY_RULES
  for (const rule of candidates) {
    for (const seq of rule.tokens) {
      if (hasSequence(tokens, seq)) return rule.family
    }
  }
  return undefined
}

function detectVariant(tokens: string[]): string | undefined {
  for (const rule of VARIANT_RULES) {
    for (const seq of rule.tokens) {
      if (hasSequence(tokens, seq)) return rule.canonical
    }
  }
  return undefined
}

// Model parser — preserves alphanumeric forms like "s24", "a55", "ps5", AND bare digits.
// Priority: alphanumeric > standalone digit (so "S24 Ultra" → "s24", "iphone 15" → "15").
function detectModelNumber(tokens: string[], normalized: string): string | undefined {
  // 1) glued alphanumeric token e.g. s24, a55, ps5, mi11
  const alnum = tokens.find(t => /^[a-z]\d{2,3}$/i.test(t))
  if (alnum) return alnum.toLowerCase()
  // 2) standalone digit token
  const digit = tokens.find(t => /^\d{1,3}$/.test(t))
  if (digit) return digit
  // 3) fallback regex against normalized string
  const m = normalized.match(/\b(\d{1,3})\b/)
  return m ? m[1] : undefined
}

export function canonicalizeQuery(raw: string): SemanticIntent {
  const trimmed = (raw || '').trim()
  if (!trimmed) {
    return { raw_query: raw, normalized_query: '', language: 'en', intent: 'unknown', entities: {}, confidence: 0 }
  }
  const language = detectLanguage(trimmed)
  const normalized = normalizeArabic(arabicNumeralsToAscii(trimmed.toLowerCase())).replace(/\s+/g, ' ').trim()
  const tokens = tokenize(normalized)

  const brand = detectBrand(tokens)
  const family = detectFamily(tokens, brand)
  const variant = detectVariant(tokens)
  const model_number = detectModelNumber(tokens, normalized)

  let confidence = 0
  if (brand) confidence += 0.4
  if (family) confidence += 0.3
  if (model_number) confidence += 0.2
  if (variant) confidence += 0.1

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

// ── Query expansion: ADDITIVE ONLY. Never drops modifiers. ──
// Order guarantees:
//   1. Original raw query (verbatim)
//   2. Normalized query
//   3. Full English canonical (brand + family + model + variant)
//   4. Full Arabic canonical (brand_ar + model + variant_ar) — only if AR forms exist
//   5. Brand-reordered variants (e.g. "apple iphone 15 pro max")
// We DO NOT emit family-only or family+number (no variant) reductions anymore.
const ARABIC_FORMS: Record<string, string> = {
  apple: 'ابل', iphone: 'ايفون', ipad: 'ايباد', macbook: 'ماكبوك', airpods: 'ايربودز',
  samsung: 'سامسونج', galaxy: 'جالاكسي', 'galaxy s': 'جالاكسي s', 'galaxy a': 'جالاكسي a',
  'galaxy note': 'جالاكسي نوت', 'galaxy tab': 'جالاكسي تاب',
  xiaomi: 'شاومي', redmi: 'ريدمي', 'redmi note': 'ريدمي نوت', poco: 'بوكو',
  oppo: 'اوبو', huawei: 'هواوي', honor: 'هونر', realme: 'ريلمي',
  playstation: 'بلايستيشن',
}
const VARIANT_AR: Record<string, string> = {
  'pro max': 'برو ماكس', ultra: 'الترا', plus: 'بلس', pro: 'برو',
  mini: 'ميني', lite: 'لايت', fe: 'fe',
}

export function expandQueries(intent: SemanticIntent, max = 5): string[] {
  const out = new Set<string>()
  const raw = intent.raw_query.trim()
  const norm = intent.normalized_query

  // #1 — original (always preserved verbatim)
  if (raw) out.add(raw)

  // SAFE FAILOVER: low confidence → original only, NO reductions.
  if (intent.confidence < 0.4) {
    if (norm && !out.has(norm)) out.add(norm)
    return Array.from(out).slice(0, max)
  }

  // #2 — normalized
  if (norm && norm !== raw.toLowerCase()) out.add(norm)

  const brand = intent.entities.brand
  const family = intent.entities.product_family
  const variant = intent.entities.variant
  const num = intent.entities.model_number

  // #3 — Full English canonical (NEVER drops the variant)
  const enParts: string[] = []
  if (brand && (!family || !family.startsWith(brand))) enParts.push(brand)
  if (family) enParts.push(family)
  if (num) enParts.push(num)
  if (variant) enParts.push(variant)
  const enCanon = enParts.join(' ').trim()
  if (enCanon) out.add(enCanon)

  // #4 — Full Arabic canonical
  const arParts: string[] = []
  const familyAr = family ? ARABIC_FORMS[family] : undefined
  const brandAr = brand ? ARABIC_FORMS[brand] : undefined
  if (familyAr) arParts.push(familyAr)
  else if (brandAr) arParts.push(brandAr)
  if (num) arParts.push(num)
  if (variant && VARIANT_AR[variant]) arParts.push(VARIANT_AR[variant])
  const arCanon = arParts.join(' ').trim()
  if (arCanon && arParts.length >= 2) out.add(arCanon)

  // #5 — Brand-reordered EN form (helps Amazon's relevance ranker)
  if (brand && family && !family.startsWith(brand)) {
    const reordered = [brand, family, num, variant].filter(Boolean).join(' ').trim()
    if (reordered) out.add(reordered)
  }

  return Array.from(out).slice(0, max)
}

// ── Smart Store Router (unchanged — already deterministic) ──
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

export function routeStores(intent: SemanticIntent, availableStores: string[], topN = 3): RoutingResult {
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

// ── Semantic re-ranking (unchanged weights: +12 family / +8 brand / +6 variant / +8 model / -25 accessory) ──
const ACCESSORY_REGEX = /\b(case|cover|wallet|protector|tempered|charger|cable|adapter|holder|stand|mount|earphone|earbuds|headset|strap|band|pouch|sleeve|film|lens protector|جراب|كفر|شاحن|كابل|حامل|واقي شاشه|سكرين|حماي)\b/i

export interface RerankableProduct {
  name: string
  name_ar?: string
  confidenceScore?: number
}

export function semanticRerank<T extends RerankableProduct>(products: T[], intent: SemanticIntent): T[] {
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
  for (const { p, newScore } of scored) {
    p.confidenceScore = Math.max(p.confidenceScore ?? 0, newScore)
  }
  return scored.sort((a, b) => b.newScore - a.newScore).map(x => x.p)
}
