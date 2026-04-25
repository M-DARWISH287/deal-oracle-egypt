// scrape-prices-router — ISOLATED orchestrator scaffold.
// Does NOT touch production `scrape-prices`. No cache, no credits, no logging.
// Purpose: validate the per-store ROUTING_MATRIX (NATIVE / FIRECRAWL / SKIP)
// with a global 8s timeout per store. Scrapers are STUBS — to be filled later.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export interface Product {
  name: string;
  price: number;
  url: string;
  store: string;
}

type StoreStrategy = 'NATIVE' | 'FIRECRAWL' | 'SKIP';

// ---------- Cache config ----------
// Postgres `search_cache` table (already provisioned): query TEXT, results JSONB,
// expires_at TIMESTAMPTZ. We store an array of per-store success entries —
// each entry mirrors the NDJSON line we'd otherwise stream live. On cache hit
// we replay those entries as NDJSON so the frontend contract is unchanged.
const CACHE_TTL_HOURS = 6;

interface CachedStoreEntry {
  store: string;
  strategy: StoreStrategy;
  status: 'success';
  count: number;
  latencyMs: number;
  products: Product[];
}

function normalizeCacheKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function readCache(key: string): Promise<CachedStoreEntry[] | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/search_cache?query=eq.${encodeURIComponent(key)}` +
        `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
        `&select=results,expires_at&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
    if (!res.ok) {
      console.log(`[CACHE] read HTTP ${res.status}`);
      return null;
    }
    const rows = (await res.json()) as Array<{ results: unknown }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const results = rows[0].results;
    if (!Array.isArray(results) || results.length === 0) return null;
    return results as CachedStoreEntry[];
  } catch (err) {
    console.log(`[CACHE] read error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function writeCache(key: string, entries: CachedStoreEntry[]): Promise<void> {
  if (entries.length === 0) {
    console.log('[CACHE] skip write — zero successful stores (no poisoning)');
    return;
  }
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return;
  try {
    const expiresAt = new Date(
      Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000,
    ).toISOString();
    // Upsert on `query` — requires a unique constraint on search_cache.query.
    // If absent, this falls back to insert and the `on_conflict` is ignored.
    const res = await fetch(
      `${url}/rest/v1/search_cache?on_conflict=query`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          query: key,
          results: entries,
          expires_at: expiresAt,
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.log(`[CACHE] write HTTP ${res.status} — ${txt.slice(0, 200)}`);
    } else {
      console.log(
        `[CACHE] ✍️  wrote ${entries.length} store entries, ttl=${CACHE_TTL_HOURS}h`,
      );
    }
  } catch (err) {
    console.log(`[CACHE] write error: ${err instanceof Error ? err.message : err}`);
  }
}

const ROUTING_MATRIX: Record<string, StoreStrategy> = {
  // Tier 1 — Native fetch viable & verified against live DOM
  'El Shennawy': 'NATIVE', // OpenCart, full SSR, /index.php?route=product/search

  // Tier 2 — SPA shells (no SSR product data) → Firecrawl required
  // Verified empirically: returns HTTP 200 but no products in HTML.
  'Raya Shop':       'FIRECRAWL', // Nuxt SPA — only marketing text in SSR
  'Tradeline':       'FIRECRAWL', // Angular SPA — search results lazy-loaded
  'Carrefour Egypt': 'FIRECRAWL', // Cloudflare JS challenge → 53-byte sentinel

  // Tier 3 — WAF / blocked native
  'Amazon Egypt': 'FIRECRAWL',
  'Jumia':        'FIRECRAWL',
  '2B Egypt':     'FIRECRAWL',
  'Cairo Sales':  'FIRECRAWL',

  // Tier 4 — Dropped or pending fix
  'Dream 2000':  'SKIP',
  'Dubai Phone': 'SKIP',
  'Noon':        'SKIP',
  'B.TECH':      'SKIP',
};

// Two-tier timeouts: native fetches stay snappy; Firecrawl JSON-extract
// (LLM-backed, heavier) gets its own larger budget.
const NATIVE_TIMEOUT_MS    =  8_000;
const FIRECRAWL_TIMEOUT_MS = 30_000;
const FIRECRAWL_V2 = 'https://api.firecrawl.dev/v2';
// Firecrawl-side timeout (ms): leave ~2s of headroom under FIRECRAWL_TIMEOUT_MS
// so AbortController doesn't fire before Firecrawl can respond with an error.
const FIRECRAWL_API_TIMEOUT_MS = 28_000;

