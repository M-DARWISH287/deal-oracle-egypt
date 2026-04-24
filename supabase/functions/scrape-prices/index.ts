import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// PHASE 4 — semantic intelligence layer (additive; pipeline untouched)
import { canonicalizeQuery, expandQueries, semanticRerank, routeStores, type SemanticIntent } from './semantic.ts'
import { runBenchmark, type BenchmarkReport } from './benchmark.ts'

// Fire-and-forget insert into regression_logs (service-role bypass; never blocks the response).
function persistRegressionLog(
  supabaseUrl: string, supabaseKey: string,
  store: string, stageUsed: string, latencyMs: number, b: BenchmarkReport,
) {
  try {
    const c = createClient(supabaseUrl, supabaseKey)
    c.from('regression_logs').insert({
      query: b.query,
      store,
      stage_used: stageUsed,
      latency_ms: latencyMs,
      intent_accuracy: b.intent_accuracy,
      expansion_quality: b.expansion_quality,
      retrieval_health: b.retrieval_health,
      performance: b.performance,
      overall_score: b.overall_score,
      status: b.status,
      bottleneck: b.detected_bottleneck,
      key_issues: b.key_issues,
      key_strengths: b.key_strengths,
    }).then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn(`[${store}] regression_logs insert failed:`, error.message)
    })
  } catch (e) { console.warn(`[${store}] regression_logs insert exception:`, e) }
}

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
// PRODUCTION HARD BUDGETS — enforced ruthlessly. Nothing may exceed MAX_TOTAL_MS.
// A slow store is a dropped store: better to return partial results in 6s than
// "complete" results in 60s. Per-store timeouts derived from the global budget.
// Tuned against live benchmark: Amazon/Jumia HTML averages 2.5s, B.TECH ~2s,
// Noon ~2s, 2B HTML ~3-4s. Stage 1 cap of 4.5s catches the long tail.
// PHASE-3 RULE: max 5 seconds per store. Stage 1 is the only stage that runs
// (Stage 2/RETRY disabled, Stage 3/FIRECRAWL disabled), so this is the per-store cap.
const STAGE1_TIMEOUT_MS = 5000
const STAGE2_TIMEOUT_MS = 0       // RETRY DISABLED — 6s budget cannot afford a second native attempt
const FIRECRAWL_TIMEOUT_MS = 5000 // hard ceiling (was 90s — main latency offender)
// PHASE-3 HARD RULE (Big-5 stabilization): No Firecrawl fallback, no retry loops.
// Each store gets ONE native attempt within its per-store timeout, then we exit.
// If a store cannot deliver (blocked, empty, error) we surface that status so the
// UI can reflect partial success instead of waiting on doomed retries.
const FIRECRAWL_FALLBACK_ENABLED = false
// Global budget per request (Part 10): if pipeline exceeds this, we stop and return what we have.
const MAX_TOTAL_MS = 6000

// Quality gates (Part 5 — strict success criteria):
const MIN_RELEVANCE_SCORE = 60       // any product below this is treated as INVALID
const EARLY_EXIT_MIN_ITEMS = 5       // Part 9 — early exit threshold
const EARLY_EXIT_MIN_RELEVANCE = 80  // Part 9 — early exit threshold

// Stage label union (Part 1 — single source of truth).
// 'UNKNOWN' is intentionally NOT in this union — every registered store MUST resolve
// to one of these labels. Unknown stores are rejected at the handler level with HTTP 400.
type StageUsed = 'API' | 'RETRY' | 'FIRECRAWL' | 'FAIL'

// ── ARABIC → ENGLISH BRAND TOKEN MAP (deterministic pre-routing normalization) ──
// Purpose: ensure Arabic queries hit native scraper URLs that index English brand tokens.
// Rules: token-level replacement ONLY, numbers preserved, mixed AR/EN safe, URL-safe output.
// We do NOT translate full sentences, do NOT touch model numbers, and do NOT remove
// trailing variant words ("pro", "max", "ultra", "256") — they pass through unchanged.
const AR_BRAND_MAP: Record<string, string> = {
  'ايفون': 'iphone', 'آيفون': 'iphone', 'أيفون': 'iphone',
  'ايباد': 'ipad', 'آيباد': 'ipad',
  'ماكبوك': 'macbook', 'ماك بوك': 'macbook',
  'ايربودز': 'airpods', 'إيربودز': 'airpods',
  'سامسونج': 'samsung', 'سامسونغ': 'samsung',
  'جالاكسي': 'galaxy', 'جلاكسي': 'galaxy',
  'شاومي': 'xiaomi', 'ريدمي': 'redmi', 'بوكو': 'poco',
  'اوبو': 'oppo', 'أوبو': 'oppo',
  'هواوي': 'huawei', 'هونر': 'honor', 'ريلمي': 'realme',
  'فيفو': 'vivo', 'نوكيا': 'nokia', 'سوني': 'sony',
  'بلايستيشن': 'playstation', 'بلاي ستيشن': 'playstation',
  'لينوفو': 'lenovo', 'ديل': 'dell',
  'ابل': 'apple', 'آبل': 'apple', 'أبل': 'apple',
  'برو': 'pro', 'ماكس': 'max', 'الترا': 'ultra', 'بلس': 'plus',
  'ميني': 'mini', 'لايت': 'lite',
}

