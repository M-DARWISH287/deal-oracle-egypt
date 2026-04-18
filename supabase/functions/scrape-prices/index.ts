import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CACHE_TTL_HOURS = 12
const MINIMUM_PRICE_THRESHOLD = 1500
const STORE_TIMEOUT_MS = 15000

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

// ── Types ──
interface RawProduct {
  name: string; name_ar?: string; price: number | string;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
}

type ScrapeMethod = 'native' | 'firecrawl'

interface StoreConfig {
  // Used when method='firecrawl' OR when native fails and Safety Valve fallback fires
  searchUrl: (q: string) => string;
  method: ScrapeMethod;
  tier: 1 | 2 | 3;
  nativeScraper?: (q: string) => Promise<RawProduct[]>;
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

// Brand exclusion map: if the query mentions a brand, drop results from competitor brands.
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

// Relaxed intent matcher + STRICT brand matcher.
// - Drops Pro Max/Ultra when user typed a base variant.
// - Drops cross-brand pollution (iPhone query → no Samsung).
function matchesIntent(query: string, productName: string): boolean {
  const q = query.toLowerCase(); const n = productName.toLowerCase()
  // Variant filter
  if (!q.includes('max') && !q.includes('ultra')) {
    if (n.includes('pro max') || n.includes('ultra')) return false
  }
  // Brand filter: if query mentions a brand keyword, reject cross-brand results
  for (const [brandKw, excluded] of Object.entries(BRAND_EXCLUSIONS)) {
    if (q.includes(brandKw)) {
      if (excluded.some(bad => n.includes(bad))) return false
    }
  }
  return true
}

const ACCESSORY_KEYWORDS = [
  'case', 'cover', 'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder', 'stand', 'mount',
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة', 'سكرين', 'حماية',
  'earphone', 'earbuds', 'headset', 'strap', 'band', 'pouch', 'sleeve',
  'film', 'glass', 'lens protector', 'camera protector',
]

function isAccessory(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCESSORY_KEYWORDS.some(kw => lower.includes(kw))
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

// Extract ALL prices from a block and return the LOWEST (avoid strikethrough/old price)
function extractLowestPrice(block: string): string | null {
  const candidates: number[] = []
  // Magento data attribute
  const dataPriceRe = /data-price-amount="([0-9.]+)"/g
  let m: RegExpExecArray | null
  while ((m = dataPriceRe.exec(block)) !== null) {
    const n = parseFloat(m[1]); if (!isNaN(n) && n > 0) candidates.push(n)
  }
  // EGP / LE / ج.م amounts
  const egpRe = /(\d[\d,]{2,})(?:\.\d+)?\s*(?:EGP|ج\.م|LE|جنيه)/gi
  while ((m = egpRe.exec(block)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(n) && n > 0) candidates.push(n)
  }
  // Generic large numbers inside price spans
  const priceSpanRe = /<(?:span|div|p|strong)[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p|strong)>/gi
  while ((m = priceSpanRe.exec(block)) !== null) {
    const inner = stripTags(m[1])
    const num = parsePrice(inner)
    if (num !== null && num > 0) candidates.push(num)
  }
  if (candidates.length === 0) return null
  return String(Math.min(...candidates))
}

// Convert relative URL to absolute and reject non-product paths
function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null
  let url: string
  try {
    url = href.startsWith('http') ? href : new URL(href, baseUrl).toString()
  } catch { return null }
  // Reject non-product links
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

function normalizeProducts(items: Partial<RawProduct>[], storeName: string): RawProduct[] {
  return items
    .filter(p => p.name && p.url && !isAccessory(String(p.name)))
    .slice(0, 5)
    .map(p => {
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
      }
    })
    .filter(p => p.price >= MINIMUM_PRICE_THRESHOLD)
}

// ── NATIVE SCRAPERS (Group 1) ──

// Jumia: HTML with article.prd elements (current DOM uses <article class="prd _fb col c-prd">)
async function scrapeJumia(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[Jumia native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const articleRe = /<article[^>]*class="[^"]*\bprd\b[^"]*"[\s\S]*?<\/article>/g
    const articles = html.match(articleRe) || []
    for (const a of articles.slice(0, 15)) {
      const hrefMatch =
        a.match(/<a[^>]+class="[^"]*\bcore\b[^"]*"[^>]+href="([^"]+)"/) ||
        a.match(/<a[^>]+href="(\/[^"]+\.html[^"]*)"/)
      const nameMatch =
        a.match(/<h3[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/) ||
        a.match(/data-name="([^"]+)"/)
      const imgMatch =
        a.match(/<img[^>]+data-src="([^"]+)"/) ||
        a.match(/<img[^>]+src="([^"]+)"/)
      if (!hrefMatch || !nameMatch) continue
      const absUrl = toAbsoluteUrl(hrefMatch[1], 'https://www.jumia.com.eg')
      if (!absUrl) continue
      let priceStr: string | null = extractLowestPrice(a)
      if (!priceStr) {
        const prcMatch = a.match(/<div[^>]*class="[^"]*\bprc\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
        if (prcMatch) priceStr = stripTags(prcMatch[1])
      }
      if (!priceStr) continue
      items.push({
        name: stripTags(nameMatch[1]),
        url: absUrl,
        price: priceStr,
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[Jumia native] ${items.length} raw items`)
    return normalizeProducts(items, 'Jumia')
  } catch (err) {
    console.error(`[Jumia native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// ── Amazon Egypt: native via stealth fetch ──
async function scrapeAmazonEG(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://www.amazon.eg/s?k=${encodeURIComponent(query)}&language=en_AE`
    const res = await fetchWithTimeout(url, { headers: STEALTH_HEADERS }, 10000)
    if (!res.ok) { console.log(`[Amazon native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const cardRe = /<div[^>]+data-component-type="s-search-result"[\s\S]*?(?=<div[^>]+data-component-type="s-search-result"|<div class="s-main-slot)/g
    const cards = html.match(cardRe) || []
    for (const card of cards.slice(0, 15)) {
      const titleMatch =
        card.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) ||
        card.match(/<span[^>]*class="[^"]*a-text-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/)
      const linkMatch =
        card.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/) ||
        card.match(/<a[^>]+class="[^"]*a-link-normal[^"]*"[^>]+href="(\/[^"]+\/dp\/[^"]+)"/)
      const imgMatch = card.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/[^"]+)"/)
      const priceMatch =
        card.match(/<span class="a-offscreen">[^<]*?([\d,]+(?:\.\d+)?)/) ||
        card.match(/<span class="a-price-whole">([\d,]+)/)
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
    console.log(`[Amazon native] ${items.length} raw items, ${cards.length} cards`)
    return normalizeProducts(items, 'Amazon Egypt')
  } catch (err) {
    console.error(`[Amazon native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// ── Noon: native via __NEXT_DATA__ embedded JSON ──
async function scrapeNoon(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, {
      headers: { ...STEALTH_HEADERS, 'Referer': 'https://www.noon.com/' },
    }, 10000)
    if (!res.ok) { console.log(`[Noon native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (nextDataMatch) {
      try {
        const json = JSON.parse(nextDataMatch[1])
        const hits =
          json?.props?.pageProps?.catalog?.hits ||
          json?.props?.pageProps?.searchHits ||
          json?.props?.pageProps?.initialState?.catalog?.products ||
          []
        for (const h of hits.slice(0, 15)) {
          const name = h.name || h.product_title || h.title
          const sku = h.sku || h.product_id || h.nis_sku
          const priceCandidates = [h.sale_price, h.price, h.offer_price].map(parsePrice).filter(Boolean) as number[]
          const price = priceCandidates.length > 0 ? Math.min(...priceCandidates) : null
          if (!name || !sku || !price) continue
          const slug = (h.url || h.product_link || `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${sku}/p`)
          const absUrl = toAbsoluteUrl(`/egypt-en/${slug}`, 'https://www.noon.com')
          if (!absUrl) continue
          items.push({
            name: String(name),
            url: absUrl,
            price,
            image: h.image_key ? `https://f.nooncdn.com/p/${h.image_key}.jpg` : (h.image || ''),
          })
        }
      } catch (e) {
        console.log(`[Noon native] __NEXT_DATA__ parse failed:`, e instanceof Error ? e.message : e)
      }
    }
    console.log(`[Noon native] ${items.length} raw items`)
    return normalizeProducts(items, 'Noon')
  } catch (err) {
    console.error(`[Noon native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// B.TECH: Magento/PWA — try the storefront search HTML
async function scrapeBtech(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[B.TECH native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const itemRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
    const blocks = html.match(itemRe) || []
    for (const b of blocks.slice(0, 15)) {
      const linkMatch = b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], 'https://btech.com')
      if (!absUrl) continue
      const lowestPrice = extractLowestPrice(b)
      if (!lowestPrice) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: absUrl,
        price: lowestPrice,
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[B.TECH native] ${items.length} raw items`)
    return normalizeProducts(items, 'B.TECH')
  } catch (err) {
    console.error(`[B.TECH native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// 2B Egypt: Magento search
async function scrape2B(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[2B native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const itemRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
    const blocks = html.match(itemRe) || []
    for (const b of blocks.slice(0, 15)) {
      const linkMatch = b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], 'https://2b.com.eg')
      if (!absUrl) continue
      const lowestPrice = extractLowestPrice(b)
      if (!lowestPrice) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: absUrl,
        price: lowestPrice,
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[2B native] ${items.length} raw items`)
    return normalizeProducts(items, '2B Egypt')
  } catch (err) {
    console.error(`[2B native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// Helper: parse Shopify product card block (HTML fallback)
function parseShopifyCardBlock(block: string, path: string, baseUrl: string): Partial<RawProduct> | null {
  const titleMatch = block.match(/title="([^"]+)"/) || block.match(/alt="([^"]+)"/)
  const imgMatch = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/)
  if (!titleMatch) return null
  const absUrl = toAbsoluteUrl(path, baseUrl)
  if (!absUrl) return null
  const lowestPrice = extractLowestPrice(block)
  if (!lowestPrice) return null
  return { name: titleMatch[1], url: absUrl, price: lowestPrice, image: imgMatch ? imgMatch[1] : '' }
}

// Dream 2000: Shopify-like — try /search/suggest.json then HTML
async function scrapeDream2000(query: string): Promise<RawProduct[]> {
  return scrapeShopify(query, 'https://dream2000.com', 'Dream 2000')
}

// Select.eg: Shopify
async function scrapeSelect(query: string): Promise<RawProduct[]> {
  return scrapeShopify(query, 'https://select.eg', 'Select.eg')
}

// ── NATIVE SCRAPERS (Group 2) ──

// Generic Magento scraper (used by RayaShop, Compumarts, etc.) — accepts <li> OR <div> product-item
async function scrapeMagento(query: string, baseUrl: string, searchPath: string, storeName: string): Promise<RawProduct[]> {
  try {
    const url = `${baseUrl}${searchPath}${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, { headers: STEALTH_HEADERS }, 10000)
    if (!res.ok) { console.log(`[${storeName} native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    // Match <li> OR <div> with product-item class
    const itemRe = /<(?:li|div)[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/(?:li|div)>/g
    let blocks = html.match(itemRe) || []
    // Fallback: any block with product-item-link inside
    if (blocks.length === 0) {
      const altRe = /<[^>]+class="[^"]*\bproduct(?:-item)?\b[^"]*"[\s\S]{0,2000}?product-item-link[\s\S]{0,2000}?<\/[^>]+>/g
      blocks = html.match(altRe) || []
    }
    for (const b of blocks.slice(0, 15)) {
      const linkMatch =
        b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
        b.match(/<a[^>]+href="([^"]+)"[^>]*\bclass="[^"]*product-item-link[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
        b.match(/<a[^>]+href="(\/[^"]+\.html)"[\s\S]{0,500}?title="([^"]+)"/)
      const imgMatch = b.match(/<img[^>]+(?:data-src|src)="([^"]+)"/)
      if (!linkMatch) continue
      const absUrl = toAbsoluteUrl(linkMatch[1], baseUrl)
      if (!absUrl) continue
      const lowestPrice = extractLowestPrice(b)
      if (!lowestPrice) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: absUrl,
        price: lowestPrice,
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[${storeName} native] ${items.length} raw items`)
    return normalizeProducts(items, storeName)
  } catch (err) {
    console.error(`[${storeName} native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// Generic Shopify scraper using /search/suggest.json + HTML fallback
async function scrapeShopify(query: string, baseUrl: string, storeName: string): Promise<RawProduct[]> {
  try {
    const jsonUrl = `${baseUrl}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10`
    const jsonRes = await fetchWithTimeout(jsonUrl, { headers: { 'Accept': 'application/json' } }, 10000)
    if (jsonRes.ok) {
      const data = await jsonRes.json().catch(() => null)
      const products = data?.resources?.results?.products || []
      if (products.length > 0) {
        const items: Partial<RawProduct>[] = []
        for (const p of products) {
          const absUrl = toAbsoluteUrl(p.url || '', baseUrl)
          if (!absUrl) continue
          // Shopify suggest returns price as string (lowest variant); use Math.min if multiple price fields
          const candidates: number[] = []
          for (const k of ['price', 'price_min', 'compare_at_price_min']) {
            const v = parsePrice(p[k]); if (v !== null && v > 0) candidates.push(v)
          }
          const finalPrice = candidates.length > 0 ? Math.min(...candidates) : null
          if (finalPrice === null) continue
          items.push({ name: p.title, url: absUrl, price: finalPrice, image: p.image || p.featured_image })
        }
        if (items.length > 0) {
          console.log(`[${storeName} native] JSON ${items.length} items`)
          return normalizeProducts(items, storeName)
        }
      }
    }
    // Fallback: HTML scrape
    const htmlUrl = `${baseUrl}/search?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(htmlUrl, {}, 10000)
    if (!res.ok) { console.log(`[${storeName} native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const cardRe = /<a[^>]+href="(\/products\/[^"]+)"[\s\S]{0,800}?<\/a>/g
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = cardRe.exec(html)) !== null && items.length < 15) {
      const path = m[1]
      if (seen.has(path)) continue
      seen.add(path)
      const parsed = parseShopifyCardBlock(m[0], path, baseUrl)
      if (parsed) items.push(parsed)
    }
    console.log(`[${storeName} native] HTML ${items.length} items`)
    return normalizeProducts(items, storeName)
  } catch (err) {
    console.error(`[${storeName} native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// RayaShop uses Hyvä theme — different DOM than classic Magento. Try Hyvä first, then generic Magento.
// CRITICAL: Only accept canonical product URLs ending in .html and prepend https://www.rayashop.com.
async function scrapeRayaShop(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://www.rayashop.com/catalogsearch/result/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, { headers: STEALTH_HEADERS }, 10000)
    if (!res.ok) { console.log(`[RayaShop native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const hyvaRe = /<div[^>]*class="[^"]*product-item-info[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*product-item-info|<\/(?:ol|ul|main))/g
    let blocks = html.match(hyvaRe) || []
    if (blocks.length === 0) {
      const altRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
      blocks = html.match(altRe) || []
    }
    const seenUrls = new Set<string>()
    for (const b of blocks.slice(0, 15)) {
      let canonicalHref: string | null = null
      let nameFromAnchor = ''
      const linkPatterns: RegExp[] = [
        /<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/,
        /<a[^>]+href="([^"]+\.html[^"]*)"[^>]*\bclass="[^"]*product-item-link[^"]*"[^>]*>([\s\S]*?)<\/a>/,
        /<a[^>]+href="(https?:\/\/(?:www\.)?rayashop\.com\/[^"]+\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/,
        /<a[^>]+href="(\/[^"]+\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/,
      ]
      for (const re of linkPatterns) {
        const m = b.match(re)
        if (m) { canonicalHref = m[1]; nameFromAnchor = stripTags(m[2] || ''); break }
      }
      if (!canonicalHref) continue
      const lowerHref = canonicalHref.toLowerCase()
      if (/add-?to-?cart|wishlist|compare|javascript:|checkout|customer|\/category\//.test(lowerHref)) continue
      if (!/\.html(\?|$|#)/.test(lowerHref)) continue
      let absUrl: string
      try {
        absUrl = canonicalHref.startsWith('http')
          ? canonicalHref.replace(/^https?:\/\/(www\.)?rayashop\.com/, 'https://www.rayashop.com')
          : `https://www.rayashop.com${canonicalHref.startsWith('/') ? '' : '/'}${canonicalHref}`
      } catch { continue }
      if (seenUrls.has(absUrl)) continue
      seenUrls.add(absUrl)

      // Single lowest price per card (Math.min over all detected candidates)
      const lowestPrice = extractLowestPrice(b)
      if (!lowestPrice) continue

      let name = nameFromAnchor
      if (!name) {
        const titleM = b.match(/title="([^"]+)"/) || b.match(/<img[^>]+alt="([^"]+)"/)
        name = titleM ? stripTags(titleM[1]) : ''
      }
      if (!name) continue

      const imgMatch = b.match(/<img[^>]+(?:data-src|src)="([^"]+)"/)
      items.push({ name, url: absUrl, price: lowestPrice, image: imgMatch ? imgMatch[1] : '' })
    }
    console.log(`[RayaShop native] ${items.length} raw items (${blocks.length} blocks)`)
    return normalizeProducts(items, 'RayaShop')
  } catch (err) {
    console.error(`[RayaShop native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

const scrapeCompumarts = (q: string) => scrapeMagento(q, 'https://compumarts.com', '/catalogsearch/result/?q=', 'Compumarts')
const scrapeIShop     = (q: string) => scrapeShopify(q, 'https://ishop.com.eg', 'iShop')
const scrapeSelectEG  = (q: string) => scrapeShopify(q, 'https://select.eg', 'Select.eg')

// ── 17 STORES ──
// Each native store also has a searchUrl, used as the Firecrawl fallback target if native returns 0 items.
const STORE_CONFIGS: Record<string, StoreConfig> = {
  // GENERAL
  'Amazon Egypt':      { searchUrl: q => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}`, method: 'native', tier: 1, nativeScraper: scrapeAmazonEG },
  // Noon → Firecrawl: Supabase edge IPs get HTTP/2 reset + DNS issues against noon.com
  'Noon':              { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'B.TECH':            { searchUrl: q => `https://btech.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'Jumia':             { searchUrl: q => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`, method: 'native', tier: 1, nativeScraper: scrapeJumia },
  '2B Egypt':          { searchUrl: q => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'native', tier: 1, nativeScraper: scrape2B },
  'RayaShop':          { searchUrl: q => `https://www.rayashop.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'native', tier: 1, nativeScraper: scrapeRayaShop },
  // APPLE_ONLY
  // Tradeline → Firecrawl: Supabase edge IPs get blocked at TLS layer
  'Tradeline':         { searchUrl: q => `https://tradeline.com.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'iShop':             { searchUrl: q => `https://ishop.com.eg/search?q=${encodeURIComponent(q)}`, method: 'native', tier: 2, nativeScraper: scrapeIShop },
  'Switch Plus':       { searchUrl: q => `https://switchplus.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // PC_HARDWARE
  'Sigma':             { searchUrl: q => `https://sigma-computer.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'ElNekhely':         { searchUrl: q => `https://elnekhely.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'Compumarts':        { searchUrl: q => `https://compumarts.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'native', tier: 2, nativeScraper: scrapeCompumarts },
  'Maximum Hardware':  { searchUrl: q => `https://maximumhardware.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // MOBILE_ONLY
  'Dream 2000':        { searchUrl: q => `https://dream2000.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Select.eg':         { searchUrl: q => `https://select.eg/search?q=${encodeURIComponent(q)}`, method: 'native', tier: 3, nativeScraper: scrapeSelectEG },
  'Mobile Shop':       { searchUrl: q => `https://mobileshop.com.eg/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Dubai Phone':       { searchUrl: q => `https://dubaiphone.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
}

// ── Scraper: Firecrawl ──
async function scrapeWithFirecrawl(query: string, storeName: string, searchUrl: string, firecrawlKey: string): Promise<RawProduct[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        url: searchUrl, formats: ['extract'],
        extract: {
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
          prompt: `Extract top 5 product listings from this ${storeName} search page for "${query}". Only actual products, no accessories.`,
        },
        waitFor: 5000,
      }),
    })
    const data = await response.json()
    if (!response.ok) { console.error(`[Firecrawl] ${storeName} error:`, data); return [] }
    const products = data?.data?.extract?.products || data?.extract?.products || []
    console.log(`[Firecrawl] ${storeName}: ${products.length} raw products`)
    return normalizeProducts(products, storeName)
  } catch (err) {
    console.error(`[Firecrawl] ${storeName}: ${err instanceof Error && err.name === 'AbortError' ? 'timeout' : err}`)
    return []
  } finally { clearTimeout(timeout) }
}

// ── Credit helpers (stateless) ──
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
    const { query, store, user_id } = await req.json()

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Query is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (!store || !STORE_CONFIGS[store]) {
      return new Response(JSON.stringify({ success: false, error: `Invalid store. Valid: ${Object.keys(STORE_CONFIGS).join(', ')}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const trimmedQuery = query.trim().toLowerCase()
    const cacheKey = `${store}:${trimmedQuery}`
    console.log(`[${store}] Query: "${trimmedQuery}" user=${user_id || 'anon'}`)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // ── Check cache (stateless) ──
    const cacheClient = createClient(supabaseUrl, supabaseKey)
    const { data: cached } = await cacheClient
      .from('search_cache').select('results, created_at')
      .eq('query', cacheKey).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).single()

    if (cached && Array.isArray(cached.results) && cached.results.length > 0) {
      console.log(`[${store}] Cache hit (${cached.results.length} products)`)
      return new Response(JSON.stringify({ success: true, products: cached.results, cached: true, store, cachedAt: cached.created_at }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Scrape ──
    // Credit logic:
    //   - method='firecrawl': reserve 1 credit upfront, settle 1 if items returned else 0
    //   - method='native': zero cost. If native returns 0 items, Safety Valve fires → reserve+charge 1 credit only when Firecrawl fallback returns items.
    const config = STORE_CONFIGS[store]
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    let products: RawProduct[] = []
    let txId: string | null = null
    let usedFallback = false

    try {
      if (config.method === 'native') {
        if (!config.nativeScraper) throw new Error('Native scraper not configured')
        products = await config.nativeScraper(trimmedQuery)

        // ── Safety Valve: native returned 0 → silently fall back to Firecrawl ──
        if (products.length === 0 && firecrawlKey) {
          console.log(`[${store}] Safety Valve triggered — native returned 0, trying Firecrawl fallback`)
          if (user_id) {
            txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, trimmedQuery)
            // If user has no credits, just return 0 results silently — no error
            if (!txId) {
              console.log(`[${store}] Safety Valve skipped — no credits`)
            }
          }
          if (!user_id || txId) {
            const fallback = await scrapeWithFirecrawl(trimmedQuery, store, config.searchUrl(trimmedQuery), firecrawlKey)
            if (fallback.length > 0) {
              products = fallback
              usedFallback = true
              console.log(`[${store}] Safety Valve recovered ${products.length} items via Firecrawl`)
            }
          }
        }
      } else {
        // method='firecrawl' — reserve credit upfront
        if (!firecrawlKey) throw new Error('Firecrawl not configured')
        if (user_id) {
          txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, trimmedQuery)
          if (!txId) {
            return new Response(JSON.stringify({ success: false, error: 'Insufficient credits' }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
          }
        }
        products = await scrapeWithFirecrawl(trimmedQuery, store, config.searchUrl(trimmedQuery), firecrawlKey)
      }
    } catch (scrapeErr) {
      if (txId) await settleCredits(supabaseUrl, supabaseKey, txId, 0)
      console.error(`[${store}] Scrape error:`, scrapeErr)
      return new Response(JSON.stringify({ success: true, products: [], cached: false, store, error: String(scrapeErr) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Settle credits ──
    // Charge 1 only if (a) firecrawl method OR (b) native fallback recovered items.
    if (txId) {
      const charge = products.length > 0 ? 1 : 0
      await settleCredits(supabaseUrl, supabaseKey, txId, charge)
    }
    if (usedFallback) console.log(`[${store}] Used Firecrawl fallback (charged ${products.length > 0 ? 1 : 0} credit)`)

    // Intent filter
    const beforeCount = products.length
    products = products.filter(p => matchesIntent(trimmedQuery, p.name))
    if (products.length < beforeCount) console.log(`[${store}] Intent: ${beforeCount} -> ${products.length}`)

    // ── UPSERT cache (self-cleaning, prevents DB bloat) ──
    if (products.length > 0) {
      const writeClient = createClient(supabaseUrl, supabaseKey)
      const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString()
      await writeClient.from('search_cache').upsert(
        { query: cacheKey, results: products as any, expires_at: expiresAt, created_at: new Date().toISOString() },
        { onConflict: 'query' }
      )
    }

    console.log(`[${store}] Returning ${products.length} products`)
    return new Response(JSON.stringify({ success: true, products, cached: false, store, usedFallback }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Error:', error)
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
