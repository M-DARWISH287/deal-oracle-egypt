import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// PHASE 4 — semantic intelligence layer (additive; pipeline untouched)
import { canonicalizeQuery, expandQueries, semanticRerank, routeStores, type SemanticIntent } from './semantic.ts'
import { runBenchmark } from './benchmark.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Global persistent cache TTL: 3h (Supabase-backed `search_cache`, key = store:query).
// Persistent across cold starts and shared across all edge function invocations.
const CACHE_TTL_HOURS = 3
const MINIMUM_PRICE_THRESHOLD = 1500
const STORE_TIMEOUT_MS = 15000

// ── 3-STAGE DETERMINISTIC RETRIEVAL ENGINE ──
// Each stage has its OWN timeout (Part 10 — safety guards).
// Stage 1 (API) — primary native scraper, default UA + params.
// Stage 2 (RETRY) — same scraper, modified request (UA rotation + page/size flip + jitter).
// Stage 3 (FIRECRAWL) — multi-strategy LLM extraction fallback.
const STAGE1_TIMEOUT_MS = 6000   // bumped from 3s — B.TECH Server Action regularly takes 4-6s
const STAGE2_TIMEOUT_MS = 8000   // retry needs more headroom (server may be slower under load)
const FIRECRAWL_TIMEOUT_MS = 90000
// Global budget per request (Part 10): if pipeline exceeds this, we stop and return what we have.
const MAX_TOTAL_MS = 20000

// Quality gates (Part 5 — strict success criteria):
const MIN_RELEVANCE_SCORE = 60       // any product below this is treated as INVALID
const EARLY_EXIT_MIN_ITEMS = 5       // Part 9 — early exit threshold
const EARLY_EXIT_MIN_RELEVANCE = 80  // Part 9 — early exit threshold

// Stage label union (Part 1 — single source of truth).
type StageUsed = 'API' | 'RETRY' | 'FIRECRAWL' | 'FAIL'

// Promise.race helper: resolves with [] if the underlying scraper exceeds timeoutMs.
function raceWithTimeout<T>(p: Promise<T[]>, timeoutMs: number, label: string): Promise<T[]> {
  return Promise.race([
    p,
    new Promise<T[]>((resolve) => setTimeout(() => {
      console.log(`[${label}] exceeded ${timeoutMs}ms — aborting stage`)
      resolve([])
    }, timeoutMs)),
  ])
}