// Normalize a query for execution. Returns { execution, original }.
//   - execution: Arabic brand tokens replaced with English equivalents; numbers preserved;
//                Arabic-Indic digits → ASCII; safe to URL-encode.
//   - original: the untouched user input, used ONLY for logs / telemetry.
export function normalizeQuery(raw: string): { execution: string; original: string } {
  const original = (raw || '').trim()
  if (!original) return { execution: '', original }
  // Arabic-Indic → ASCII digits (so "١٥" becomes "15" before URL encoding)
  let s = original
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
  // Multi-word phrases first (longest-first) so "ماك بوك" beats "بوك"
  const entries = Object.entries(AR_BRAND_MAP).sort((a, b) => b[0].length - a[0].length)
  for (const [ar, en] of entries) {
    if (s.includes(ar)) s = s.split(ar).join(` ${en} `)
  }
  // Collapse whitespace, trim
  const execution = s.replace(/\s+/g, ' ').trim()
  return { execution, original }
}

// ── FALLBACK REASON ENUM (Part 1 — standardized) ──
// Every skipped/empty stage outcome MUST resolve to one of these reasons.
type FallbackReason =
  | 'EMPTY_RESULT'
  | 'NATIVE_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'CREDIT_LIMIT'
  | 'KEY_MISSING'
  | 'BUDGET_EXHAUSTED'
  | 'BLOCKED'
  | 'NONE'

// Internal stage outcome carrying the reason so the orchestrator can decide
// whether to escalate to the next stage AND log structured failure causes.
interface StageOutcome<T> { products: T[]; failure: FallbackReason | null }

