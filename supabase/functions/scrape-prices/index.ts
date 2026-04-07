import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface StoreOffer {
  store: string
  price: number
  url: string
  currency: string
}

interface ProductResult {
  id: string
  name: { ar: string; en: string }
  specs: { ar: string; en: string }
  image: string
  category: string
  offers: StoreOffer[]
}

// Parse price from text, handling Arabic numerals and EGP formats
function parsePrice(text: string): number | null {
  // Remove currency symbols, commas, spaces
  const cleaned = text
    .replace(/[^\d٠-٩.,]/g, '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/,/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

// Scrape a store using Firecrawl
async function scrapeStore(
  query: string,
  store: { name: string; searchUrl: (q: string) => string },
  firecrawlKey: string
): Promise<{ products: any[]; error?: string }> {
  const url = store.searchUrl(query)
  console.log(`Scraping ${store.name}: ${url}`)

  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
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
                    name: { type: 'string', description: 'Product name/title' },
                    name_ar: { type: 'string', description: 'Product name in Arabic if available' },
                    price: { type: 'number', description: 'Price in EGP (Egyptian Pounds), numeric only, no currency symbol' },
                    url: { type: 'string', description: 'Direct product page URL (full URL)' },
                    image: { type: 'string', description: 'Product image URL (full URL)' },
                    specs: { type: 'string', description: 'Brief product specifications' },
                  },
                  required: ['name', 'price', 'url'],
                },
              },
            },
            required: ['products'],
          },
          prompt: `Extract all product listings visible on this ${store.name} search results page. For each product, extract: the full product name, the price as a number in EGP, the direct URL to the product page, the product image URL, and any visible specifications. Only include real products with valid prices greater than 0.`,
        },
        waitFor: 5000,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error(`Firecrawl error for ${store.name}:`, data)
      return { products: [], error: data.error || `Status ${response.status}` }
    }

    // Extract products from response
    const json = data?.data?.json || data?.json
    const products = json?.products || []
    console.log(`${store.name}: found ${products.length} products`)

    return {
      products: products
        .filter((p: any) => p.name && p.price && p.price > 0)
        .map((p: any) => ({
          ...p,
          store: store.name,
          price: typeof p.price === 'string' ? parsePrice(p.price) : p.price,
        })),
    }
  } catch (err) {
    console.error(`Error scraping ${store.name}:`, err)
    return { products: [], error: String(err) }
  }
}

// Store configurations
const STORES = [
  {
    name: 'Amazon Egypt',
    searchUrl: (q: string) => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}`,
  },
  {
    name: 'Noon',
    searchUrl: (q: string) => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`,
  },
  {
    name: 'B.TECH',
    searchUrl: (q: string) => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  },
]

// Group scraped results by product similarity
function groupProducts(allProducts: any[]): ProductResult[] {
  const grouped: Map<string, ProductResult> = new Map()

  for (const p of allProducts) {
    // Simple grouping: normalize product name
    const normalizedName = (p.name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)

    // Find existing group by checking name similarity
    let matched = false
    for (const [key, group] of grouped) {
      if (
        normalizedName.includes(key.slice(0, 20)) ||
        key.includes(normalizedName.slice(0, 20))
      ) {
        // Add as another offer
        group.offers.push({
          store: p.store,
          price: p.price,
          url: p.url,
          currency: 'EGP',
        })
        if (p.image && !group.image) group.image = p.image
        matched = true
        break
      }
    }

    if (!matched) {
      const id = crypto.randomUUID()
      grouped.set(normalizedName, {
        id,
        name: {
          en: p.name || '',
          ar: p.name_ar || p.name || '',
        },
        specs: {
          en: p.specs || '',
          ar: p.specs || '',
        },
        image: p.image || '',
        category: 'electronics',
        offers: [
          {
            store: p.store,
            price: p.price,
            url: p.url,
            currency: 'EGP',
          },
        ],
      })
    }
  }

  // Sort products by lowest best price, return top results
  return Array.from(grouped.values())
    .map((p) => {
      p.offers.sort((a, b) => a.price - b.price)
      return p
    })
    .sort((a, b) => {
      // Products with more offers first
      if (b.offers.length !== a.offers.length) return b.offers.length - a.offers.length
      return a.offers[0].price - b.offers[0].price
    })
    .slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { query } = await req.json()

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Query is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const trimmedQuery = query.trim()
    console.log('Search query:', trimmedQuery)

    // Check cache first
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: cached } = await supabase
      .from('search_cache')
      .select('results')
      .eq('query', trimmedQuery.toLowerCase())
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (cached) {
      console.log('Cache hit!')
      return new Response(
        JSON.stringify({ success: true, data: cached.results, cached: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Scrape all stores in parallel
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY')
    if (!firecrawlKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Firecrawl not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const scrapeResults = await Promise.allSettled(
      STORES.map((store) => scrapeStore(trimmedQuery, store, firecrawlKey))
    )

    const allProducts: any[] = []
    const errors: string[] = []

    for (let i = 0; i < scrapeResults.length; i++) {
      const result = scrapeResults[i]
      if (result.status === 'fulfilled') {
        allProducts.push(...result.value.products)
        if (result.value.error) errors.push(`${STORES[i].name}: ${result.value.error}`)
      } else {
        errors.push(`${STORES[i].name}: ${result.reason}`)
      }
    }

    console.log(`Total products scraped: ${allProducts.length}, errors: ${errors.length}`)

    // Group by product
    const groupedProducts = groupProducts(allProducts)

    // Cache results (1 hour TTL)
    if (groupedProducts.length > 0) {
      await supabase.from('search_cache').insert({
        query: trimmedQuery.toLowerCase(),
        results: groupedProducts,
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: groupedProducts,
        cached: false,
        storeErrors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error in scrape-prices:', error)
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