// Sleep helper for Stage 2 jitter (300-800ms randomized).
function jitterSleep(): Promise<void> {
  const ms = 300 + Math.floor(Math.random() * 500)
  return new Promise((r) => setTimeout(r, ms))
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Stage-2 alternate UA (Firefox/Linux) — different fingerprint from STEALTH_HEADERS Safari/macOS UA.
const USER_AGENT_ALT = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'

// Stealth headers used for Amazon / anti-bot stores
const STEALTH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

// Stage-2 alternate header set: Firefox/Linux UA + en-GB locale + no Sec-Fetch-* hints
// (different request fingerprint to dodge UA-based rate limits / soft blocks).
const STEALTH_HEADERS_ALT: Record<string, string> = {
  'User-Agent': USER_AGENT_ALT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Upgrade-Insecure-Requests': '1',
}

// ── Types ──
interface RawProduct {
  name: string; name_ar?: string; price: number | string;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
  confidenceScore?: number;
}

type ScrapeMethod = 'native' | 'firecrawl'

type ScrapeStage = 1 | 2;
interface StoreConfig {
  searchUrl: (q: string) => string;
  method: ScrapeMethod;
  tier: 1 | 2 | 3;
  // Native scraper accepts an optional stage flag: stage=2 enables UA rotation +
  // modified request params (different page/size). See 3-stage retrieval algorithm.
  nativeScraper?: (q: string, stage?: ScrapeStage) => Promise<RawProduct[]>;
}

// ── Helpers ──
function parsePrice(text: string | number | undefined | null): number | null {
  if (text === null || text === undefined) return null
  const str = String(text)
  if (!str) return null
  const cleaned = str
    .replace(/شهري[اً]?|قسط|monthly|\/month/gi, '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/,/g, '')
    .replace(/[^0-9.]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

function checkRefurbished(name: string): boolean {
  return /restored|renewed|refurbished|مجدد/i.test(name)
}

const BRAND_EXCLUSIONS: Record<string, string[]> = {
  iphone: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'realme', 'huawei', 'honor', 'vivo', 'tecno', 'infinix', 'nokia'],
  apple: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'huawei', 'honor', 'vivo'],
  ipad: ['samsung', 'galaxy', 'tab ', 'lenovo', 'huawei'],
  macbook: ['samsung', 'lenovo', 'hp ', 'dell', 'asus', 'acer'],
  samsung: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo', 'huawei'],
  galaxy: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo'],
  xiaomi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  redmi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  oppo: ['iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi'],
  huawei: ['iphone', 'samsung', 'galaxy', 'xiaomi'],
}

function matchesIntent(query: string, productName: string): boolean {
  const q = query.toLowerCase(); const n = productName.toLowerCase()
  if (!q.includes('max') && !q.includes('ultra')) {
    if (n.includes('pro max') || n.includes('ultra')) return false
  }
  for (const [brandKw, excluded] of Object.entries(BRAND_EXCLUSIONS)) {
    if (q.includes(brandKw)) {
      if (excluded.some(bad => n.includes(bad))) return false
    }
  }
  return true
}

// MOBILE-STRICT: drop accessories AND non-mobile categories.
// CRITICAL: keywords must NOT overlap with phone-spec language. e.g. 'شاشة' (screen)
// appears in nearly every Arabic phone listing → CANNOT be a kill keyword. Same for
// 'monitor', 'speaker', 'headphone' (phones mention these in marketing copy/specs).
const ACCESSORY_KEYWORDS = [
  // Pure accessories (EN)
  'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder', 'phone stand', 'phone mount',
  'earphone', 'earbuds', 'headset', 'strap', 'wristband', 'pouch', 'sleeve',
  'lens protector', 'camera protector', 'lens cover',
  // Pure accessories (AR)
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة', 'سكرين بروتكتور', 'حماية شاشة',
  // Distinct non-mobile categories (EN) — phrases that only appear in non-phone titles
  'smartwatch', 'smart watch', 'galaxy watch', 'apple watch',
  'laptop', 'notebook pc', 'macbook',
  'tablet', 'ipad ', 'galaxy tab',
  'television', 'smart tv', 'led tv', 'lcd tv', 'qled', 'oled tv',
  // Distinct non-mobile categories (AR)
  'لاب توب', 'لابتوب', 'تابلت', 'تلفزيون', 'تليفزيون', 'ساعة ذكية', 'ساعة سامسونج', 'ساعة ابل',
]
// Word-boundary patterns: words like "case" / "cover" / "wallet" can appear separated
// by punctuation ("Wallet Case,Black"), so substring matching with trailing-space fails.
const ACCESSORY_REGEX = /\b(case|cover|wallet case|flip cover|back cover|skin)\b/i
function isAccessory(name: string): boolean {
  if (ACCESSORY_REGEX.test(name)) return true
  const lower = ` ${name.toLowerCase()} `
  return ACCESSORY_KEYWORDS.some(kw => lower.includes(kw))
}

const OUT_OF_STOCK_KEYWORDS = [
  'out of stock', 'sold out', 'unavailable', 'currently unavailable',
  'نفدت الكمية', 'غير متوفر', 'نفذت الكمية', 'غير متاح',
]
function isOutOfStock(blob: string): boolean {
  const lower = blob.toLowerCase()
  return OUT_OF_STOCK_KEYWORDS.some(kw => lower.includes(kw))
}

// ── GLOBAL RELEVANCE VALIDATOR ──
// Generic, brand-agnostic, scalable. No hardcoded brand lists, no category assumptions.
// Rules:
//   1. Normalize: case-fold, strip diacritics, fold Arabic letter variants (أإآ→ا, ى→ي, ة→ه).
//   2. Tokenize: split on whitespace + punctuation, drop tokens shorter than 2 chars.
//   3. Numeric tokens MUST match exactly. Query "11" must NOT match title "15".
//      Every numeric token in the query must appear verbatim in the title.
//   4. Non-numeric tokens: require ≥60% overlap (rounded up). For 1-token queries,
//      that single token must be present.
function normalizeForRelevance(s: string): string {
  if (!s) return ''
  return s
    .toLowerCase()
    // Convert Arabic-Indic digits → ASCII so "١٥" matches "15"
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
    // Strip Arabic diacritics (tashkeel) and tatweel
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    // Fold Arabic letter variants
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    // Strip Latin combining marks (NFD then remove diacritics)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function tokenizeForRelevance(s: string): string[] {
  return normalizeForRelevance(s)
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter(t => t.length >= 2)
}

export interface RelevanceResult {
  isRelevant: boolean;
  score: number;
}

export function validateRelevance(query: string, title: string): RelevanceResult {
  const qTokens = tokenizeForRelevance(query)
  const tTokens = tokenizeForRelevance(title)
  if (qTokens.length === 0 || tTokens.length === 0) return { isRelevant: false, score: 0 }

  const tSet = new Set(tTokens)
  const qNumbers = qTokens.filter(t => /^\d+$/.test(t))
  const qWords = qTokens.filter(t => !/^\d+$/.test(t))

  // Rule 3: every query number MUST appear verbatim. Strict numeric match (instant fail).
  for (const n of qNumbers) {
    if (!tSet.has(n)) return { isRelevant: false, score: 0 }
  }

  // Rule 4: word overlap. Require ≥60% of query words to appear in title.
  const allQ = qWords.length > 0 ? qWords : qNumbers
  let hits = 0
  for (const w of qWords) if (tSet.has(w)) hits++
  // numeric tokens already validated above as present, count them as hits too
  const numericHits = qNumbers.length
  const totalHits = hits + numericHits
  const totalQ = qWords.length + qNumbers.length
  const overlapPct = totalQ > 0 ? (totalHits / totalQ) * 100 : 0

  // Substring bonus: full normalized query found inside normalized title
  const normQ = normalizeForRelevance(query).trim()
  const normT = normalizeForRelevance(title)
  const substringBonus = normQ.length > 0 && normT.includes(normQ) ? 20 : 0

  const score = Math.min(100, Math.round(overlapPct + substringBonus))

  // Gate: numbers required (already enforced) + ≥60% word overlap when words exist
  let isRelevant: boolean
  if (qWords.length === 0) {
    isRelevant = qNumbers.length > 0
  } else {
    const required = Math.max(1, Math.ceil(qWords.length * 0.6))
    isRelevant = hits >= required
  }
  return { isRelevant, score }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

// ── Strip strikethrough/old prices BEFORE extracting candidates ──
// 2B, B.TECH, RayaShop, etc. all wrap the crossed-out original price in
// <span class="old-price">…</span> or <s>/<del>. Removing those nodes first
// guarantees Math.min() won't accidentally pick the higher original price.
function stripOldPriceNodes(block: string): string {
  return block
    // Magento-style old price wrappers (any tag, any depth — remove via greedy class match)
    .replace(/<(span|div|p)[^>]*class="[^"]*\b(old-price|price-was|regular-price|compare-at-price)\b[^"]*"[\s\S]*?<\/\1>/gi, ' ')
    // <s> and <del> strikethrough
    .replace(/<(s|del|strike)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

// Extract ALL prices from a block and return the LOWEST.
// CRITICAL: strip old/strikethrough price nodes first (2B "crossed-out price" bug).
function extractLowestPrice(block: string): string | null {
  const cleaned = stripOldPriceNodes(block)
  const candidates: number[] = []

  // Magento explicit "final price" data attribute → highest priority
  const finalPriceRe = /data-price-type="finalPrice"[^>]*data-price-amount="([0-9.]+)"|data-price-amount="([0-9.]+)"[^>]*data-price-type="finalPrice"/g
  let m: RegExpExecArray | null
  while ((m = finalPriceRe.exec(cleaned)) !== null) {
    const n = parseFloat(m[1] || m[2]); if (!isNaN(n) && n > 0) candidates.push(n)
  }
  // Generic Magento data-price-amount (already cleaned of old-price)
  const dataPriceRe = /data-price-amount="([0-9.]+)"/g
  while ((m = dataPriceRe.exec(cleaned)) !== null) {
    const n = parseFloat(m[1]); if (!isNaN(n) && n > 0) candidates.push(n)
  }
  // .special-price wrapper (Magento sale price)
  const specialPriceRe = /<(?:span|div)[^>]*class="[^"]*\bspecial-price\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/gi
  while ((m = specialPriceRe.exec(cleaned)) !== null) {
    const num = parsePrice(stripTags(m[1]))
    if (num !== null && num > 0) candidates.push(num)
  }
  // EGP / LE / ج.م amounts
  const egpRe = /(\d[\d,]{2,})(?:\.\d+)?\s*(?:EGP|ج\.م|LE|جنيه)/gi
  while ((m = egpRe.exec(cleaned)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(n) && n > 0) candidates.push(n)
  }
  // Generic price-class spans
  const priceSpanRe = /<(?:span|div|p|strong)[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p|strong)>/gi
  while ((m = priceSpanRe.exec(cleaned)) !== null) {
    const num = parsePrice(stripTags(m[1]))
    if (num !== null && num > 0) candidates.push(num)
  }
  if (candidates.length === 0) return null
  return String(Math.min(...candidates))
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null
  let url: string
  try {
    url = href.startsWith('http') ? href : new URL(href, baseUrl).toString()
  } catch { return null }
  const lower = url.toLowerCase()
  const reject = ['add-to-cart', 'addtocart', '/cart', '/login', '/account', '/wishlist',
                  '/checkout', '/customer/', 'logout', 'javascript:', 'mailto:', '#',
                  '/category/', '/brand/', '/compare']
  if (reject.some(r => lower.includes(r))) return null
  return url
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = STORE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        ...(opts.headers || {}),
      },
    })
  } finally { clearTimeout(timeout) }
}