// Promise.race helper: catches errors AND timeouts and reports the cause.
// Returns { products, failure } where failure ∈ FallbackReason | null.
async function raceWithTimeoutTraced<T>(
  p: Promise<T[]>, timeoutMs: number, label: string,
): Promise<StageOutcome<T>> {
  let timedOut = false
  const timeoutPromise = new Promise<T[]>((resolve) => setTimeout(() => {
    timedOut = true
    console.log(`[${label}] exceeded ${timeoutMs}ms — aborting stage (TIMEOUT)`)
    resolve([])
  }, timeoutMs))
  try {
    const products = await Promise.race([p, timeoutPromise])
    if (timedOut) return { products: [], failure: 'TIMEOUT' }
    if (!Array.isArray(products)) {
      console.warn(`[${label}] returned non-array — INVALID_RESPONSE`)
      return { products: [], failure: 'INVALID_RESPONSE' }
    }
    return { products, failure: products.length === 0 ? 'EMPTY_RESULT' : null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Scrapers signal anti-bot blocks by throwing `BLOCKED: <reason>`.
    if (msg.startsWith('BLOCKED:')) {
      console.warn(`[${label}] BLOCKED — ${msg.slice(8).trim()}`)
      return { products: [], failure: 'BLOCKED' }
    }
    console.error(`[${label}] threw — NATIVE_ERROR:`, msg)
    return { products: [], failure: 'NATIVE_ERROR' }
  }
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
  // Cross-model protection: drop variant suffixes the user did NOT ask for.
  // Word-boundary required — substring "fe"/"mini"/"lite" matches inside
  // legitimate words ("feature", "aluminium", "elite").
  const VARIANTS = ['pro max', 'ultra', 'mini', 'fe', 'lite', 'plus'] as const
  for (const v of VARIANTS) {
    const re = new RegExp(`\\b${v}\\b`, 'i')
    if (!re.test(q) && re.test(n)) return false
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
      // B.TECH PDP URLs are Magento-style with a trailing `.html`. The bare slug
      // path under /en/ returns 404 in production (verified live: /en/<slug> → 404,
      // /en/<slug>.html → 200). The .html suffix is the only reliable form.
      url: `https://btech.com/en/${it.slug}.html`,
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

// ── TEMPORARY DIAGNOSTICS (Phase: Jumia/2B empty-result triage) ──
// Captured per scraper invocation, attached to the HTTP response under `debug`.
// Remove once root cause is fixed.
type StoreDebug = {
  store: string
  url?: string
  status?: number
  html_length?: number
  detected_block?: boolean
  block_signal?: string
  items_found?: number
  cards_scanned?: number
  accepted?: number
  error?: string
}
const __lastDebug: Record<string, StoreDebug> = {}

async function scrapeJumia(query: string, stage: ScrapeStage = 1): Promise<RawProduct[]> {
  const tag = `Jumia native stage-${stage}`
  const dbg: StoreDebug = { store: 'Jumia' }
  __lastDebug['Jumia'] = dbg
  try {
    const mobileQuery = `${query} smartphone`
    const pageParam = stage === 2 ? '&page=2' : ''
    const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(mobileQuery)}${pageParam}`
    dbg.url = url
    console.log(`[Jumia] START`)
    console.log(`[Jumia] URL:`, url)
    const headers = stage === 2 ? STEALTH_HEADERS_ALT : undefined
    const res = await fetchWithTimeout(url, headers ? { headers } : {})
    dbg.status = res.status
    console.log(`[Jumia] status:`, res.status)
    if (res.status === 403 || res.status === 503 || res.status === 429) {
      dbg.detected_block = true
      dbg.block_signal = `HTTP ${res.status}`
      console.log(`[Jumia] BLOCKED by Cloudflare (HTTP ${res.status})`)
      throw new Error(`BLOCKED: HTTP ${res.status} from jumia.com.eg (Cloudflare challenge)`)
    }
    if (!res.ok) { console.log(`[${tag}] HTTP ${res.status}`); return [] }
    const html = await res.text()
    dbg.html_length = html.length
    console.log(`[Jumia] html length:`, html.length)
    // Cloudflare interstitial — "Just a moment..." challenge page.
    const cfJustMoment = /Just a moment\.\.\./i.test(html)
    const cfChallenge = /cf-challenge-running/i.test(html) || /cf-challenge/i.test(html)
    const cfBranded = /Cloudflare/i.test(html)
    const cfError = /id="challenge-error-text"/i.test(html)
    if (cfJustMoment || cfChallenge || cfError) {
      dbg.detected_block = true
      dbg.block_signal = cfJustMoment ? 'Just a moment...' : cfChallenge ? 'cf-challenge' : 'challenge-error-text'
      console.log(`[Jumia] BLOCKED by Cloudflare (signal: ${dbg.block_signal})`)
      throw new Error('BLOCKED: Jumia Cloudflare challenge page')
    }
    dbg.detected_block = false
    if (cfBranded) console.log(`[Jumia] note: HTML mentions Cloudflare but no challenge interstitial`)

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
    dbg.cards_scanned = scanned
    dbg.accepted = accepted.length
    dbg.items_found = accepted.length
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
    if (res.status === 503 || res.status === 403 || res.status === 429) {
      throw new Error(`BLOCKED: HTTP ${res.status} from amazon.eg (anti-bot / IP block)`)
    }
    if (!res.ok) { console.log(`[${tag}] HTTP ${res.status}`); return [] }
    let html = await res.text()
    // Amazon CAPTCHA pages contain a /errors/validateCaptcha form. Detect and signal.
    if (/\/errors\/validateCaptcha/i.test(html) || /Enter the characters you see below/i.test(html)) {
      throw new Error('BLOCKED: Amazon CAPTCHA page returned')
    }

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
async function scrape2B(query: string, _stage: ScrapeStage = 1): Promise<RawProduct[]> {
  const dbg: StoreDebug = { store: '2B Egypt' }
  __lastDebug['2B Egypt'] = dbg
  try {
    const mobileQuery = `${query} smartphone`
    const url = `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(mobileQuery)}`
    dbg.url = url
    console.log(`[2B] START`)
    console.log(`[2B] URL:`, url)
    const res = await fetchWithTimeout(url)
    dbg.status = res.status
    console.log(`[2B] status:`, res.status)
    if (!res.ok) { console.log(`[2B native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    dbg.html_length = html.length
    console.log(`[2B] html length:`, html.length)
    // Quick selector probe: how many product-item-link anchors does the HTML contain?
    const linkProbe = html.match(/class="[^"]*product-item-link[^"]*"/g)
    const itemProbe = html.match(/<li[^>]*class="[^"]*\bproduct-item\b[^"]*"/g)
    console.log(`[2B] items found (product-item-link):`, linkProbe ? linkProbe.length : 0)
    console.log(`[2B] items found (li.product-item):`, itemProbe ? itemProbe.length : 0)
    // Block heuristics for completeness.
    const blockSignal =
      /Just a moment\.\.\./i.test(html) ? 'Just a moment...' :
      /cf-challenge/i.test(html) ? 'cf-challenge' :
      /Access denied/i.test(html) ? 'Access denied' :
      null
    dbg.detected_block = blockSignal !== null
    if (blockSignal) {
      dbg.block_signal = blockSignal
      console.log(`[2B] BLOCKED signal:`, blockSignal)
    }

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
    dbg.cards_scanned = scanned
    dbg.accepted = accepted.length
    dbg.items_found = accepted.length
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

// ── Noon: native HTML scraper (Firecrawl REMOVED for Noon) ──
// Noon serves a Next.js SSR product grid. We parse the __NEXT_DATA__ JSON blob
// (most stable surface — present on every search page) and fall back to a DOM
// scan of `.productContainer` cards if the blob shape rotates.
// HARD requirements: 2s per-attempt timeout, exponential backoff (2 retries max),
// returns [] on any failure (never null), preserves PIPELINE_TRACE observability.
const NOON_TIMEOUT_MS = 2000
const NOON_MAX_RETRIES = 2

interface NoonHit {
  name?: string
  nameEn?: string
  nameAr?: string
  productTitle?: string
  brand?: string
  url?: string
  productUrl?: string
  imageKey?: string
  image?: string
  imageUrl?: string
  sku?: string
  offerCode?: string
  price?: number | string
  salePrice?: number | string
  finalPrice?: number | string
}

function noonImageFromKey(key: string | undefined): string {
  if (!key) return ''
  if (/^https?:\/\//i.test(key)) return key
  return `https://f.nooncdn.com/p/${key.replace(/^\/+/, '')}`
}

function noonProductUrl(hit: NoonHit): string | null {
  if (hit.productUrl && /^https?:\/\//i.test(hit.productUrl)) return hit.productUrl
  if (hit.url && /^https?:\/\//i.test(hit.url)) return hit.url
  if (hit.url) return toAbsoluteUrl(hit.url, 'https://www.noon.com')
  if (hit.sku) return `https://www.noon.com/egypt-en/${hit.sku}/p/`
  return null
}

async function fetchNoonOnce(url: string, attempt: number): Promise<Response | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), NOON_TIMEOUT_MS)
  try {
    // Minimal browser-like headers. Noon's Akamai edge aggressively rejects
    // datacenter IPs (HTTP 403) and Deno's HTTP/2 TLS fingerprint (stream error).
    // We still attempt a clean fetch — on rejection, we exit with EMPTY_RESULT
    // and the pipeline returns deterministically within the 2s timeout.
    const ua = attempt % 2 === 0 ? USER_AGENT : USER_AGENT_ALT
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
    })
  } catch (err) {
    console.warn(`[Noon native] attempt ${attempt + 1} fetch failed:`, err instanceof Error ? err.message : err)
    return null
  } finally { clearTimeout(t) }
}

async function scrapeNoonNative(query: string): Promise<RawProduct[]> {
  const tag = 'Noon native'
  const url = `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(query)}`

  // Up to 1 + NOON_MAX_RETRIES attempts with exponential backoff (200ms, 500ms).
  let html: string | null = null
  let blocked = false
  for (let attempt = 0; attempt <= NOON_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(500, 200 * 2 ** (attempt - 1))
      await new Promise(r => setTimeout(r, backoff))
    }
    const res = await fetchNoonOnce(url, attempt)
    if (!res) continue
    if (res.status === 403) {
      // Akamai datacenter block — retrying won't help, but we let the loop finish
      // so the LAST attempt's body can be inspected for Access Denied confirmation.
      blocked = true
      try { html = await res.text() } catch { /* ignore */ }
      break
    }
    if (res.status === 429 || res.status >= 500) {
      console.log(`[${tag}] attempt ${attempt + 1} HTTP ${res.status} — retrying`)
      continue
    }
    if (!res.ok) { console.log(`[${tag}] HTTP ${res.status} (non-retryable)`); return [] }
    try {
      html = await res.text()
      break
    } catch (err) {
      console.warn(`[${tag}] body read failed:`, err)
      continue
    }
  }
  if (blocked || (html && /<TITLE>Access Denied<\/TITLE>/i.test(html))) {
    throw new Error('BLOCKED: Noon Akamai 403 / Access Denied (datacenter IP)')
  }
  if (!html) { console.warn(`[${tag}] all ${NOON_MAX_RETRIES + 1} attempts failed`); return [] }

  // ── Strategy A: __NEXT_DATA__ JSON blob (most reliable) ──
  const hits: NoonHit[] = []
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1])
      // Walk the tree — Noon nests hits under different keys depending on layout.
      const seen = new WeakSet<object>()
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        if (seen.has(node as object)) return
        seen.add(node as object)
        if (Array.isArray(node)) { for (const v of node) walk(v); return }
        const obj = node as Record<string, unknown>
        // Heuristic: an object with a price + (name | productTitle | nameEn) is a product hit.
        const hasName = typeof obj.name === 'string' || typeof obj.nameEn === 'string' ||
                        typeof obj.productTitle === 'string'
        const hasPrice = obj.price !== undefined || obj.salePrice !== undefined ||
                         obj.finalPrice !== undefined
        if (hasName && hasPrice) hits.push(obj as NoonHit)
        for (const v of Object.values(obj)) walk(v)
      }
      walk(parsed)
    } catch (err) {
      console.warn(`[${tag}] __NEXT_DATA__ parse failed:`, err instanceof Error ? err.message : err)
    }
  }

  // ── Strategy B: DOM fallback if the JSON blob yielded nothing ──
  if (hits.length === 0) {
    const cardRe = /<div[^>]*class="[^"]*\bproductContainer\b[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi
    let m: RegExpExecArray | null
    let scanned = 0
    while ((m = cardRe.exec(html)) !== null && scanned < 60) {
      scanned++
      const card = m[0]
      const linkMatch = card.match(/<a[^>]+href="([^"]+)"/)
      const titleMatch = card.match(/<div[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                         card.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)
      const priceMatch = card.match(/<strong[^>]*class="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) ||
                         card.match(/<div[^>]*class="[^"]*\bsellingPrice\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      const imgMatch = card.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch || !titleMatch || !priceMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], 'https://www.noon.com')
      if (!absUrl) continue
      hits.push({
        name: stripTags(titleMatch[1]),
        url: absUrl,
        price: stripTags(priceMatch[1]),
        image: imgMatch ? imgMatch[1] : '',
      })
    }
  }

  console.log(`[${tag}] extracted ${hits.length} raw hits`)
  if (hits.length === 0) return []

  // Map → shape expected by normalizeProducts (which applies relevance + accessory + floor).
  const mapped: Partial<RawProduct>[] = []
  const seenUrls = new Set<string>()
  for (const h of hits) {
    if (mapped.length >= 20) break
    const name = h.nameEn || h.name || h.productTitle || ''
    if (!name) continue
    const url = noonProductUrl(h)
    if (!url || seenUrls.has(url)) continue
    seenUrls.add(url)
    const priceRaw = h.salePrice ?? h.finalPrice ?? h.price
    if (priceRaw === undefined || priceRaw === null || priceRaw === '') continue
    const image = h.imageUrl || h.image || noonImageFromKey(h.imageKey)
    mapped.push({
      name: String(name),
      name_ar: h.nameAr ? String(h.nameAr) : String(name),
      price: priceRaw as string | number,
      url,
      image,
      specs: h.brand ? String(h.brand) : '',
      store: 'Noon',
    })
  }
  return normalizeProducts(mapped, 'Noon', query)
}

