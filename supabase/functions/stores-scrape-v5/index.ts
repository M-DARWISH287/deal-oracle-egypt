// stores-scrape-v5 — ISOLATED per-store scraper (does NOT touch production scrape-prices).
// Rules:
//   • Each store has its OWN extraction logic (no generic fetch).
//   • Native fetch FIRST. Firecrawl is fallback ONLY (and only where enabled per-store).
//   • Hard 5s timeout per store.
//   • Success = >= 2 products, each with { name, price, url, store }.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const PER_STORE_TIMEOUT_MS = 5_000;
const FIRECRAWL_V2 = 'https://api.firecrawl.dev/v2';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua':
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

export interface Product {
  name: string;
  price: number;
  url: string;
  store: string;
}

interface StoreResult {
  store: string;
  strategy: 'native' | 'firecrawl';
  fallbackTriggered: boolean;
  success: boolean;
  latencyMs: number;
  products: Product[];
  error?: string;
}

// ---------- helpers ----------
function log(store: string, msg: string, extra?: unknown) {
  console.log(`[v5][${store}] ${msg}`, extra ?? '');
}

function parsePrice(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  // Strip currency, Arabic digits → ASCII, keep digits + dot
  const ascii = raw.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString());
  const cleaned = ascii.replace(/[^\d.,]/g, '').replace(/,/g, '');
  // Take leading number group
  const m = cleaned.match(/\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

async function nativeFetchHtml(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<{ status: number; html: string }> {
  const res = await fetch(url, {
    method: 'GET',
    signal,
    redirect: 'follow',
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
  });
  const html = await res.text();
  return { status: res.status, html };
}

// ---------- 1) AMAZON EGYPT — native HTML, Firecrawl fallback if blocked ----------
function parseAmazon(html: string, query: string): Product[] {
  const products: Product[] = [];
  const cardRe = /<div[^>]+data-component-type="s-search-result"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 20) {
    const card = m[1];
    if (/sponsored|إعلان/i.test(card)) continue;
    const titleM = card.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const linkM = card.match(/<a[^>]+class="[^"]*a-link-normal[^"]*"[^>]+href="([^"]+)"/i);
    const priceWholeM = card.match(/<span class="a-price-whole">([\d,.]+)/i);
    if (!titleM || !linkM || !priceWholeM) continue;
    const name = stripTags(titleM[1]);
    const price = parsePrice(priceWholeM[1]);
    const href = linkM[1].startsWith('http') ? linkM[1] : `https://www.amazon.eg${linkM[1]}`;
    if (!name || !price || price < 100) continue;
    products.push({ name, price, url: href, store: 'Amazon Egypt' });
  }
  return products;
}

async function firecrawlAmazonFallback(query: string, signal: AbortSignal): Promise<Product[]> {
  const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured');
  const url = `https://www.amazon.eg/s?k=${encodeURIComponent(query)}`;
  const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      formats: [{ type: 'json', prompt: 'Extract product cards as { products: [{ name, price, url }] } where price is numeric EGP. Skip sponsored.' }],
      onlyMainContent: true,
      timeout: 4000,
    }),
  });
  const data = await res.json().catch(() => null);
  const items: any[] = data?.data?.json?.products ?? data?.json?.products ?? [];
  return items
    .map((p) => ({
      name: String(p?.name ?? '').trim(),
      price: parsePrice(p?.price),
      url: String(p?.url ?? url),
      store: 'Amazon Egypt' as const,
    }))
    .filter((p) => p.name && p.price > 100);
}

async function scrapeAmazon(query: string): Promise<StoreResult> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PER_STORE_TIMEOUT_MS);
  let strategy: 'native' | 'firecrawl' = 'native';
  let fallbackTriggered = false;
  try {
    log('Amazon', 'native attempt');
    const url = `https://www.amazon.eg/s?k=${encodeURIComponent(query)}`;
    const { status, html } = await nativeFetchHtml(url, ctrl.signal);
    let products = status === 200 ? parseAmazon(html, query) : [];
    if (products.length < 2) {
      log('Amazon', `native returned ${products.length} (status ${status}) → firecrawl fallback`);
      strategy = 'firecrawl';
      fallbackTriggered = true;
      products = await firecrawlAmazonFallback(query, ctrl.signal);
    }
    return {
      store: 'Amazon Egypt', strategy, fallbackTriggered,
      success: products.length >= 2,
      latencyMs: Math.round(performance.now() - t0),
      products,
    };
  } catch (err) {
    return {
      store: 'Amazon Egypt', strategy, fallbackTriggered,
      success: false, latencyMs: Math.round(performance.now() - t0),
      products: [], error: err instanceof Error ? err.message : String(err),
    };
  } finally { clearTimeout(timer); }
}