// Per-item gate used by streaming scrapers: accessory + out-of-stock + relevance.
// Returns the relevance score on accept, or null on reject.
function acceptItem(name: string, specs: string | undefined, query: string, storeName: string): number | null {
  const blob = `${name} ${specs || ''}`
  if (isAccessory(blob)) return null
  if (isOutOfStock(blob)) return null
  const rel = validateRelevance(query, name)
  if (!rel.isRelevant) {
    console.log(`[${storeName}] Relevance reject: "${name.slice(0, 80)}"`)
    return null
  }
  return rel.score
}

function normalizeProducts(items: Partial<RawProduct>[], storeName: string, query: string): RawProduct[] {
  const scored: Array<{ item: Partial<RawProduct>; score: number }> = []
  for (const p of items) {
    if (!p.name || !p.url) continue
    const score = acceptItem(String(p.name), p.specs, query, storeName)
    if (score === null) continue
    scored.push({ item: p, score })
  }
  return scored
    .slice(0, 5)
    .map(({ item: p, score }) => {
      const parsed = parsePrice(p.price as any)
      return {
        name: String(p.name),
        name_ar: p.name_ar || String(p.name),
        price: parsed ?? 0,
        url: String(p.url),
        image: p.image || '',
        specs: p.specs || '',
        store: storeName,
        isRefurbished: checkRefurbished(String(p.name)),
        confidenceScore: score,
      }
    })
    .filter(p => (p.price as number) >= MINIMUM_PRICE_THRESHOLD)
}

// ════════════════════════════════════════════════════════════════════
// NATIVE SCRAPERS — BIG 5 (Amazon EG, Jumia, B.TECH via Server Action)
// Only Noon and 2B Egypt route directly to Firecrawl (heavy WAF/Cloudflare).
// ════════════════════════════════════════════════════════════════════

// ── B.TECH: Next.js Server Action (no DOM scraping, no Firecrawl) ──
// btech.com is a Next.js App Router site. Its product search is exposed as a
// React Server Action that returns a clean JSON payload:
//   POST https://btech.com/en
//   Header: Next-Action: <action-id>
//   Body:   [{"search":"<query>","page":"1","size":50}]
// Response is an RSC stream where the line beginning with "1:" contains the
// JSON {data:{items:[...]}}. We fetch this directly — no headless browser,
// no Firecrawl, sub-2s latency, structured fields (title/price/slug/image).
//
// Action ID is hard-coded after being lifted from the publicly served chunks
// (createServerReference("40a804c5...","getProductsByFilterAction")). If B.TECH
// rebuilds and the ID rotates, this scraper returns [] and the Safety Valve
// fires Firecrawl as a backup.
const BTECH_ACTION_ID = '40a804c5a288e7f0b2b0feac959c350b1fff3a3678'
const BTECH_CDN_BASE = 'https://dwecxxryy5p59.cloudfront.net/'

interface BTechItem {
  offering_id?: string
  variant_id?: string
  title?: string
  slug?: string
  brand?: string
  main_image?: string
  price?: { final?: string; base?: string; final_float_price?: string; currency?: string }
  categories_tree?: string[]
}

async function scrapeBTech(query: string, stage: ScrapeStage = 1): Promise<RawProduct[]> {
  // Stage 1: page=1, size=50, Safari UA. Stage 2: page=2, size=30, Firefox UA.
  const isStage2 = stage === 2
  const body = JSON.stringify([{ search: query, page: isStage2 ? '2' : '1', size: isStage2 ? 30 : 50 }])
  const tag = `B.TECH stage-${stage}`
  let res: Response
  try {
    res = await fetchWithTimeout('https://btech.com/en', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/x-component',
        'Next-Action': BTECH_ACTION_ID,
        'Origin': 'https://btech.com',
        'Referer': 'https://btech.com/en',
        ...(isStage2 ? STEALTH_HEADERS_ALT : STEALTH_HEADERS),
      },
      body,
    }, 10000)
  } catch (err) {
    console.error(`[${tag}] Server Action fetch failed:`, err)
    return []
  }
  if (!res.ok) { console.error(`[${tag}] Server Action HTTP ${res.status}`); return [] }
  const text = await res.text()

  // RSC stream: lines like "<hex-id>:<json>". Find the line whose JSON contains
  // .data.items — defensive scan in case Next.js changes the line ID on rebuild.
  let payload: { data?: { items?: BTechItem[] } } | null = null
  for (const ln of text.split('\n')) {
    const m = ln.match(/^[0-9a-f]+:(\{.*\})$/)
    if (!m) continue
    try {
      const parsed = JSON.parse(m[1])
      if (parsed && parsed.data && Array.isArray(parsed.data.items)) { payload = parsed; break }
    } catch { /* skip non-JSON RSC frames */ }
  }
  const items = payload?.data?.items || []
  if (items.length === 0) { console.warn(`[${tag}] Server Action: 0 items in payload`); return [] }
  console.log(`[${tag}] Server Action: ${items.length} raw items`)

  // Map to the shape normalizeProducts() expects, then run the shared accept
  // gate (relevance + accessories + score + price floor; caps at 5 items).
  const mapped: Partial<RawProduct>[] = items
    .filter(it => it && it.title && it.slug && it.price)
    .map(it => ({
      name: String(it.title),
      name_ar: String(it.title),
      price: it.price?.final_float_price || it.price?.final || it.price?.base || '',
      url: `https://btech.com/en/${it.slug}`,
      image: it.main_image ? `${BTECH_CDN_BASE}${it.main_image}` : '',
      specs: (it.categories_tree || []).join(' › '),
      store: 'B.TECH',
    }))

  return normalizeProducts(mapped, 'B.TECH', query)
}