// ════════════════════════════════════════════════════════════════════
// BIG 5 STORE CONFIG
//   • Amazon Egypt, Jumia, B.TECH, Noon → native scrapers
//   • 2B Egypt                         → direct Firecrawl (Magento + anti-bot)
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
  // 2B Egypt: NATIVE re-enabled (live HTML probe shows 50 product-item-link cards
  // available without anti-bot blocking; Firecrawl path was producing 0 results
  // and burning credits). Stage-3 Firecrawl is globally disabled by Phase-3 rule.
  '2B Egypt':     { searchUrl: q => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,                   method: 'native',    tier: 1, nativeScraper: scrape2B },
  'Noon':         { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`,                        method: 'native',    tier: 1, nativeScraper: scrapeNoonNative },
  // B.TECH: native via Next.js Server Action (sub-2s structured JSON).
  'B.TECH':       { searchUrl: q => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,                   method: 'native',    tier: 1, nativeScraper: scrapeBTech },
  // NOTE: Carrefour is NOT registered. Per MVP decision, only the Big-5 above are wired.
  // Any request for an unregistered store is rejected at the handler with HTTP 400 — no
  // store may ever resolve to stage_used="UNKNOWN" or a missing handler.
}

// ── REGISTRY VALIDATION (runs once at module load) ──
// Guarantees: every registered store has a searchUrl, a valid method, and — when method
// is 'native' — a defined nativeScraper handler. Throws on misconfiguration so a broken
// deploy fails loudly instead of silently returning UNKNOWN/empty results in production.
;(function validateStoreRegistry() {
  const errors: string[] = []
  for (const [name, cfg] of Object.entries(STORE_CONFIGS)) {
    if (typeof cfg.searchUrl !== 'function') errors.push(`${name}: missing searchUrl()`)
    if (cfg.method !== 'native' && cfg.method !== 'firecrawl') errors.push(`${name}: invalid method "${cfg.method}"`)
    if (cfg.method === 'native' && typeof cfg.nativeScraper !== 'function') {
      errors.push(`${name}: method=native but nativeScraper handler is missing`)
    }
  }
  if (errors.length > 0) {
    const msg = `[STORE_REGISTRY] CRITICAL — invalid store configuration:\n  - ${errors.join('\n  - ')}`
    console.error(msg)
    throw new Error(msg)
  }
  console.log(`[STORE_REGISTRY] OK — ${Object.keys(STORE_CONFIGS).length} stores wired: ${Object.keys(STORE_CONFIGS).join(', ')}`)
})()

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
        // Match our Deno-side abort budget so Firecrawl doesn't keep working past our cap.
        timeout: FIRECRAWL_TIMEOUT_MS,
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
    // Single attempt under the hard 4s ceiling — no retry, no scroll loop.
    // Production budget cannot afford two Firecrawl calls; if it fails, return [].
    const waitFor = Math.min(2000, Math.floor(FIRECRAWL_TIMEOUT_MS / 2))
    const products = await callFirecrawlOnce(storeName, query, searchUrl, firecrawlKey, { waitFor, alternate: false, scroll: false })
    console.log(`[Firecrawl] ${storeName}: returned ${products.length} raw products (waitFor=${waitFor}ms, single attempt)`)
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
  failure: FallbackReason | null  // why the stage produced nothing (null if ok)
}

async function runStage1_API(
  scraper: (q: string, stage?: ScrapeStage) => Promise<RawProduct[]>,
  query: string, store: string,
): Promise<StageResult> {
  const t0 = Date.now()
  const outcome = await raceWithTimeoutTraced(scraper(query, 1), STAGE1_TIMEOUT_MS, `${store} S1-API`)
  const { valid, avgRelevance, invalidCount } = assessQuality(outcome.products, query)
  const ok = valid.length > 0
  return {
    products: valid, rawCount: outcome.products.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok,
    failure: ok ? null : (outcome.failure ?? 'EMPTY_RESULT'),
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
  const outcome = await raceWithTimeoutTraced(scraper(query, 2), timeoutMs, `${store} S2-RETRY`)
  const { valid, avgRelevance, invalidCount } = assessQuality(outcome.products, query)
  const ok = valid.length > 0
  return {
    products: valid, rawCount: outcome.products.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok,
    failure: ok ? null : (outcome.failure ?? 'EMPTY_RESULT'),
  }
}

async function runStage3_Firecrawl(
  query: string, store: string, searchUrl: string, firecrawlKey: string,
): Promise<StageResult> {
  const t0 = Date.now()
  let raw: RawProduct[] = []
  let failureBase: FallbackReason | null = null
  try {
    raw = await scrapeWithFirecrawl(query, store, searchUrl, firecrawlKey)
    if (!Array.isArray(raw)) { failureBase = 'INVALID_RESPONSE'; raw = [] }
  } catch (err) {
    console.error(`[${store}] Stage 3 (FIRECRAWL) threw — NATIVE_ERROR:`, err instanceof Error ? err.message : err)
    failureBase = 'NATIVE_ERROR'
  }
  const { valid, avgRelevance, invalidCount } = assessQuality(raw, query)
  const ok = valid.length > 0
  return {
    products: valid, rawCount: raw.length, avgRelevance, invalidCount,
    latencyMs: Date.now() - t0, ok,
    failure: ok ? null : (failureBase ?? 'EMPTY_RESULT'),
  }
}

// Top-level orchestrator (Part 1-12). Runs Stage 1 → 2 → 3 deterministically
// with quality gates, early exit, structured logs, and a global time budget.
interface PipelineResult {
  products: RawProduct[]
  stage_used: StageUsed
  stages_attempted: Array<'API' | 'RETRY' | 'FIRECRAWL'>  // ordered list of stages we ran
  attempts: number
  usedFallback: boolean
  fallback_mandatory: boolean       // true if Stage 1/2 failed → fallback was REQUIRED
  fallback_reason: FallbackReason   // standardized enum (NONE if no fallback was needed)
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
  const stages_attempted: Array<'API' | 'RETRY' | 'FIRECRAWL'> = []
  let attempts = 0
  let bestProducts: RawProduct[] = []
  let bestAvg = 0
  let bestInvalid = 0
  let usedFallback = false
  let fallback_reason: FallbackReason = 'NONE'
  // Tracks the cause of the most recent native failure — used as the fallback trigger reason.
  let nativeFailureCause: FallbackReason | null = null

  const elapsed = () => Date.now() - t0
  const remainingMs = () => MAX_TOTAL_MS - elapsed()

  // For 'firecrawl'-method stores (Noon, 2B), skip native stages entirely.
  const hasNative = config.method === 'native' && !!config.nativeScraper

  // ── STAGE 1: API ──
  if (hasNative) {
    attempts++
    stages_attempted.push('API')
    const s1 = await runStage1_API(config.nativeScraper!, query, store)
    console.log(`[${store}] Stage 1 (API): raw=${s1.rawCount} valid=${s1.products.length} avgRel=${s1.avgRelevance} ${s1.latencyMs}ms failure=${s1.failure ?? 'none'}`)
    if (s1.ok) {
      stage_used = 'API'
      bestProducts = s1.products; bestAvg = s1.avgRelevance; bestInvalid = s1.invalidCount
      // Part 9: early exit (Stage 1 was good enough — skip 2 & 3).
      if (bestProducts.length >= EARLY_EXIT_MIN_ITEMS && bestAvg >= EARLY_EXIT_MIN_RELEVANCE) {
        return { products: bestProducts, stage_used, stages_attempted, attempts, usedFallback,
          fallback_mandatory: false, fallback_reason: 'NONE',
          avgRelevance: bestAvg, invalidCount: bestInvalid, totalLatencyMs: elapsed() }
      }
    } else {
      nativeFailureCause = s1.failure  // EMPTY_RESULT | TIMEOUT | NATIVE_ERROR | INVALID_RESPONSE
    }
  }

  // ── STAGE 2: RETRY (DISABLED in production — 6s budget can't afford it) ──
  // Kept here for diagnostic toggling: setting STAGE2_TIMEOUT_MS > 0 re-enables.
  if (STAGE2_TIMEOUT_MS > 0 && hasNative && bestProducts.length === 0 && remainingMs() > STAGE2_TIMEOUT_MS + 500) {
    attempts++
    stages_attempted.push('RETRY')
    const s2 = await runStage2_Retry(config.nativeScraper!, query, store, remainingMs())
    console.log(`[${store}] Stage 2 (RETRY): raw=${s2.rawCount} valid=${s2.products.length} avgRel=${s2.avgRelevance} ${s2.latencyMs}ms failure=${s2.failure ?? 'none'}`)
    if (s2.ok) {
      stage_used = 'RETRY'
      bestProducts = s2.products; bestAvg = s2.avgRelevance; bestInvalid = s2.invalidCount
      if (bestProducts.length >= EARLY_EXIT_MIN_ITEMS && bestAvg >= EARLY_EXIT_MIN_RELEVANCE) {
        return { products: bestProducts, stage_used, stages_attempted, attempts, usedFallback,
          fallback_mandatory: true, fallback_reason: 'NONE',
          avgRelevance: bestAvg, invalidCount: bestInvalid, totalLatencyMs: elapsed() }
      }
    } else {
      // Latest native cause overrides — Stage 2 outcome is most recent signal.
      nativeFailureCause = s2.failure
    }
  }

  // ── STAGE 3: FIRECRAWL FALLBACK ──
  // PHASE-3 RULE (Big-5 stabilization): Firecrawl is GLOBALLY DISABLED. Each store
  // gets one native attempt. If it fails (BLOCKED, EMPTY_RESULT, TIMEOUT, NATIVE_ERROR)
  // we surface that status and exit immediately — no second-stage retries, no Firecrawl.
  // The flag below is the single switch — flip it back on if Big-5 stops being stable.
  const fallback_mandatory = bestProducts.length === 0
  const NATIVE_ONLY_STORES = new Set(['Noon'])
  if (fallback_mandatory && !FIRECRAWL_FALLBACK_ENABLED) {
    fallback_reason = nativeFailureCause ?? 'EMPTY_RESULT'
    console.log(`[${store}] Stage 3 SKIPPED — FIRECRAWL_FALLBACK_ENABLED=false (Phase-3 rule). reason=${fallback_reason}`)
  } else if (fallback_mandatory) {
    if (NATIVE_ONLY_STORES.has(store)) {
      fallback_reason = nativeFailureCause ?? 'EMPTY_RESULT'
      console.log(`[${store}] Stage 3 SKIPPED — store is native-only (Firecrawl removed). reason=${fallback_reason}`)
    } else if (!firecrawlKey) {
      fallback_reason = 'KEY_MISSING'
      console.warn(`[${store}] Stage 3 SKIPPED — FIRECRAWL_API_KEY not configured (fallback_reason=KEY_MISSING)`)
    } else if (remainingMs() <= FIRECRAWL_TIMEOUT_MS) {
      // Need at least one Firecrawl-cap worth of time before attempting it.
      fallback_reason = 'BUDGET_EXHAUSTED'
      console.warn(`[${store}] Stage 3 SKIPPED — only ${remainingMs()}ms remaining (fallback_reason=BUDGET_EXHAUSTED)`)
    } else {
      const creditOk = await options.reserveFirecrawlCredit()
      if (!creditOk) {
        fallback_reason = 'CREDIT_LIMIT'
        console.warn(`[${store}] Stage 3 SKIPPED — credit reservation failed (fallback_reason=CREDIT_LIMIT)`)
      } else {
        attempts++
        stages_attempted.push('FIRECRAWL')
        const triggerReason = hasNative ? (nativeFailureCause ?? 'EMPTY_RESULT') : 'EMPTY_RESULT'
        console.log(`[${store}] FALLBACK_TRIGGERED_FIRECRAWL trigger=${triggerReason} mandatory=true`)
        const s3 = await runStage3_Firecrawl(query, store, config.searchUrl(query), firecrawlKey)
        console.log(`[${store}] Stage 3 (FIRECRAWL): raw=${s3.rawCount} valid=${s3.products.length} avgRel=${s3.avgRelevance} ${s3.latencyMs}ms failure=${s3.failure ?? 'none'}`)
        if (s3.ok) {
          stage_used = 'FIRECRAWL'; usedFallback = true
          bestProducts = s3.products; bestAvg = s3.avgRelevance; bestInvalid = s3.invalidCount
          fallback_reason = 'NONE'
        } else {
          // Firecrawl ran but produced nothing — surface its specific failure cause.
          fallback_reason = s3.failure ?? 'EMPTY_RESULT'
        }
      }
    }
  }

  if (bestProducts.length === 0) stage_used = 'FAIL'
  console.log(`[${store}] PIPELINE_DONE stage_used=${stage_used} stages_attempted=[${stages_attempted.join(',')}] fallback_triggered=${usedFallback} fallback_mandatory=${fallback_mandatory} fallback_reason=${fallback_reason} attempts=${attempts} latency=${elapsed()}ms`)
  return { products: bestProducts, stage_used, stages_attempted, attempts, usedFallback,
    fallback_mandatory, fallback_reason,
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

// ── PIPELINE_TRACE EMITTER (Part 2 — failure visibility, no silent fails) ──
// Emits exactly one structured trace per request lifecycle. Called on every
// exit path: success, scrape error, outer catch, validation failure.
interface PipelineTrace {
  store: string
  original_query: string
  normalized_query: string
  stages_attempted: Array<'API' | 'RETRY' | 'FIRECRAWL'>
  stage_used: StageUsed | 'NONE'
  fallback_triggered: boolean
  fallback_mandatory: boolean
  fallback_reason: FallbackReason
  latency_ms: number
  items_found: number
  success: boolean
  error?: string
}
function emitPipelineTrace(t: PipelineTrace): void {
  console.log(JSON.stringify({ kind: 'PIPELINE_TRACE', ...t }))
}

// ── Main Handler ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  // Captured early so the outer catch can still emit a trace.
  const handlerStart = Date.now()
  let traceStore = 'unknown'
  let traceOriginal = ''
  let traceNormalized = ''

  try {
    const body = await req.json().catch(() => ({}))
    const { query, store, force_refresh } = body
    traceStore = typeof store === 'string' ? store : 'unknown'
    traceOriginal = typeof query === 'string' ? query : ''
    // SECURITY: NEVER trust user_id from request body. Always verify via JWT.

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      emitPipelineTrace({
        store: traceStore, original_query: traceOriginal, normalized_query: '',
        stages_attempted: [], stage_used: 'NONE',
        fallback_triggered: false, fallback_mandatory: false, fallback_reason: 'NONE',
        latency_ms: Date.now() - handlerStart, items_found: 0, success: false,
        error: 'QUERY_REQUIRED',
      })
      return new Response(JSON.stringify({ success: false, error: 'Query is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (!store || !STORE_CONFIGS[store]) {
      emitPipelineTrace({
        store: traceStore, original_query: traceOriginal, normalized_query: '',
        stages_attempted: [], stage_used: 'NONE',
        fallback_triggered: false, fallback_mandatory: false, fallback_reason: 'NONE',
        latency_ms: Date.now() - handlerStart, items_found: 0, success: false,
        error: 'STORE_NOT_REGISTERED',
      })
      return new Response(JSON.stringify({
        success: false, error: 'STORE_NOT_REGISTERED',
        message: `Invalid store. Valid: ${Object.keys(STORE_CONFIGS).join(', ')}`,
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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

    // ── DETERMINISTIC NORMALIZATION (runs BEFORE routing) ──
    // Arabic brand tokens → English equivalents so native scraper URLs (which index
    // English brand keywords) get hits. Original query preserved for logs/cache key.
    const { execution: normalizedQuery, original: originalQuery } = normalizeQuery(query)
    const trimmedQuery = normalizedQuery.toLowerCase()
    traceNormalized = trimmedQuery
    // Cache key uses the NORMALIZED query so AR/EN variants of the same intent share cache.
    const cacheKey = `${store}:${trimmedQuery}`
    console.log(`[${store}] original="${originalQuery}" normalized_query="${trimmedQuery}" user=${user_id || 'anon'}${force_refresh ? ' [FORCE REFRESH]' : ''}`)

    // ── Check cache (skipped on force refresh) ──
    if (!force_refresh) {
      const cacheClient = createClient(supabaseUrl, supabaseKey)
      const { data: cached } = await cacheClient
        .from('search_cache').select('results, created_at')
        .eq('query', cacheKey).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1).single()

      if (cached && Array.isArray(cached.results) && cached.results.length > 0) {
        console.log(`[${store}] Cache hit (${cached.results.length} products)`)
        emitPipelineTrace({
          store, original_query: originalQuery, normalized_query: trimmedQuery,
          stages_attempted: [], stage_used: 'API',
          fallback_triggered: false, fallback_mandatory: false, fallback_reason: 'NONE',
          latency_ms: Date.now() - handlerStart,
          items_found: cached.results.length, success: true,
        })
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

    let pipeline: PipelineResult = {
      products: [], stage_used: 'FAIL', stages_attempted: [], attempts: 0,
      usedFallback: false, fallback_mandatory: false, fallback_reason: 'NONE',
      avgRelevance: 0, invalidCount: 0, totalLatencyMs: 0,
    }
    let usedQuery = trimmedQuery
    try {
      // Production budget: ONE variant per store. Looping expansions blew the
      // 6s budget badly (each variant could trigger Stage1+Firecrawl).
      for (const variant of expanded.slice(0, 1)) {
        const elapsed = Date.now() - requestStart
        if (elapsed > MAX_TOTAL_MS - 1000) break
        const res = await runRetrievalPipeline(config, variant, store, firecrawlKey, {
          reserveFirecrawlCredit: async () => {
            if (!user_id) return true
            txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, variant)
            return !!txId
          },
        })
        pipeline = {
          products: res.products,
          stage_used: res.stage_used,
          stages_attempted: [...pipeline.stages_attempted, ...res.stages_attempted],
          attempts: pipeline.attempts + res.attempts,
          usedFallback: res.usedFallback || pipeline.usedFallback,
          fallback_mandatory: res.fallback_mandatory || pipeline.fallback_mandatory,
          fallback_reason: res.products.length > 0 ? 'NONE' : res.fallback_reason,
          avgRelevance: res.avgRelevance,
          invalidCount: res.invalidCount,
          totalLatencyMs: res.totalLatencyMs,
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
      persistRegressionLog(supabaseUrl, supabaseKey, store, 'FAIL', errLatency, errBenchmark)
      emitPipelineTrace({
        store, original_query: originalQuery, normalized_query: trimmedQuery,
        stages_attempted: pipeline.stages_attempted, stage_used: 'FAIL',
        fallback_triggered: pipeline.usedFallback,
        fallback_mandatory: true, fallback_reason: 'NATIVE_ERROR',
        latency_ms: Date.now() - handlerStart, items_found: 0, success: false,
        error: scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr),
      })
      return new Response(JSON.stringify({
        success: true, products: [], cached: false, store,
        stage_used: 'FAIL', attempts: 0, latency_ms: errLatency,
        avg_relevance_score: 0, invalid_items_count: 0, usedFallback: false,
        fallback_mandatory: true, fallback_reason: 'NATIVE_ERROR',
        stages_attempted: pipeline.stages_attempted,
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
      stages_attempted: pipeline.stages_attempted,
      fallback_mandatory: pipeline.fallback_mandatory,
      fallback_reason: pipeline.fallback_reason,
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

    // ── Persist benchmark to regression_logs (fire-and-forget) ──
    persistRegressionLog(supabaseUrl, supabaseKey, store, pipeline.stage_used, totalLatencyMs, benchmark)

    // ── Final PIPELINE_TRACE — one per request, even on FAIL stage ──
    emitPipelineTrace({
      store, original_query: originalQuery, normalized_query: trimmedQuery,
      stages_attempted: pipeline.stages_attempted,
      stage_used: pipeline.stage_used,
      fallback_triggered: usedFallback,
      fallback_mandatory: pipeline.fallback_mandatory,
      fallback_reason: pipeline.fallback_reason,
      latency_ms: Date.now() - handlerStart,
      items_found: products.length,
      success: products.length > 0,
    })

    return new Response(JSON.stringify({
      success: true,
      products,
      cached: false,
      store,
      usedFallback,
      stage_used: pipeline.stage_used,
      stages_attempted: pipeline.stages_attempted,
      fallback_mandatory: pipeline.fallback_mandatory,
      fallback_reason: pipeline.fallback_reason,
      attempts: pipeline.attempts,
      latency_ms: totalLatencyMs,
      avg_relevance_score: pipeline.avgRelevance,
      invalid_items_count: pipeline.invalidCount,
      semantic_intent: intent,
      expanded_queries_count: expanded.length,
      used_query: usedQuery,
      benchmark,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    // Outer catch — even an unexpected crash MUST leave a PIPELINE_TRACE.
    console.error('Error:', error)
    emitPipelineTrace({
      store: traceStore, original_query: traceOriginal, normalized_query: traceNormalized,
      stages_attempted: [], stage_used: 'FAIL',
      fallback_triggered: false, fallback_mandatory: false,
      fallback_reason: 'INVALID_RESPONSE',
      latency_ms: Date.now() - handlerStart, items_found: 0, success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stage_used: 'FAIL',
      fallback_mandatory: false,
      fallback_reason: 'INVALID_RESPONSE',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