// Per-store search URLs used by Firecrawl. Mirrors the routing matrix; any
// store routed to FIRECRAWL must have an entry here or it returns [].
const FIRECRAWL_SEARCH_URLS: Record<string, (q: string) => string> = {
  'Raya Shop':       (q) => `https://rayashop.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  'Tradeline':       (q) => `https://tradelinestores.com/search?q=${encodeURIComponent(q)}`,
  'Carrefour Egypt': (q) => `https://www.carrefouregypt.com/mafegy/en/search?keyword=${encodeURIComponent(q)}`,
  'Amazon Egypt':    (q) => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}`,
  'Jumia':           (q) => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`,
  '2B Egypt':        (q) => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  'Cairo Sales':     (q) => `https://cairosales.com/?s=${encodeURIComponent(q)}&post_type=product`,
};

// ---------- Browser headers (realistic Chrome/Win) ----------
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua':
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// ---------- Helpers ----------
function cleanPrice(raw: string): number {
  if (!raw) return 0;
  // Arabic-Indic digits → ASCII
  const ascii = raw.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString());
  // Strip currency words/symbols, keep digits + separators
  const cleaned = ascii
    .replace(/EGP|LE|L\.E\.?|ج\.?م\.?|جنيه/gi, '')
    .replace(/[^\d.,]/g, '')
    .replace(/,/g, '');
  const m = cleaned.match(/\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function absolutize(href: string, base: string): string {
  if (!href) return base;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  const root = base.replace(/\/+$/, '');
  return href.startsWith('/') ? `${root}${href}` : `${root}/${href}`;
}

function finalize(products: Product[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of products) {
    if (!p.name || p.price <= 100) continue;
    const key = `${p.store}|${p.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: BROWSER_HEADERS });
    if (!res.ok) {
      console.log(`[NATIVE] ${url} → HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`[NATIVE] ${url} → fetch error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------- Per-store parsers (REALITY-BASED) ----------
//
// Each parser was authored against a live HTML sample of the store's search
// page (query="iPhone 15"). We DO NOT hallucinate — if the live page does not
// contain SSR product data, the parser returns []. Sites that proved to be
// SPA-shells (Raya/Tradeline/Carrefour) were moved to FIRECRAWL and are no
// longer dispatched through this NATIVE path.

// El Shennawy — OpenCart 3 storefront
// Live DOM: each result is wrapped in <div class="product-thumb"> and
// contains <h4><a href="...product_id=NNN...">NAME</a></h4> and
// <p class="price"><span class="price-new">PRICE EGP</span>...</p>.
function parseElShennawy(html: string): Product[] {
  const products: Product[] = [];
  // Split per product-thumb so we don't cross-match between cards.
  const cardRe =
    /<div[^>]+class="[^"]*\bproduct-thumb\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bproduct-thumb\b|<\/section|<footer|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 25) {
    const card = m[1];
    // Skip "category-content" cards (homepage carousels in the search page header).
    if (/class="[^"]*\bcategory-content\b/i.test(card)) continue;

    const linkM = card.match(
      /<h4[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>/i,
    );
    if (!linkM) continue;

    // Prefer .price-new (sale price), fall back to first numeric inside .price.
    const priceM =
      card.match(/<span[^>]+class="[^"]*\bprice-new\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      card.match(/<p[^>]+class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (!priceM) continue;

    const name = stripTags(linkM[2]);
    const price = cleanPrice(stripTags(priceM[1]));
    const url = decodeEntities(linkM[1]); // Shennawy emits absolute URLs already
    if (!name || price <= 0) continue;
    products.push({ name, price, url, store: 'El Shennawy' });
  }
  return products;
}

// ---------- Native dispatcher ----------
async function scrapeNative(store: string, query: string): Promise<Product[]> {
  console.log(`[ROUTER] 🟢 NATIVE  ${store}  q="${query}"`);
  const q = encodeURIComponent(query);
  try {
    switch (store) {
      case 'El Shennawy': {
        // OpenCart search route (verified live). Wrong path returns the homepage.
        const html = await fetchHtml(
          `https://www.elshennawy.com/index.php?route=product/search&search=${q}`,
        );
        return html ? finalize(parseElShennawy(html)) : [];
      }
      default:
        console.log(`[NATIVE] No parser for store: ${store}`);
        return [];
    }
  } catch (err) {
    console.error(`[NATIVE] ${store} crashed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ---------- Firecrawl (strict JSON schema + validation layer) ----------
//
// We extract via `formats: ["json"]` with a strict schema so the LLM cannot
// invent fields. The prompt forbids homepage / category / search URLs, and a
// post-validation layer rejects anything that slips through (missing URL,
// domain-root URL, or shallow paths). Any product whose URL fails validation
// is dropped — we never patch or guess URLs.

const FIRECRAWL_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:  { type: 'string' },
          price: { type: 'number' },
          url:   { type: 'string' },
        },
        required: ['name', 'price', 'url'],
      },
    },
  },
  required: ['products'],
} as const;

function buildFirecrawlPrompt(store: string, query: string): string {
  return [
    `Extract the product listings for the search query "${query}" from this ${store} search results page.`,
    '',
    'For EACH product return: name (string), price (number, EGP, no currency symbol, no commas), url (string).',
    '',
    `CRITICAL: You must ONLY extract the actual smartphone or main product requested ("${query}"). You MUST STRICTLY EXCLUDE all accessories, cases, covers, screen protectors, tempered glass, cables, chargers, adapters, earphones, headsets, straps, bands, pouches, sleeves, holders, or spare parts. If the exact main product is not found on this page, return an empty array [].`,
    '',
    'STRICT URL RULES — failing ANY rule means you MUST OMIT that product entirely:',
    '1. The url MUST be ABSOLUTE and start with "https://".',
    '2. The url MUST be the DIRECT product detail page (deep link to that specific product).',
    '3. DO NOT return the homepage, a category page, a search results URL, a tracking redirect, or the storefront root.',
    '4. DO NOT invent, guess, complete, or normalize URLs. If the exact product URL is not present in the page, OMIT the product.',
    '5. The url MUST contain a product-specific path segment (e.g. a slug, SKU, or product id) — not just the domain.',
    '',
    'Return ONLY products where name, price, AND a valid deep-link url are all present, AND the product is the actual main item (not an accessory). Do not pad results.',
  ].join('\n');
}

function isValidProductUrl(rawUrl: unknown, searchPageUrl: string): boolean {
  if (typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim();
  if (!url) return false;

  let parsed: URL;
  let searchParsed: URL;
  try {
    parsed = new URL(url);
    searchParsed = new URL(searchPageUrl);
  } catch {
    return false;
  }

  // Must be https (rule 1).
  if (parsed.protocol !== 'https:') return false;

  // Must live on the same registrable host as the store we asked about —
  // blocks LLM hallucinations pointing at amazon.com / google.com / etc.
  if (parsed.hostname.replace(/^www\./, '') !==
      searchParsed.hostname.replace(/^www\./, '')) {
    return false;
  }

  // Reject domain-root / homepage.
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') return false;

  // Reject obvious search / category listing URLs.
  const lowerPath = path.toLowerCase();
  const lowerSearch = parsed.search.toLowerCase();
  const SEARCH_MARKERS = [
    '/search', '/catalogsearch', '/catalog/', '/category/', '/c/',
    '/s?', '/s/', '/results',
  ];
  if (SEARCH_MARKERS.some((m) => lowerPath.includes(m) || lowerSearch.includes(m))) {
    // Allow Amazon /dp/ and Jumia .html product pages even if path mentions /catalog
    if (!/\/(dp|gp\/product|product)\//.test(lowerPath) && !/\.html?$/.test(lowerPath)) {
      return false;
    }
  }

  // Heuristic depth check: require at least one slug-like segment beyond root.
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 1) return false;
  const hasSlugLike = segments.some((s) => s.length >= 4 && /[a-z0-9]/i.test(s));
  if (!hasSlugLike) return false;

  return true;
}

async function scrapeFirecrawl(store: string, query: string): Promise<Product[]> {
  console.log(`[ROUTER] 🔥 FIRECRAWL ${store}  q="${query}"`);

  const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) {
    console.error('[FIRECRAWL] FIRECRAWL_API_KEY not configured');
    return [];
  }
  const buildUrl = FIRECRAWL_SEARCH_URLS[store];
  if (!buildUrl) {
    console.log(`[FIRECRAWL] No search URL mapped for store: ${store}`);
    return [];
  }

  const searchPageUrl = buildUrl(query);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), FIRECRAWL_TIMEOUT_MS);

  try {
    const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: searchPageUrl,
        formats: [
          {
            type: 'json',
            schema: FIRECRAWL_SCHEMA,
            prompt: buildFirecrawlPrompt(store, query),
          },
        ],
        onlyMainContent: true,
        timeout: FIRECRAWL_API_TIMEOUT_MS,
      }),
    });

    if (!res.ok) {
      console.error(`[FIRECRAWL] ${store} HTTP ${res.status}`);
      return [];
    }

    const payload = await res.json().catch(() => null);
    // Firecrawl v2 puts extracted JSON under data.json (REST shape).
    const json =
      payload?.data?.json ??
      payload?.json ??
      payload?.data?.extract ??
      null;
    const rawProducts: unknown[] = Array.isArray(json?.products) ? json.products : [];

    const validated: Product[] = [];
    let dropped = 0;
    for (const item of rawProducts) {
      if (!item || typeof item !== 'object') { dropped++; continue; }
      const r = item as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      const priceNum =
        typeof r.price === 'number' ? r.price :
        typeof r.price === 'string' ? cleanPrice(r.price) : 0;
      const url = typeof r.url === 'string' ? r.url.trim() : '';

      if (!name || priceNum <= 100) { dropped++; continue; }
      if (!isValidProductUrl(url, searchPageUrl)) {
        dropped++;
        continue;
      }
      validated.push({ name, price: Math.round(priceNum), url, store });
    }

    const final = finalize(validated);
    console.log(
      `[FIRECRAWL] ${store} extracted=${rawProducts.length} ` +
      `dropped=${dropped} valid=${final.length}`,
    );
    // Per spec: minimum success = 2 valid products. Below that, return [].
    return final.length >= 2 ? final : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FIRECRAWL] ${store} error: ${msg}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Timeout wrapper ----------
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`[TIMEOUT] ${label} exceeded ${ms}ms`)),
      ms,
    );
    p.then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

// ---------- HTTP entrypoint ----------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Search query is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`\n🚀 ROUTER SEARCH: "${query}"`);

    // ---------- NDJSON streaming response ----------
    // Each store emits exactly one line (`{store, strategy, status, products|error}\n`)
    // the instant its scrape resolves — clients render as results arrive instead of
    // waiting for the slowest Firecrawl call (~30s) to finish.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tasks: Promise<unknown>[] = [];
        const t0 = Date.now();

        for (const [store, strategy] of Object.entries(ROUTING_MATRIX)) {
          if (strategy === 'SKIP') {
            console.log(`[ROUTER] 🚫 SKIP    ${store}`);
            continue;
          }
          const fn = strategy === 'NATIVE' ? scrapeNative : scrapeFirecrawl;
          const cap = strategy === 'NATIVE' ? NATIVE_TIMEOUT_MS : FIRECRAWL_TIMEOUT_MS;

          const task = withTimeout(fn(store, query), cap, store)
            .then((products) => {
              const latencyMs = Date.now() - t0;
              console.log(`[ROUTER] ✅ ${store} → ${products.length} in ${latencyMs}ms`);
              const line =
                JSON.stringify({
                  store,
                  strategy,
                  status: 'success',
                  count: products.length,
                  latencyMs,
                  products,
                }) + '\n';
              controller.enqueue(encoder.encode(line));
            })
            .catch((err) => {
              const latencyMs = Date.now() - t0;
              const error = err instanceof Error ? err.message : String(err);
              console.error(`[ROUTER] ❌ ${store}: ${error}`);
              const line =
                JSON.stringify({
                  store,
                  strategy,
                  status: 'error',
                  count: 0,
                  latencyMs,
                  error,
                }) + '\n';
              controller.enqueue(encoder.encode(line));
            });

          tasks.push(task);
        }

        // Close the stream once every store has reported (success, error, or timeout).
        Promise.allSettled(tasks).then(() => {
          console.log(`[ROUTER] 🏁 stream closed in ${Date.now() - t0}ms`);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});