// Jumia: HTML with article.prd elements (current DOM uses <article class="prd _fb col c-prd">)
// MOBILE FOCUS: Jumia's bare search floods accessories. Append "smartphone" to disambiguate.
// PROGRESSIVE FALLBACK: stream up to ~25 cards. If zero valid phones surface in that
// initial batch, signal an early Firecrawl fallback (prevents 200-card full-DOM walks
// that always return 0 for high-end phones).
const JUMIA_EARLY_FALLBACK_BATCH = 25

async function scrapeJumia(query: string, stage: ScrapeStage = 1): Promise<RawProduct[]> {
  const tag = `Jumia native stage-${stage}`
  try {
    const mobileQuery = `${query} smartphone`
    const pageParam = stage === 2 ? '&page=2' : ''
    const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(mobileQuery)}${pageParam}`
    const headers = stage === 2 ? STEALTH_HEADERS_ALT : undefined
    const res = await fetchWithTimeout(url, headers ? { headers } : {})
    if (!res.ok) { console.log(`[${tag}] HTTP ${res.status}`); return [] }
    const html = await res.text()

    // ── STREAMING extraction with EARLY FALLBACK GATE ──
    // Walk articles one at a time, filter per-node. After scanning the first
    // JUMIA_EARLY_FALLBACK_BATCH cards, if zero valid phones found → bail with []
    // so the Safety Valve immediately routes to Firecrawl (no full-DOM iteration).
    const articleRe = /<article[^>]*class="[^"]*\bprd\b[^"]*"[\s\S]*?<\/article>/g
    const accepted: Partial<RawProduct>[] = []
    const scores = new Map<string, number>()
    let scanned = 0
    let m: RegExpExecArray | null
    while ((m = articleRe.exec(html)) !== null) {
      if (accepted.length >= 5) break
      // Early-fallback gate: meaningful batch processed, still empty → bail to fallback.
      if (scanned >= JUMIA_EARLY_FALLBACK_BATCH && accepted.length === 0) {
        console.log(`[${tag}] streamed ${scanned} cards with 0 valid phones — bailing for Firecrawl fallback`)
        return []
      }
      if (++scanned > 200) break
      const a = m[0]
      const hrefMatch =
        a.match(/<a[^>]+class="[^"]*\bcore\b[^"]*"[^>]+href="([^"]+)"/) ||
        a.match(/<a[^>]+href="(\/[^"]+\.html[^"]*)"/)
      const nameMatch =
        a.match(/<h3[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/) ||
        a.match(/data-name="([^"]+)"/)
      if (!hrefMatch || !nameMatch) continue
      const absUrl = toAbsoluteUrl(hrefMatch[1], 'https://www.jumia.com.eg')
      if (!absUrl) continue
      const name = stripTags(nameMatch[1])

      // Per-node gate: accessory + relevance BEFORE we keep the item.
      const score = acceptItem(name, undefined, query, 'Jumia')
      if (score === null) continue

      let priceStr: string | null = extractLowestPrice(a)
      if (!priceStr) {
        const prcMatch = a.match(/<div[^>]*class="[^"]*\bprc\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
        if (prcMatch) priceStr = stripTags(prcMatch[1])
      }
      if (!priceStr) continue
      const imgMatch =
        a.match(/<img[^>]+data-src="([^"]+)"/) ||
        a.match(/<img[^>]+src="([^"]+)"/)
      accepted.push({ name, url: absUrl, price: priceStr, image: imgMatch ? imgMatch[1] : '' })
      scores.set(absUrl, score)
    }
    console.log(`[${tag}] streamed ${scanned} cards, accepted ${accepted.length}`)
    // Pre-validated → bypass relevance double-check, but still apply price floor.
    return accepted
      .map(p => {
        const parsed = parsePrice(p.price as any)
        return {
          name: String(p.name), name_ar: String(p.name), price: parsed ?? 0,
          url: String(p.url), image: p.image || '', specs: '', store: 'Jumia',
          isRefurbished: checkRefurbished(String(p.name)),
          confidenceScore: scores.get(String(p.url)) ?? 0,
        } as RawProduct
      })
      .filter(p => (p.price as number) >= MINIMUM_PRICE_THRESHOLD)
  } catch (err) {
    console.error(`[${tag}] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// Amazon Egypt: target [data-component-type="s-search-result"] containers
// + .a-price-whole for clean integer price (ignores decimals).
async function scrapeAmazonEG(query: string, stage: ScrapeStage = 1): Promise<RawProduct[]> {
  const tag = `Amazon native stage-${stage}`
  try {
    // Stage 2: drop the strict node filter (rh=...) + use page=2 + alt UA — different
    // request shape can dodge UA-rate-limit / soft-block on the same query.
    const baseUrl = stage === 2
      ? `https://www.amazon.eg/s?k=${encodeURIComponent(query)}&i=electronics&page=2&language=en_AE`
      : `https://www.amazon.eg/s?k=${encodeURIComponent(query)}&i=electronics&rh=n%3A21832883031&language=en_AE`
    const headers = stage === 2 ? STEALTH_HEADERS_ALT : STEALTH_HEADERS
    const res = await fetchWithTimeout(baseUrl, { headers }, 10000)
    if (!res.ok) { console.log(`[${tag}] HTTP ${res.status}`); return [] }
    let html = await res.text()

    // ── STRIP SPONSORED CONTENT before parsing ──
    // Amazon's sponsored cards are noisy and often off-topic. Remove the labels and
    // any AdHolder containers so they cannot contaminate the result set.
    html = html
      .replace(/<div[^>]*class="[^"]*\bAdHolder\b[^"]*"[\s\S]*?<\/div>/gi, ' ')
      .replace(/<span[^>]*class="[^"]*\bpuis-sponsored-label-info\b[^"]*"[\s\S]*?<\/span>/gi, ' ')
      .replace(/<span[^>]*class="[^"]*\bpuis-sponsored-label-text\b[^"]*"[\s\S]*?<\/span>/gi, ' ')
      .replace(/<div[^>]+data-component-type="sp-sponsored-result"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, ' ')

    const items: Partial<RawProduct>[] = []

    // Primary strategy: split on data-component-type="s-search-result"
    let cards: string[] = []
    const searchResultRe = /<div[^>]+data-component-type="s-search-result"[^>]*>/g
    const matches = [...html.matchAll(searchResultRe)]
    if (matches.length > 0) {
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!
        const end = i + 1 < matches.length ? matches[i + 1].index! : Math.min(start + 8000, html.length)
        cards.push(html.slice(start, end))
      }
    }
    // Fallback: split on data-asin
    if (cards.length === 0) {
      const asinRe = /<div[^>]+data-asin="[A-Z0-9]{10}"[^>]*>/g
      const asinMatches = [...html.matchAll(asinRe)]
      for (let i = 0; i < asinMatches.length; i++) {
        const start = asinMatches[i].index!
        const end = i + 1 < asinMatches.length ? asinMatches[i + 1].index! : Math.min(start + 8000, html.length)
        cards.push(html.slice(start, end))
      }
    }

    for (const card of cards.slice(0, 20)) {
      // Per-card sponsored guard: skip any card that still mentions "Sponsored"
      if (/\bSponsored\b/i.test(card) || /data-component-type="sp-sponsored-result"/i.test(card)) continue

      const titleMatch =
        card.match(/<h2[^>]*aria-label="([^"]+)"/) ||
        card.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) ||
        card.match(/<span[^>]*class="[^"]*a-text-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/)
      const linkMatch =
        card.match(/<a[^>]+class="[^"]*a-link-normal[^"]*"[^>]+href="(\/[^"]+\/dp\/[A-Z0-9]+[^"]*)"/) ||
        card.match(/<a[^>]+href="(\/[^"]+\/dp\/[A-Z0-9]+[^"]*)"/) ||
        card.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/)
      const imgMatch = card.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/[^"]+)"/)
      // PRICE: prefer .a-price-whole (integer part, no decimals), then .a-offscreen
      const priceMatch =
        card.match(/<span[^>]*class="[^"]*a-price-whole[^"]*"[^>]*>([\d,]+)/) ||
        card.match(/<span class="a-offscreen">[^<]*?([\d,]+(?:\.\d+)?)/) ||
        card.match(/<span[^>]*class="[^"]*a-price[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>[^\d]*([\d,]+(?:\.\d+)?)/)
      if (!titleMatch || !linkMatch || !priceMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], 'https://www.amazon.eg')
      if (!absUrl) continue
      items.push({
        name: stripTags(titleMatch[1]),
        url: absUrl,
        price: priceMatch[1],
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[${tag}] ${items.length} raw items, ${cards.length} cards`)
    return normalizeProducts(items, 'Amazon Egypt', query)
  } catch (err) {
    console.error(`[${tag}] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// 2B Egypt: Magento search.
// CRITICAL FIX: extractLowestPrice now strips .old-price / <s> / <del> nodes
// BEFORE collecting price candidates → the crossed-out original price is gone,
// only the active discount survives, and Math.min picks the lowest.
async function scrape2B(query: string): Promise<RawProduct[]> {
  try {
    const mobileQuery = `${query} smartphone`
    const url = `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(mobileQuery)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[2B native] HTTP ${res.status}`); return [] }
    const html = await res.text()

    // ── STREAMING extraction: walk <li class="product-item"> sequentially with regex.exec,
    // filter accessories + relevance per node, stop at 5 valid products. Avoids the
    // slice(0,50)-then-filter bug where accessory-heavy pages returned 0.
    const itemRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
    const accepted: Partial<RawProduct>[] = []
    const scores = new Map<string, number>()
    let scanned = 0
    let m: RegExpExecArray | null
    while ((m = itemRe.exec(html)) !== null) {
      if (accepted.length >= 5) break
      if (++scanned > 200) break
      const b = m[0]
      const linkMatch = b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!linkMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], 'https://2b.com.eg')
      if (!absUrl) continue
      const name = stripTags(linkMatch[2])

      // Per-node gate: drop accessories + irrelevant items BEFORE price extraction.
      const score = acceptItem(name, undefined, query, '2B Egypt')
      if (score === null) continue

      const lowestPrice = extractLowestPrice(b)
      if (!lowestPrice) continue
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      accepted.push({ name, url: absUrl, price: lowestPrice, image: imgMatch ? imgMatch[1] : '' })
      scores.set(absUrl, score)
    }
    console.log(`[2B native] streamed ${scanned} items, accepted ${accepted.length}`)
    return accepted
      .map(p => {
        const parsed = parsePrice(p.price as any)
        return {
          name: String(p.name), name_ar: String(p.name), price: parsed ?? 0,
          url: String(p.url), image: p.image || '', specs: '', store: '2B Egypt',
          isRefurbished: checkRefurbished(String(p.name)),
          confidenceScore: scores.get(String(p.url)) ?? 0,
        } as RawProduct
      })
      .filter(p => (p.price as number) >= MINIMUM_PRICE_THRESHOLD)
  } catch (err) {
    console.error(`[2B native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// ════════════════════════════════════════════════════════════════════
// BIG 5 STORE CONFIG
//   • Amazon Egypt, Jumia, 2B Egypt → native (12s race → Firecrawl fallback)
//   • Noon, B.TECH                  → direct Firecrawl (heavy WAF/Cloudflare)
// ════════════════════════════════════════════════════════════════════
// MOBILE-FOCUSED URLs: where supported, scope the search to the smartphones category
// so the engine sees mostly phones (less accessory pollution at source).
// MOBILE-FOCUSED: we filter non-mobile items aggressively in `isAccessory()` (smartwatch,
// laptop, tablet, TV, etc.). We keep the search URLs PLAIN — narrowing them with category
// params (e.g. Jumia &category=mobile-phones-2399, 2B &cat=11, Noon f[category]=mobiles)
// either returned empty result pages or HTTP 500 across stores. Plain search + post-filter
// is more resilient.
const STORE_CONFIGS: Record<string, StoreConfig> = {
  // Amazon EG: scope to Mobile Phones node — node 21832883031 confirmed working live.
  'Amazon Egypt': { searchUrl: q => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}&i=electronics&rh=n%3A21832883031`,    method: 'native',    tier: 1, nativeScraper: scrapeAmazonEG },
  'Jumia':        { searchUrl: q => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`,                            method: 'native',    tier: 1, nativeScraper: scrapeJumia },
  // 2B Egypt: native scraper PERMANENTLY DISABLED — Magento markup changes + anti-bot
  // forced a full Firecrawl migration. All queries route directly to Firecrawl.
  '2B Egypt':     { searchUrl: q => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,                   method: 'firecrawl', tier: 1 },
  'Noon':         { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`,                        method: 'firecrawl', tier: 1 },
  // B.TECH: native via Next.js Server Action (sub-2s structured JSON, no Firecrawl).
  // On 0 results (e.g. action ID rotated post-deploy), Safety Valve falls back to Firecrawl.
  'B.TECH':       { searchUrl: q => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,                   method: 'native',    tier: 1, nativeScraper: scrapeBTech },
}

