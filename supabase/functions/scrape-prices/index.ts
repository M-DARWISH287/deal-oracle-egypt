import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CACHE_TTL_HOURS = 24

interface RawProduct {
  name: string
  name_ar?: string
  price: number | string
  url: string
  image?: string
  specs?: string
  store: string
}

function parsePrice(text: string): number | null {
  if (!text) return null
  const cleaned = text
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[^0-9.]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

// TOP 6 CORE STORES ONLY — secondary stores disabled to stop credit burn
const STORE_CONFIGS: Record<string, { searchUrl: (q: string) => string; method: 'firecrawl' | 'serpapi' }> = {
  'Amazon Egypt': { searchUrl: () => '', method: 'serpapi' },
  'Noon': { searchUrl: q => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`, method: 'firecrawl' },
  'B.TECH': { searchUrl: () => '', method: 'serpapi' },
  'Jumia': { searchUrl: q => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`, method: 'firecrawl' },
  '2B Egypt': { searchUrl: q => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`, method: 'firecrawl' },
  'Tradeline': { searchUrl: q => `https://tradeline.com.eg/search?q=${encodeURIComponent(q)}`, method: 'firecrawl' },
}

const SERPAPI_STORE_FILTERS: Record<string, string> = {
  'Amazon Egypt': 'amazon.eg',
  'B.TECH': 'btech.com',
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

async function scrapeWithFirecrawl(
  query: string,
  storeName: string,
  searchUrl: string,
  firecrawlKey: string
): Promise<RawProduct[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        url: searchUrl,
        formats: ['extract'],
        extract: {
          schema: {
            type: 'object',
            properties: {
              products: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Full product name/title' },
                    name_ar: { type: 'string', description: 'Product name in Arabic if available' },
                    price: { type: 'string', description: 'Price as displayed on the page, including currency' },
                    url: { type: 'string', description: 'Direct product page URL (full absolute URL)' },
                    image: { type: 'string', description: 'Product image URL (full absolute URL)' },
                    specs: { type: 'string', description: 'Brief product specifications or description' },
                  },
                  required: ['name', 'price', 'url'],
                },
              },
            },
            required: ['products'],
          },
          prompt: `Extract the top 5 product listings from this ${storeName} search results page for the query "${query}". 
IMPORTANT: Only extract ACTUAL products matching the search query. 
DO NOT include accessories like cases, covers, screen protectors, cables, chargers, adapters, holders, or any peripheral items.
For each product extract: full product name, price as shown on page, direct product page URL, product image URL, and brief specs.
Only include products that are clearly listed with a price.`,
        },
        waitFor: 5000,
      }),
    })

    const data = await response.json()
    if (!response.ok) {
      console.error(`[Firecrawl] ${storeName} error:`, data)
      return []
    }

    const extract = data?.data?.extract || data?.extract
    const products = extract?.products || []
    console.log(`[Firecrawl] ${storeName}: RAW response status=${response.status}`)
    console.log(`[Firecrawl] ${storeName}: RAW extract keys=${JSON.stringify(Object.keys(extract || {}))}`)
    console.log(`[Firecrawl] ${storeName}: RAW products count=${products.length}`)
    console.log(`[Firecrawl] ${storeName}: RAW products BEFORE filters=`, JSON.stringify(products.slice(0, 3)))

    return products
      .filter((p: any) => p.name && p.price && !isAccessory(p.name))
      .slice(0, 5)
      .map((p: any) => {
        const parsed = parsePrice(String(p.price))
        return {
          name: p.name,
          name_ar: p.name_ar || p.name,
          price: parsed !== null ? parsed : 0,
          url: p.url,
          image: p.image || '',
          specs: p.specs || '',
          store: storeName,
        }
      })
      .filter((p: RawProduct) => p.price > 0)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[Firecrawl] ${storeName}: timeout after 30s`)
    } else {
      console.error(`[Firecrawl] ${storeName} error:`, err)
    }
    return []
  } finally {
    clearTimeout(timeout)
  }
}

async function scrapeWithSerpApi(
  query: string,
  storeName: string,
  serpApiKey: string
): Promise<RawProduct[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const storeFilter = SERPAPI_STORE_FILTERS[storeName] || ''
    const searchQuery = storeFilter ? `${query} site:${storeFilter}` : query
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: searchQuery,
      gl: 'eg',
      hl: 'ar',
      num: '5',
      api_key: serpApiKey,
    })

    const response = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: controller.signal,
    })
    const data = await response.json()
    if (!response.ok) return []

    const results = data.shopping_results || []
    console.log(`[SerpApi] ${storeName}: RAW response status=${response.status}`)
    console.log(`[SerpApi] ${storeName}: RAW result keys=${JSON.stringify(Object.keys(data))}`)
    console.log(`[SerpApi] ${storeName}: RAW results count=${results.length}`)
    console.log(`[SerpApi] ${storeName}: RAW results BEFORE filters=`, JSON.stringify(results.slice(0, 3)))

    return results
      .filter((r: any) => r.title && r.price && !isAccessory(r.title))
      .slice(0, 5)
      .map((r: any) => {
        const parsed = parsePrice(r.extracted_price?.toString() || r.price || '0')
        return {
          name: r.title,
          name_ar: r.title,
          price: parsed !== null ? parsed : 0,
          url: r.link || r.product_link || '',
          image: r.thumbnail || '',
          specs: r.snippet || '',
          store: storeName,
        }
      })
      .filter((p: RawProduct) => p.price > 0)
  } catch (err) {
    console.error(`[SerpApi] ${storeName} error:`, err)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { query, store } = await req.json()

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Query is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!store || typeof store !== 'string' || !STORE_CONFIGS[store]) {
      return new Response(
        JSON.stringify({ success: false, error: `Invalid store. Valid: ${Object.keys(STORE_CONFIGS).join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const trimmedQuery = query.trim().toLowerCase()
    const cacheKey = `${store}:${trimmedQuery}`
    console.log(`[${store}] Query: "${trimmedQuery}"`)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: cached } = await supabase
      .from('search_cache')
      .select('results, created_at')
      .eq('query', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (cached) {
      console.log(`[${store}] Cache hit`)
      return new Response(
        JSON.stringify({ success: true, products: cached.results, cached: true, store, cachedAt: cached.created_at }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const config = STORE_CONFIGS[store]
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    const serpApiKey = Deno.env.get('SERPAPI_API_KEY')

    let products: RawProduct[] = []

    if (config.method === 'firecrawl') {
      if (!firecrawlKey) {
        return new Response(
          JSON.stringify({ success: false, error: 'Firecrawl not configured', store }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      products = await scrapeWithFirecrawl(trimmedQuery, store, config.searchUrl(trimmedQuery), firecrawlKey)
    } else if (config.method === 'serpapi') {
      if (!serpApiKey) {
        return new Response(
          JSON.stringify({ success: false, error: 'SerpApi not configured', store }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      products = await scrapeWithSerpApi(trimmedQuery, store, serpApiKey)
    }

    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString()
    await supabase.from('search_cache').insert({
      query: cacheKey,
      results: products as any,
      expires_at: expiresAt,
    })

    console.log(`[${store}] Returning ${products.length} products`)
    return new Response(
      JSON.stringify({ success: true, products, cached: false, store }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