// ---------- 2) NOON — __NEXT_DATA__ JSON, NEVER raw HTML ----------
function parseNoonNextData(html: string): Product[] {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let json: any;
  try { json = JSON.parse(m[1]); } catch { return []; }
  // Walk known catalog locations
  const candidates: any[] = [];
  const queue: any[] = [json];
  while (queue.length && candidates.length < 200) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { queue.push(...node); continue; }
    if (node.sku && (node.name || node.title) && (node.price || node.offer_price || node.sale_price)) {
      candidates.push(node);
    }
    for (const k of Object.keys(node)) queue.push(node[k]);
  }
  const seen = new Set<string>();
  return candidates
    .map((n) => {
      const name = String(n.name ?? n.title ?? '').trim();
      const priceRaw = n.sale_price ?? n.offer_price ?? n.price ?? 0;
      const price = parsePrice(typeof priceRaw === 'object' ? (priceRaw.value ?? 0) : priceRaw);
      const sku = String(n.sku ?? '');
      const url = sku ? `https://www.noon.com/egypt-en/${sku}/p/` : 'https://www.noon.com/egypt-en/';
      return { name, price, url, store: 'Noon' as const, sku };
    })
    .filter((p) => p.name && p.price > 100 && !seen.has(p.sku) && (seen.add(p.sku), true))
    .map(({ sku: _sku, ...p }) => p);
}

async function scrapeNoon(query: string): Promise<StoreResult> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PER_STORE_TIMEOUT_MS);
  try {
    log('Noon', 'native + __NEXT_DATA__');
    const url = `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(query)}`;
    const { status, html } = await nativeFetchHtml(url, ctrl.signal);
    const products = status === 200 ? parseNoonNextData(html) : [];
    return {
      store: 'Noon', strategy: 'native', fallbackTriggered: false,
      success: products.length >= 2,
      latencyMs: Math.round(performance.now() - t0),
      products,
      error: status !== 200 ? `HTTP ${status}` : undefined,
    };
  } catch (err) {
    return {
      store: 'Noon', strategy: 'native', fallbackTriggered: false,
      success: false, latencyMs: Math.round(performance.now() - t0),
      products: [], error: err instanceof Error ? err.message : String(err),
    };
  } finally { clearTimeout(timer); }
}

// ---------- 3) JUMIA — native HTML, strong selectors ----------
function parseJumia(html: string): Product[] {
  const products: Product[] = [];
  const cardRe = /<article[^>]+class="[^"]*\bprd\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 20) {
    const card = m[1];
    const linkM = card.match(/<a[^>]+class="[^"]*\bcore\b[^"]*"[^>]+href="([^"]+)"/i);
    const nameM = card.match(/<h3[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    const priceM = card.match(/<div[^>]*class="[^"]*\bprc\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!linkM || !nameM || !priceM) continue;
    const name = stripTags(nameM[1]);
    const price = parsePrice(stripTags(priceM[1]));
    if (!name || !price || price < 100) continue;
    const href = linkM[1].startsWith('http') ? linkM[1] : `https://www.jumia.com.eg${linkM[1]}`;
    products.push({ name, price, url: href, store: 'Jumia' });
  }
  return products;
}