// ── Scraper: Firecrawl (Stage 3 multi-strategy fallback) ──
// Attempt 1 (stage 1): waitFor=5000, NO scroll — fastest path, works for static SSR pages.
// Attempt 2 (stage 2): waitFor=9000 + scroll actions + alternative selector prompt — for
// lazy-loaded SPA grids that need user interaction to hydrate.
async function callFirecrawlOnce(
  storeName: string, query: string, searchUrl: string, firecrawlKey: string,
  opts: { waitFor: number; alternate: boolean; scroll: boolean },
): Promise<any[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS)
  try {
    const actions = opts.scroll
      ? [
          { type: 'wait', milliseconds: opts.waitFor },
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 1500 },
          { type: 'scroll', direction: 'down' },
          { type: 'wait', milliseconds: 1500 },
        ]
      : [{ type: 'wait', milliseconds: opts.waitFor }]

    const promptBase = `Extract top 5 product listings from this ${storeName} search page for "${query}". Only actual products (no accessories, no out-of-stock, no banners). For price use the active selling price (ignore crossed-out original price).`
    const promptAlt = `${promptBase} Look specifically inside the product grid (selectors like .product-item, [data-component-type="s-search-result"], .productContainer, [data-qa="product-block"]). Skip recommendation carousels, sponsored ads, and "you might also like" sections.`

    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        url: searchUrl,
        formats: [{
          type: 'json',
          schema: {
            type: 'object',
            properties: {
              products: {
                type: 'array', items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' }, name_ar: { type: 'string' },
                    price: { type: 'string' }, url: { type: 'string' },
                    image: { type: 'string' }, specs: { type: 'string' },
                  },
                  required: ['name', 'price', 'url'],
                },
              },
            },
            required: ['products'],
          },
          prompt: opts.alternate ? promptAlt : promptBase,
        }],
        actions,
        waitFor: opts.waitFor,
        onlyMainContent: false,
        timeout: 75000,
      }),
    })
    const data = await response.json()
    if (!response.ok) {
      console.error(`[Firecrawl] ${storeName} HTTP ${response.status}:`, JSON.stringify(data).slice(0, 200))
      return []
    }
    return data?.data?.json?.products || data?.json?.products
        || data?.data?.extract?.products || data?.extract?.products || []
  } finally { clearTimeout(timeout) }
}

