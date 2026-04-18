import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CACHE_TTL_HOURS = 12
const MINIMUM_PRICE_THRESHOLD = 1500
const STORE_TIMEOUT_MS = 15000

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── Types ──
interface RawProduct {
  name: string; name_ar?: string; price: number | string;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
}

type ScrapeMethod = 'native' | 'firecrawl' | 'serpapi'

interface StoreConfig {
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

function matchesIntent(query: string, productName: string): boolean {
  const q = query.toLowerCase(); const n = productName.toLowerCase()
  for (const v of ['pro', 'plus', 'max', 'ultra']) {
    if (!q.includes(v) && n.includes(v)) return false
  }
  if (!q.includes('+') && !q.includes('plus') && n.includes('+')) return false
  return true
}

const ACCESSORY_KEYWORDS = [
  'case', 'cover', 'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder', 'stand', 'mount',
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة',
  'earphone', 'earbuds', 'headset', 'strap', 'band', 'pouch', 'sleeve',
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

// Jumia: HTML with article.prd elements
async function scrapeJumia(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[Jumia native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    // Each product is inside <article class="prd ...">
    const articleRe = /<article[^>]*class="[^"]*\bprd\b[^"]*"[\s\S]*?<\/article>/g
    const articles = html.match(articleRe) || []
    for (const a of articles.slice(0, 15)) {
      const hrefMatch = a.match(/<a[^>]+class="core"[^>]+href="([^"]+)"/) || a.match(/<a[^>]+href="(\/[^"]+)"/)
      const nameMatch = a.match(/<h3[^>]*class="name"[^>]*>([\s\S]*?)<\/h3>/)
      const priceMatch = a.match(/<div[^>]*class="prc"[^>]*>([\s\S]*?)<\/div>/)
      const imgMatch = a.match(/<img[^>]+data-src="([^"]+)"/) || a.match(/<img[^>]+src="([^"]+)"/)
      if (!hrefMatch || !nameMatch || !priceMatch) continue
      const path = hrefMatch[1]
      items.push({
        name: stripTags(nameMatch[1]),
        url: path.startsWith('http') ? path : `https://www.jumia.com.eg${path}`,
        price: stripTags(priceMatch[1]),
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

// B.TECH: Magento/PWA — try the storefront search HTML
async function scrapeBtech(query: string): Promise<RawProduct[]> {
  try {
    const url = `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[B.TECH native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    // Magento product items
    const itemRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
    const blocks = html.match(itemRe) || []
    for (const b of blocks.slice(0, 15)) {
      const linkMatch = b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const priceMatch = b.match(/data-price-amount="([0-9.]+)"/) || b.match(/<span[^>]*class="price"[^>]*>([\s\S]*?)<\/span>/)
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch || !priceMatch) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: linkMatch[1],
        price: priceMatch[1],
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
      const priceMatch = b.match(/data-price-amount="([0-9.]+)"/) || b.match(/<span[^>]*class="price"[^>]*>([\s\S]*?)<\/span>/)
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch || !priceMatch) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: linkMatch[1],
        price: priceMatch[1],
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

// Dream 2000: Shopify-like — try /search/suggest.json then HTML
async function scrapeDream2000(query: string): Promise<RawProduct[]> {
  try {
    // Try Shopify predictive search JSON first
    const jsonUrl = `https://dream2000.com/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10`
    const jsonRes = await fetchWithTimeout(jsonUrl, { headers: { 'Accept': 'application/json' } }, 10000)
    if (jsonRes.ok) {
      const data = await jsonRes.json().catch(() => null)
      const products = data?.resources?.results?.products || []
      if (products.length > 0) {
        const items: Partial<RawProduct>[] = products.map((p: any) => ({
          name: p.title,
          url: p.url?.startsWith('http') ? p.url : `https://dream2000.com${p.url}`,
          price: p.price,
          image: p.image || p.featured_image,
        }))
        console.log(`[Dream2000 native] JSON ${items.length} items`)
        return normalizeProducts(items, 'Dream 2000')
      }
    }
    // Fallback: HTML scrape
    const url = `https://dream2000.com/search?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[Dream2000 native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    // Generic Shopify product cards
    const cardRe = /<a[^>]+href="(\/products\/[^"]+)"[\s\S]{0,800}?<\/a>/g
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = cardRe.exec(html)) !== null && items.length < 15) {
      const path = m[1]
      if (seen.has(path)) continue
      seen.add(path)
      const block = m[0]
      const titleMatch = block.match(/title="([^"]+)"/) || block.match(/alt="([^"]+)"/)
      const priceMatch = block.match(/(\d[\d,]*\.?\d*)\s*(?:EGP|ج\.م|LE)/i)
      const imgMatch = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/)
      if (!titleMatch || !priceMatch) continue
      items.push({
        name: titleMatch[1],
        url: `https://dream2000.com${path}`,
        price: priceMatch[1],
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[Dream2000 native] HTML ${items.length} items`)
    return normalizeProducts(items, 'Dream 2000')
  } catch (err) {
    console.error(`[Dream2000 native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// Select.eg: Shopify
async function scrapeSelect(query: string): Promise<RawProduct[]> {
  try {
    const jsonUrl = `https://select.eg/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10`
    const jsonRes = await fetchWithTimeout(jsonUrl, { headers: { 'Accept': 'application/json' } }, 10000)
    if (jsonRes.ok) {
      const data = await jsonRes.json().catch(() => null)
      const products = data?.resources?.results?.products || []
      if (products.length > 0) {
        const items: Partial<RawProduct>[] = products.map((p: any) => ({
          name: p.title,
          url: p.url?.startsWith('http') ? p.url : `https://select.eg${p.url}`,
          price: p.price,
          image: p.image || p.featured_image,
        }))
        console.log(`[Select native] JSON ${items.length} items`)
        return normalizeProducts(items, 'Select.eg')
      }
    }
    const url = `https://select.eg/search?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) { console.log(`[Select native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const cardRe = /<a[^>]+href="(\/products\/[^"]+)"[\s\S]{0,800}?<\/a>/g
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = cardRe.exec(html)) !== null && items.length < 15) {
      const path = m[1]
      if (seen.has(path)) continue
      seen.add(path)
      const block = m[0]
      const titleMatch = block.match(/title="([^"]+)"/) || block.match(/alt="([^"]+)"/)
      const priceMatch = block.match(/(\d[\d,]*\.?\d*)\s*(?:EGP|ج\.م|LE)/i)
      const imgMatch = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/)
      if (!titleMatch || !priceMatch) continue
      items.push({
        name: titleMatch[1],
        url: `https://select.eg${path}`,
        price: priceMatch[1],
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[Select native] HTML ${items.length} items`)
    return normalizeProducts(items, 'Select.eg')
  } catch (err) {
    console.error(`[Select native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

// ── NATIVE SCRAPERS (Group 2) ──

// Generic Magento scraper (used by RayaShop, Compumarts, etc.)
async function scrapeMagento(query: string, baseUrl: string, searchPath: string, storeName: string): Promise<RawProduct[]> {
  try {
    const url = `${baseUrl}${searchPath}${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, {}, 10000)
    if (!res.ok) { console.log(`[${storeName} native] HTTP ${res.status}`); return [] }
    const html = await res.text()
    const items: Partial<RawProduct>[] = []
    const itemRe = /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"[\s\S]*?<\/li>/g
    const blocks = html.match(itemRe) || []
    for (const b of blocks.slice(0, 15)) {
      const linkMatch = b.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const priceMatch = b.match(/data-price-amount="([0-9.]+)"/) || b.match(/<span[^>]*class="price"[^>]*>([\s\S]*?)<\/span>/)
      const imgMatch = b.match(/<img[^>]+src="([^"]+)"/)
      if (!linkMatch || !priceMatch) continue
      items.push({
        name: stripTags(linkMatch[2]),
        url: linkMatch[1],
        price: priceMatch[1],
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
        const items: Partial<RawProduct>[] = products.map((p: any) => ({
          name: p.title,
          url: p.url?.startsWith('http') ? p.url : `${baseUrl}${p.url}`,
          price: p.price,
          image: p.image || p.featured_image,
        }))
        console.log(`[${storeName} native] JSON ${items.length} items`)
        return normalizeProducts(items, storeName)
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
      const block = m[0]
      const titleMatch = block.match(/title="([^"]+)"/) || block.match(/alt="([^"]+)"/)
      const priceMatch = block.match(/(\d[\d,]*\.?\d*)\s*(?:EGP|ج\.م|LE)/i)
      const imgMatch = block.match(/<img[^>]+src="([^"]+)"/) || block.match(/data-src="([^"]+)"/)
      if (!titleMatch || !priceMatch) continue
      items.push({
        name: titleMatch[1],
        url: `${baseUrl}${path}`,
        price: priceMatch[1],
        image: imgMatch ? imgMatch[1] : '',
      })
    }
    console.log(`[${storeName} native] HTML ${items.length} items`)
    return normalizeProducts(items, storeName)
  } catch (err) {
    console.error(`[${storeName} native] error:`, err instanceof Error ? err.message : err)
    return []
  }
}

const scrapeRayaShop  = (q: string) => scrapeMagento(q, 'https://rayashop.com', '/catalogsearch/result/?q=', 'RayaShop')
const scrapeCompumarts = (q: string) => scrapeMagento(q, 'https://compumarts.com', '/catalogsearch/result/?q=', 'Compumarts')
const scrapeTradeline = (q: string) => scrapeShopify(q, 'https://tradeline.com.eg', 'Tradeline')
const scrapeIShop     = (q: string) => scrapeShopify(q, 'https://ishop.com.eg', 'iShop')

// ── 17 STORES ──
const STORE_CONFIGS: Record<string, StoreConfig> = {
  // GENERAL
  'Amazon Egypt':      { searchUrl: () => '', method: 'serpapi', tier: 1 },
  'Noon':              { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'B.TECH':            { searchUrl: q => `https://btech.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'Jumia':             { searchUrl: () => '', method: 'native', tier: 1, nativeScraper: scrapeJumia },
  '2B Egypt':          { searchUrl: () => '', method: 'native', tier: 1, nativeScraper: scrape2B },
  'RayaShop':          { searchUrl: () => '', method: 'native', tier: 1, nativeScraper: scrapeRayaShop },
  // APPLE_ONLY
  'Tradeline':         { searchUrl: () => '', method: 'native', tier: 2, nativeScraper: scrapeTradeline },
  'iShop':             { searchUrl: () => '', method: 'native', tier: 2, nativeScraper: scrapeIShop },
  'Switch Plus':       { searchUrl: q => `https://switchplus.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // PC_HARDWARE
  'Sigma':             { searchUrl: q => `https://sigma-computer.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'ElNekhely':         { searchUrl: q => `https://elnekhely.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'Compumarts':        { searchUrl: () => '', method: 'native', tier: 2, nativeScraper: scrapeCompumarts },
  'Maximum Hardware':  { searchUrl: q => `https://maximumhardware.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // MOBILE_ONLY
  'Dream 2000':        { searchUrl: q => `https://dream2000.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Select.eg':         { searchUrl: q => `https://select.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Mobile Shop':       { searchUrl: q => `https://mobileshop.com.eg/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Dubai Phone':       { searchUrl: q => `https://dubaiphone.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
}

const SERPAPI_STORE_FILTERS: Record<string, string> = {
  'Amazon Egypt': 'amazon.eg',
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

// ── Scraper: SerpApi ──
async function scrapeWithSerpApi(query: string, storeName: string, serpApiKey: string): Promise<RawProduct[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS)
  try {
    const storeFilter = SERPAPI_STORE_FILTERS[storeName] || ''
    const searchQuery = storeFilter ? `${query} ${storeFilter}` : query
    const params = new URLSearchParams({ engine: 'google_shopping', q: searchQuery, hl: 'en', num: '10', api_key: serpApiKey })
    const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: controller.signal })
    const data = await response.json()
    console.log(`[SerpApi] ${storeName}: ${(data.shopping_results || []).length} raw results`)
    if (!response.ok) return []
    const results = data.shopping_results || []
    const storeDomain = SERPAPI_STORE_FILTERS[storeName]
    return results.filter((r: any) => {
      if (!r.title || !r.price || isAccessory(r.title)) return false
      if (storeDomain) {
        const link = (r.product_link || r.link || '').toLowerCase()
        if (!link.includes(storeDomain)) return false
      }
      return true
    }).slice(0, 5).map((r: any) => {
      const parsed = parsePrice(r.extracted_price?.toString() || r.price || '0')
      return { name: r.title, name_ar: r.title, price: parsed ?? 0, url: r.product_link || r.link || '', image: r.thumbnail || '', specs: r.snippet || '', store: storeName, isRefurbished: checkRefurbished(r.title) }
    }).filter((p: RawProduct) => p.price >= MINIMUM_PRICE_THRESHOLD)
  } catch (err) { console.error(`[SerpApi] ${storeName}:`, err); return [] }
  finally { clearTimeout(timeout) }
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

    // ── Reserve 1 credit if authenticated (skip for native — they're free) ──
    const config = STORE_CONFIGS[store]
    let txId: string | null = null
    if (user_id && config.method !== 'native') {
      txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, trimmedQuery)
      if (!txId) {
        return new Response(JSON.stringify({ success: false, error: 'Insufficient credits' }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // ── Scrape ──
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    const serpApiKey = Deno.env.get('SERPAPI_API_KEY')
    let products: RawProduct[] = []

    try {
      if (config.method === 'native') {
        if (!config.nativeScraper) throw new Error('Native scraper not configured')
        products = await config.nativeScraper(trimmedQuery)
      } else if (config.method === 'firecrawl') {
        if (!firecrawlKey) throw new Error('Firecrawl not configured')
        products = await scrapeWithFirecrawl(trimmedQuery, store, config.searchUrl(trimmedQuery), firecrawlKey)
      } else {
        if (!serpApiKey) throw new Error('SerpApi not configured')
        products = await scrapeWithSerpApi(trimmedQuery, store, serpApiKey)
      }
    } catch (scrapeErr) {
      if (txId) await settleCredits(supabaseUrl, supabaseKey, txId, 0)
      console.error(`[${store}] Scrape error:`, scrapeErr)
      return new Response(JSON.stringify({ success: true, products: [], cached: false, store, error: String(scrapeErr) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Settle credits ──
    if (txId) {
      await settleCredits(supabaseUrl, supabaseKey, txId, products.length > 0 ? 1 : 0)
    }

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
    return new Response(JSON.stringify({ success: true, products, cached: false, store }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Error:', error)
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