async function scrapeJumia(query: string): Promise<StoreResult> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PER_STORE_TIMEOUT_MS);
  try {
    log('Jumia', 'native HTML parse');
    const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(query)}`;
    const { status, html } = await nativeFetchHtml(url, ctrl.signal);
    const products = status === 200 ? parseJumia(html) : [];
    return {
      store: 'Jumia', strategy: 'native', fallbackTriggered: false,
      success: products.length >= 2,
      latencyMs: Math.round(performance.now() - t0),
      products,
      error: status !== 200 ? `HTTP ${status}` : undefined,
    };
  } catch (err) {
    return {
      store: 'Jumia', strategy: 'native', fallbackTriggered: false,
      success: false, latencyMs: Math.round(performance.now() - t0),
      products: [], error: err instanceof Error ? err.message : String(err),
    };
  } finally { clearTimeout(timer); }
}

// ---------- 4) B.TECH — Next.js Server Action POST (NO GET HTML) ----------
async function scrapeBtech(query: string): Promise<StoreResult> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PER_STORE_TIMEOUT_MS);
  try {
    log('B.TECH', 'POST RSC server action');
    const res = await fetch('https://btech.com/en', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        ...BROWSER_HEADERS,
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': '40a804c5e3d2b4b1c1c1f6a3e2b1d4c5e6f7a8b9',
        Origin: 'https://btech.com',
        Referer: `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(query)}`,
      },
      body: JSON.stringify([{ search: query, page: 1, size: 20 }]),
    });
    const text = await res.text();
    const products: Product[] = [];
    // RSC stream: lines like  `0:{"items":[...]}` or `1a:{...}`
    const lineRe = /^[0-9a-f]+:(\{[\s\S]*\})\s*$/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(text)) !== null) {
      try {
        const obj = JSON.parse(lm[1]);
        const items = obj?.data?.items ?? obj?.items ?? [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const name = String(it?.name ?? it?.title ?? '').trim();
            const price = parsePrice(it?.price?.regularPrice?.amount?.value ?? it?.price ?? it?.final_price ?? 0);
            const slug = String(it?.url_key ?? it?.sku ?? '');
            const url = slug ? `https://btech.com/en/${slug}.html` : `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(query)}`;
            if (name && price > 100) products.push({ name, price, url, store: 'B.TECH' });
          }
        }
      } catch { /* skip non-JSON line */ }
      if (products.length >= 20) break;
    }
    return {
      store: 'B.TECH', strategy: 'native', fallbackTriggered: false,
      success: products.length >= 2,
      latencyMs: Math.round(performance.now() - t0),
      products,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      store: 'B.TECH', strategy: 'native', fallbackTriggered: false,
      success: false, latencyMs: Math.round(performance.now() - t0),
      products: [], error: err instanceof Error ? err.message : String(err),
    };
  } finally { clearTimeout(timer); }
}

// ---------- 5) 2B EGYPT — native HTML (Magento-style cards) ----------
function parse2B(html: string): Product[] {
  const products: Product[] = [];
  const cardRe = /<li[^>]+class="[^"]*\bproduct-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 20) {
    const card = m[1];
    const linkM = card.match(/<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const priceM = card.match(/<span[^>]+class="[^"]*price\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!linkM || !priceM) continue;
    const name = stripTags(linkM[2]);
    const price = parsePrice(stripTags(priceM[1]));
    const href = linkM[1];
    if (!name || !price || price < 100) continue;
    // Filter accessories
    if (/case|cover|cable|charger|protector|جراب|كفر|شاحن|كابل/i.test(name)) continue;
    products.push({ name, price, url: href, store: '2B Egypt' });
  }
  return products;
}

async function scrape2B(query: string): Promise<StoreResult> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PER_STORE_TIMEOUT_MS);
  try {
    log('2B', 'native HTML parse');
    const url = `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(query)}`;
    const { status, html } = await nativeFetchHtml(url, ctrl.signal);
    const products = status === 200 ? parse2B(html) : [];
    return {
      store: '2B Egypt', strategy: 'native', fallbackTriggered: false,
      success: products.length >= 2,
      latencyMs: Math.round(performance.now() - t0),
      products,
      error: status !== 200 ? `HTTP ${status}` : undefined,
    };
  } catch (err) {
    return {
      store: '2B Egypt', strategy: 'native', fallbackTriggered: false,
      success: false, latencyMs: Math.round(performance.now() - t0),
      products: [], error: err instanceof Error ? err.message : String(err),
    };
  } finally { clearTimeout(timer); }
}

// ---------- HTTP entrypoint ----------
const SCRAPERS: Record<string, (q: string) => Promise<StoreResult>> = {
  'amazon': scrapeAmazon,
  'noon': scrapeNoon,
  'jumia': scrapeJumia,
  'btech': scrapeBtech,
  '2b': scrape2B,
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body: { query?: string; stores?: string[] } = {};
  try { body = await req.json(); } catch { body = {}; }
  const query = (body.query ?? 'iPhone 13').toString();
  const stores = (body.stores ?? Object.keys(SCRAPERS)).map((s) => s.toLowerCase());

  const results = await Promise.all(
    stores.map(async (s) => {
      const fn = SCRAPERS[s];
      if (!fn) {
        return {
          store: s, strategy: 'native' as const, fallbackTriggered: false,
          success: false, latencyMs: 0, products: [], error: 'unknown store',
        };
      }
      try {
        return await withTimeout(fn(query), PER_STORE_TIMEOUT_MS + 500, s);
      } catch (err) {
        return {
          store: s, strategy: 'native' as const, fallbackTriggered: false,
          success: false, latencyMs: PER_STORE_TIMEOUT_MS + 500,
          products: [], error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const summary = {
    query,
    totalStores: results.length,
    successCount: results.filter((r) => r.success).length,
    totalProducts: results.reduce((n, r) => n + r.products.length, 0),
  };
  return new Response(JSON.stringify({ summary, results }, null, 2), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});