async function scrapeWithFirecrawl(query: string, storeName: string, searchUrl: string, firecrawlKey: string): Promise<RawProduct[]> {
  try {
    let products = await callFirecrawlOnce(storeName, query, searchUrl, firecrawlKey, { waitFor: 5000, alternate: false, scroll: false })
    console.log(`[Firecrawl] ${storeName}: stage-1 (no scroll) returned ${products.length} raw products`)

    // Attempt 2 on 0 results: 9s wait + scroll + alternate selector prompt.
    if (products.length === 0) {
      console.log(`[Firecrawl] ${storeName}: 0 results — retrying (waitFor=9000ms, scroll, alternate prompt)`)
      products = await callFirecrawlOnce(storeName, query, searchUrl, firecrawlKey, { waitFor: 9000, alternate: true, scroll: true })
      console.log(`[Firecrawl] ${storeName}: stage-2 returned ${products.length} raw products`)
    }
    return normalizeProducts(products, storeName, query)
  } catch (err) {
    console.error(`[Firecrawl] ${storeName}: ${err instanceof Error && err.name === 'AbortError' ? 'timeout' : err}`)
    return []
  }
}

// ════════════════════════════════════════════════════════════════════
// ── DETERMINISTIC 3-STAGE RETRIEVAL ENGINE ──
// Future-proof (Part 12): runStage1_API / runStage2_Retry / runStage3_Firecrawl
// are pure functions. Pluggable into Noon / 2B / any future store.
// ════════════════════════════════════════════════════════════════════

// Quality assessor (Part 5 + Part 8). Splits products into valid/invalid by:
//   - relevance score >= MIN_RELEVANCE_SCORE
//   - not an accessory (already filtered upstream by acceptItem, double-checked here)
//   - has a numeric price > 0
//   - normalizeProducts has already enforced price floor + brand match
function assessQuality(products: RawProduct[], query: string): {
  valid: RawProduct[]; avgRelevance: number; invalidCount: number;
} {
  if (products.length === 0) return { valid: [], avgRelevance: 0, invalidCount: 0 }
  const valid: RawProduct[] = []
  let invalidCount = 0
  let scoreSum = 0
  for (const p of products) {
    const titleBlob = `${p.name} ${p.name_ar || ''}`
    const rel = validateRelevance(query, titleBlob)
    const score = Math.max(rel.score, p.confidenceScore ?? 0)
    const priceOk = typeof p.price === 'number' && p.price > 0
    if (rel.isRelevant && score >= MIN_RELEVANCE_SCORE && priceOk) {
      valid.push({ ...p, confidenceScore: score })
      scoreSum += score
    } else {
      invalidCount++
    }
  }
  const avgRelevance = valid.length > 0 ? Math.round(scoreSum / valid.length) : 0
  return { valid, avgRelevance, invalidCount }
}

// ── STAGE RUNNERS ──
interface StageResult {
  products: RawProduct[]   // already quality-validated
  rawCount: number         // count BEFORE quality assessment (for observability)
  avgRelevance: number
  invalidCount: number
  latencyMs: number
  ok: boolean              // true if at least 1 valid product
}

async function runStage1_API(
  scraper: (q: string, stage?: ScrapeStage) => Promise<RawProduct[]>,
  query: string, store: string,
): Promise<StageResult> {
  const t0 = Date.now()
  const raw = await raceWithTimeout(scraper(query, 1), STAGE1_TIMEOUT_MS, `${store} S1-API`)
  const { valid, avgRelevance, invalidCount } = assessQuality(raw, query)
  return {
    products: valid, rawCount: raw.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok: valid.length > 0,
  }
}

async function runStage2_Retry(
  scraper: (q: string, stage?: ScrapeStage) => Promise<RawProduct[]>,
  query: string, store: string, remainingMs: number,
): Promise<StageResult> {
  const t0 = Date.now()
  // Jitter (300-800ms) ensures retry is not identical to Stage 1 (Part 3).
  await jitterSleep()
  // Use the lower of STAGE2_TIMEOUT_MS or remainingMs to respect Part 10 global budget.
  const timeoutMs = Math.max(1500, Math.min(STAGE2_TIMEOUT_MS, remainingMs - 500))
  const raw = await raceWithTimeout(scraper(query, 2), timeoutMs, `${store} S2-RETRY`)
  const { valid, avgRelevance, invalidCount } = assessQuality(raw, query)
  return {
    products: valid, rawCount: raw.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok: valid.length > 0,
  }
}

