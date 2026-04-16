import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CACHE_TTL_HOURS = 12
const MINIMUM_PRICE_THRESHOLD = 1500
const STORE_TIMEOUT_MS = 15000

// ── Types ──
interface RawProduct {
  name: string; name_ar?: string; price: number | string;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
}

interface StoreConfig {
  searchUrl: (q: string) => string;
  method: 'firecrawl' | 'serpapi';
  tier: 1 | 2 | 3;
}

// ── 17 STORES ──
const STORE_CONFIGS: Record<string, StoreConfig> = {
  // GENERAL
  'Amazon Egypt':      { searchUrl: () => '', method: 'serpapi', tier: 1 },
  'Noon':              { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'B.TECH':            { searchUrl: () => '', method: 'serpapi', tier: 1 },
  'Jumia':             { searchUrl: q => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  '2B Egypt':          { searchUrl: q => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  'RayaShop':          { searchUrl: q => `https://rayashop.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 1 },
  // APPLE_ONLY
  'Tradeline':         { searchUrl: q => `https://tradeline.com.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'iShop':             { searchUrl: q => `https://ishop.com.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'Switch Plus':       { searchUrl: q => `https://switchplus.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // PC_HARDWARE
  'Sigma':             { searchUrl: q => `https://sigma-computer.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'ElNekhely':         { searchUrl: q => `https://elnekhely.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'Compumarts':        { searchUrl: q => `https://compumarts.com/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  'Maximum Hardware':  { searchUrl: q => `https://maximumhardware.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 2 },
  // MOBILE_ONLY
  'Dream 2000':        { searchUrl: q => `https://dream2000.com/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Select.eg':         { searchUrl: q => `https://select.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Mobile Shop':       { searchUrl: q => `https://mobileshop.com.eg/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
  'Dubai Phone':       { searchUrl: q => `https://dubaiphone.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl', tier: 3 },
}

const SERPAPI_STORE_FILTERS: Record<string, string> = {
  'Amazon Egypt': 'amazon.eg',
  'B.TECH': 'btech.com',
}

// ── Helpers ──
function parsePrice(text: string): number | null {
  if (!text) return null
  const cleaned = text
    .replace(/شهري[اً]?|قسط|monthly|\/month/gi, '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
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
    return products.filter((p: any) => p.name && p.price && !isAccessory(p.name)).slice(0, 5).map((p: any) => {
      const parsed = parsePrice(String(p.price))
      return { name: p.name, name_ar: p.name_ar || p.name, price: parsed ?? 0, url: p.url, image: p.image || '', specs: p.specs || '', store: storeName, isRefurbished: checkRefurbished(p.name) }
    }).filter((p: RawProduct) => p.price >= MINIMUM_PRICE_THRESHOLD)
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

    // ── Reserve 1 credit if authenticated ──
    let txId: string | null = null
    if (user_id) {
      txId = await reserveCredits(supabaseUrl, supabaseKey, user_id, store, trimmedQuery)
      if (!txId) {
        return new Response(JSON.stringify({ success: false, error: 'Insufficient credits' }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // ── Scrape ──
    const config = STORE_CONFIGS[store]
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    const serpApiKey = Deno.env.get('SERPAPI_API_KEY')
    let products: RawProduct[] = []

    try {
      if (config.method === 'firecrawl') {
        if (!firecrawlKey) throw new Error('Firecrawl not configured')
        products = await scrapeWithFirecrawl(trimmedQuery, store, config.searchUrl(trimmedQuery), firecrawlKey)
      } else {
        if (!serpApiKey) throw new Error('SerpApi not configured')
        products = await scrapeWithSerpApi(trimmedQuery, store, serpApiKey)
      }
    } catch (scrapeErr) {
      if (txId) await settleCredits(supabaseUrl, supabaseKey, txId, 0)
      return new Response(JSON.stringify({ success: false, error: String(scrapeErr), store }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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