async function runStage3_Firecrawl(
  query: string, store: string, searchUrl: string, firecrawlKey: string,
): Promise<StageResult> {
  const t0 = Date.now()
  const raw = await scrapeWithFirecrawl(query, store, searchUrl, firecrawlKey)
  const { valid, avgRelevance, invalidCount } = assessQuality(raw, query)
  return {
    products: valid, rawCount: raw.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok: valid.length > 0,
  }
}

// Top-level orchestrator (Part 1-12). Runs Stage 1 → 2 → 3 deterministically
// with quality gates, early exit, structured logs, and a global time budget.
interface PipelineResult {
  products: RawProduct[]
  stage_used: StageUsed
  attempts: number
  usedFallback: boolean
  avgRelevance: number
  invalidCount: number
  totalLatencyMs: number
}

async function runRetrievalPipeline(
  config: StoreConfig, query: string, store: string,
  firecrawlKey: string | undefined,
  options: { reserveFirecrawlCredit: () => Promise<boolean>; },
): Promise<PipelineResult> {
  const t0 = Date.now()
  let stage_used: StageUsed = 'API'
  let attempts = 0
  let bestProducts: RawProduct[] = []
  let bestAvg = 0
  let bestInvalid = 0
  let usedFallback = false

  const elapsed = () => Date.now() - t0
  const remainingMs = () => MAX_TOTAL_MS - elapsed()

  // For 'firecrawl'-method stores (Noon, 2B), skip native stages entirely.
  const hasNative = config.method === 'native' && !!config.nativeScraper

  // ── STAGE 1: API ──
  if (hasNative) {
    attempts++
    const s1 = await runStage1_API(config.nativeScraper!, query, store)
    console.log(`[${store}] Stage 1 (API): raw=${s1.rawCount} valid=${s1.products.length} avgRel=${s1.avgRelevance} ${s1.latencyMs}ms`)
    if (s1.ok) {
      stage_used = 'API'
      bestProducts = s1.products; bestAvg = s1.avgRelevance; bestInvalid = s1.invalidCount
      // Part 9: early exit (Stage 1 was good enough — skip 2 & 3).
      if (bestProducts.length >= EARLY_EXIT_MIN_ITEMS && bestAvg >= EARLY_EXIT_MIN_RELEVANCE) {
        return { products: bestProducts, stage_used, attempts, usedFallback,
          avgRelevance: bestAvg, invalidCount: bestInvalid, totalLatencyMs: elapsed() }
      }
    }
  }

  // ── STAGE 2: RETRY (only if Stage 1 failed AND time remains) ──
  if (hasNative && bestProducts.length === 0 && remainingMs() > 2000) {
    attempts++
    const s2 = await runStage2_Retry(config.nativeScraper!, query, store, remainingMs())
    console.log(`[${store}] Stage 2 (RETRY): raw=${s2.rawCount} valid=${s2.products.length} avgRel=${s2.avgRelevance} ${s2.latencyMs}ms`)
    if (s2.ok) {
      stage_used = 'RETRY'
      bestProducts = s2.products; bestAvg = s2.avgRelevance; bestInvalid = s2.invalidCount
      if (bestProducts.length >= EARLY_EXIT_MIN_ITEMS && bestAvg >= EARLY_EXIT_MIN_RELEVANCE) {
        return { products: bestProducts, stage_used, attempts, usedFallback,
          avgRelevance: bestAvg, invalidCount: bestInvalid, totalLatencyMs: elapsed() }
      }
    }
  }

  // ── STAGE 3: FIRECRAWL (only if Stages 1+2 failed AND we can afford it) ──
  if (bestProducts.length === 0 && firecrawlKey && remainingMs() > 3000) {
    const creditOk = await options.reserveFirecrawlCredit()
    if (creditOk) {
      attempts++
      const s3 = await runStage3_Firecrawl(query, store, config.searchUrl(query), firecrawlKey)
      console.log(`[${store}] Stage 3 (FIRECRAWL): raw=${s3.rawCount} valid=${s3.products.length} avgRel=${s3.avgRelevance} ${s3.latencyMs}ms`)
      if (s3.ok) {
        stage_used = 'FIRECRAWL'; usedFallback = true
        bestProducts = s3.products; bestAvg = s3.avgRelevance; bestInvalid = s3.invalidCount
      }
    } else {
      console.log(`[${store}] Stage 3 skipped — credit reservation failed`)
    }
  }

  if (bestProducts.length === 0) stage_used = 'FAIL'
  return { products: bestProducts, stage_used, attempts, usedFallback,
    avgRelevance: bestAvg, invalidCount: bestInvalid, totalLatencyMs: elapsed() }
}

async function reserveCredits(supabaseUrl: string, serviceKey: string, userId: string, store: string, query: string): Promise<string | null> {
  const sb = createClient(supabaseUrl, serviceKey)
  try {
    const { data, error } = await sb.rpc('reserve_credits', { p_user_id: userId, p_amount: 1, p_store: store, p_query: query })
    if (error) { console.error('[Credits] Reserve failed:', error.message); return null }
    return data as string
  } catch (err) { console.error('[Credits] Reserve error:', err); return null }
}

async function settleCredits(supabaseUrl: string, serviceKey: string, txId: string, actualCost: number): Promise<void> {
  const sb = createClient(supabaseUrl, serviceKey)
  try {
    const { error } = await sb.rpc('settle_credits', { p_tx_id: txId, p_actual_cost: actualCost })
    if (error) console.error('[Credits] Settle failed:', error.message)
  } catch (err) { console.error('[Credits] Settle error:', err) }
}

// ── Main Handler ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()
    const { query, store, force_refresh } = body
    // SECURITY: NEVER trust user_id from request body. Always verify via JWT.

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Query is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (!store || !STORE_CONFIGS[store]) {
      return new Response(JSON.stringify({ success: false, error: `Invalid store. Valid: ${Object.keys(STORE_CONFIGS).join(', ')}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // ── SECURITY: Verify caller identity via JWT (anonymous searches allowed) ──
    let user_id: string | null = null
    const authHeader = req.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '')
      try {
        const authClient = createClient(supabaseUrl, supabaseAnonKey)
        const { data, error } = await authClient.auth.getUser(token)
        if (!error && data?.user?.id) {
          user_id = data.user.id
        } else if (error) {
          console.warn(`[${store}] JWT verify failed: ${error.message} — treating as anonymous`)
        }
      } catch (err) {
        console.warn(`[${store}] JWT verify exception:`, err)
      }
    }

    const trimmedQuery = query.trim().toLowerCase()
    const cacheKey = `${store}:${trimmedQuery}`
    console.log(`[${store}] Query: "${trimmedQuery}" user=${user_id || 'anon'}${force_refresh ? ' [FORCE REFRESH]' : ''}`)

    // ── Check cache (skipped on force refresh) ──
    if (!force_refresh) {
      const cacheClient = createClient(supabaseUrl, supabaseKey)
      const { data: cached } = await cacheClient
        .from('search_cache').select('results, created_at')
        .eq('query', cacheKey).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1).single()

      if (cached && Array.isArray(cached.results) && cached.results.length > 0) {
        console.log(`[${store}] Cache hit (${cached.results.length} products)`)
        return new Response(JSON.stringify({ success: true, products: cached.results, cached: true, store, cachedAt: cached.created_at }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // ── PHASE 4 — SEMANTIC LAYER (runs BEFORE the pipeline; pipeline contract unchanged) ──
    const intent: SemanticIntent = canonicalizeQuery(trimmedQuery)
    const expanded = expandQueries(intent, 4)
    console.log(`[${store}] semantic intent=${JSON.stringify(intent.entities)} conf=${intent.confidence} expanded=${expanded.length}`)

    // ── DETERMINISTIC 3-STAGE RETRIEVAL — driven by semantic-expanded queries ──
    const requestStart = Date.now()
    const config = STORE_CONFIGS[store]
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    let txId: string | null = null

    // Try expanded queries in order; first variant that returns ≥1 product wins.
    // Existing pipeline (stage 1/2/3) is invoked unchanged for each variant.
    let pipeline: PipelineResult = {
      products: [], stage_used: 'FAIL', attempts: 0, usedFallback: false, avgRelevance: 0, invalidCount: 0,
    }
    let usedQuery = trimmedQuery
    try {
      for (const variant of expanded) {
        if (Date.now() - requestStart > MAX_TOTAL_MS - 1000) break
        const res = await runRetrievalPipeline(config, variant, store, firecrawlKey, {
          reserveFirecrawlCredit: async () => {
            if (!user_id) return true
            txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, variant)
            return !!txId
          },
        })
        // Accumulate attempts across variants for honest telemetry.
        pipeline = {
          products: res.products,
          stage_used: res.stage_used,
          attempts: pipeline.attempts + res.attempts,
          usedFallback: res.usedFallback || pipeline.usedFallback,
          avgRelevance: res.avgRelevance,
          invalidCount: res.invalidCount,
        }
        usedQuery = variant
        if (res.products.length > 0) break
      }
    } catch (scrapeErr) {
      if (txId) await settleCredits(supabaseUrl, supabaseKey, txId, 0)
      console.error(`[${store}] Pipeline error:`, scrapeErr)
      const errLatency = Date.now() - requestStart
      const errBenchmark = runBenchmark({
        query: trimmedQuery, intent, expanded_queries: expanded, used_query: null,
        stage_used: 'FAIL', attempts: 0, products_count: 0, latency_ms: errLatency,
        invalid_items_count: 0, selected_stores: [store], routing_scores: {},
      })
      return new Response(JSON.stringify({
        success: true, products: [], cached: false, store,
        stage_used: 'FAIL', attempts: 0, latency_ms: errLatency,
        avg_relevance_score: 0, invalid_items_count: 0, usedFallback: false,
        semantic_intent: intent, expanded_queries_count: expanded.length,
        error: String(scrapeErr),
        benchmark: errBenchmark,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    let products = pipeline.products
    const usedFallback = pipeline.usedFallback

    // ── Settle credits (Firecrawl only — native is free) ──
    if (txId) {
      const charge = products.length > 0 ? 1 : 0
      await settleCredits(supabaseUrl, supabaseKey, txId, charge)
    }

    // Intent filter (final defense — drops cross-brand pollution missed by relevance gate).
    const beforeCount = products.length
    products = products.filter(p => matchesIntent(trimmedQuery, p.name))
    if (products.length < beforeCount) console.log(`[${store}] Intent post-filter: ${beforeCount} -> ${products.length}`)

    // ── PHASE 4 — semantic re-ranking (additive: re-orders, never deletes) ──
    products = semanticRerank(products as any, intent) as typeof products

    // ── UPSERT cache ──
    if (products.length > 0) {
      const writeClient = createClient(supabaseUrl, supabaseKey)
      const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString()
      await writeClient.from('search_cache').upsert(
        { query: cacheKey, results: products as any, expires_at: expiresAt, created_at: new Date().toISOString() },
        { onConflict: 'query' }
      )
    }

    const totalLatencyMs = Date.now() - requestStart

    // ── Deterministic post-mortem benchmark (zero LLM, <1ms) ──
    const routing = routeStores(intent, [store], 1)
    const benchmark = runBenchmark({
      query: trimmedQuery,
      intent,
      expanded_queries: expanded,
      used_query: usedQuery,
      stage_used: pipeline.stage_used,
      attempts: pipeline.attempts,
      products_count: products.length,
      latency_ms: totalLatencyMs,
      invalid_items_count: pipeline.invalidCount,
      selected_stores: routing.selected,
      routing_scores: routing.scores,
    })

    // ── Part 7: Structured metric log + Phase 4 semantic telemetry + benchmark ──
    console.log(JSON.stringify({
      kind: 'scrape_metric',
      store,
      query: trimmedQuery,
      used_query: usedQuery,
      stage_used: pipeline.stage_used,
      attempts: pipeline.attempts,
      latency_ms: totalLatencyMs,
      items: products.length,
      avg_relevance_score: pipeline.avgRelevance,
      invalid_items_count: pipeline.invalidCount,
      usedFallback,
      semantic_intent: intent,
      expanded_queries_count: expanded.length,
      benchmark,
    }))

    // ── Server-side analytics (fire-and-forget, bypasses RLS via service role) ──
    try {
      const logClient = createClient(supabaseUrl, supabaseKey)
      logClient
        .from('search_logs')
        .insert({ query: trimmedQuery, results_count: products.length })
        .then(({ error }) => {
          if (error) console.warn(`[${store}] search_logs insert failed:`, error.message)
        })
    } catch (logErr) {
      console.warn(`[${store}] search_logs insert exception:`, logErr)
    }

    // ── Part 6: Mandatory response contract (Phase 4 fields are ADDITIVE) ──
    return new Response(JSON.stringify({
      success: true,
      products,
      cached: false,
      store,
      usedFallback,
      stage_used: pipeline.stage_used,
      attempts: pipeline.attempts,
      latency_ms: totalLatencyMs,
      avg_relevance_score: pipeline.avgRelevance,
      invalid_items_count: pipeline.invalidCount,
      // Phase 4 — additive semantic telemetry
      semantic_intent: intent,
      expanded_queries_count: expanded.length,
      used_query: usedQuery,
      // Post-mortem self-evaluation
      benchmark,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Error:', error)
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
