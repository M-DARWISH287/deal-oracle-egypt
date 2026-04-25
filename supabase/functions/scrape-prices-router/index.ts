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

const ROUTING_MATRIX: Record<string, StoreStrategy> = {
  // Tier 1 & 2 — Native fetch viable
  'Raya Shop':       'NATIVE',
  'Tradeline':       'NATIVE',
  'Carrefour Egypt': 'NATIVE',
  'El Shennawy':     'NATIVE',

  // Tier 3 — Firecrawl required (WAF / SPA shell)
  'Amazon Egypt': 'FIRECRAWL',
  'Jumia':        'FIRECRAWL',
  '2B Egypt':     'FIRECRAWL',
  'Cairo Sales':  'FIRECRAWL',

  // Tier 4 & 5 — Dropped or pending fix
  'Dream 2000':  'SKIP',
  'Dubai Phone': 'SKIP',
  'Noon':        'SKIP',
  'B.TECH':      'SKIP',
};

const GLOBAL_TIMEOUT_MS = 8_000;

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

// ---------- Per-store parsers ----------

// Raya Shop — Magento 2 (.product-item-link, .price)
function parseRayaShop(html: string): Product[] {
  const products: Product[] = [];
  const cardRe =
    /<li[^>]+class="[^"]*\bproduct-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 25) {
    const card = m[1];
    const linkM = card.match(
      /<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const priceM =
      card.match(/<span[^>]+data-price-amount="([\d.]+)"/i) ??
      card.match(/<span[^>]+class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!linkM || !priceM) continue;
    const name = stripTags(linkM[2]);
    const price = cleanPrice(priceM[1]);
    const url = absolutize(linkM[1], 'https://rayashop.com');
    products.push({ name, price, url, store: 'Raya Shop' });
  }
  return products;
}

// Tradeline — Shopify (a.product-card / h3 / .price)
function parseTradeline(html: string): Product[] {
  const products: Product[] = [];
  // Shopify product cards typically wrap each item in a div/li with a product link to /products/<handle>
  const cardRe =
    /<a[^>]+href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1500}?)(?:<\/li>|<\/div>\s*<\/div>)/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 25) {
    const href = m[1];
    const titleBlock = m[2];
    const after = m[3];
    const titleText = stripTags(titleBlock);
    if (!titleText || titleText.length < 4) continue;
    const priceM =
      after.match(/<span[^>]+class="[^"]*\bprice[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      after.match(/data-product-price[^>]*>([\s\S]*?)</i) ??
      after.match(/EGP[\s\S]{0,40}?([\d.,]+)/i) ??
      after.match(/([\d.,]+)\s*(?:EGP|LE)/i);
    if (!priceM) continue;
    const price = cleanPrice(priceM[1]);
    const url = absolutize(href, 'https://tradelinestores.com');
    products.push({ name: titleText, price, url, store: 'Tradeline' });
  }
  return products;
}

// Carrefour Egypt — Next.js, products embedded in __NEXT_DATA__
function parseCarrefour(html: string): Product[] {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let json: unknown;
  try { json = JSON.parse(m[1]); } catch { return []; }
  const out: Product[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [json];
  while (queue.length && out.length < 25) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { queue.push(...node); continue; }
    const n = node as Record<string, unknown>;
    const name = (n.name ?? n.title) as string | undefined;
    const priceObj = (n.price ?? n.prices) as Record<string, unknown> | number | undefined;
    const link = (n.url ?? n.link) as string | undefined;
    if (typeof name === 'string' && (priceObj !== undefined) && typeof link === 'string') {
      let price = 0;
      if (typeof priceObj === 'number') price = Math.round(priceObj);
      else if (typeof priceObj === 'object' && priceObj) {
        const pv = (priceObj as Record<string, unknown>).price ?? (priceObj as Record<string, unknown>).value;
        price = cleanPrice(String(pv ?? ''));
      }
      const url = absolutize(link, 'https://www.carrefouregypt.com');
      if (name && price && !seen.has(url)) {
        seen.add(url);
        out.push({ name: name.trim(), price, url, store: 'Carrefour Egypt' });
      }
    }
    for (const k of Object.keys(n)) queue.push(n[k]);
  }
  return out;
}

// El Shennawy — Shopify variant
function parseElShennawy(html: string): Product[] {
  const products: Product[] = [];
  const cardRe =
    /<a[^>]+href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1500}?)(?:<\/li>|<\/div>\s*<\/div>)/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && products.length < 25) {
    const href = m[1];
    const name = stripTags(m[2]);
    const after = m[3];
    if (!name || name.length < 4) continue;
    const priceM =
      after.match(/<span[^>]+class="[^"]*\bprice[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      after.match(/EGP[\s\S]{0,40}?([\d.,]+)/i) ??
      after.match(/([\d.,]+)\s*(?:EGP|LE)/i);
    if (!priceM) continue;
    const price = cleanPrice(priceM[1]);
    const url = absolutize(href, 'https://elshennawy.com');
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
      case 'Raya Shop': {
        const html = await fetchHtml(`https://rayashop.com/en/catalogsearch/result/?q=${q}`);
        return html ? finalize(parseRayaShop(html)) : [];
      }
      case 'Tradeline': {
        const html = await fetchHtml(`https://tradelinestores.com/search?q=${q}`);
        return html ? finalize(parseTradeline(html)) : [];
      }
      case 'Carrefour Egypt': {
        const html = await fetchHtml(
          `https://www.carrefouregypt.com/mafegy/en/search?keyword=${q}`,
        );
        return html ? finalize(parseCarrefour(html)) : [];
      }
      case 'El Shennawy': {
        const html = await fetchHtml(`https://elshennawy.com/search?q=${q}`);
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

async function scrapeFirecrawl(store: string, query: string): Promise<Product[]> {
  console.log(`[ROUTER] 🔥 FIRECRAWL ${store}  q="${query}"`);
  return [];
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

    type Task = { store: string; strategy: StoreStrategy; promise: Promise<Product[]> };
    const tasks: Task[] = [];

    for (const [store, strategy] of Object.entries(ROUTING_MATRIX)) {
      if (strategy === 'SKIP') {
        console.log(`[ROUTER] 🚫 SKIP    ${store}`);
        continue;
      }
      const fn = strategy === 'NATIVE' ? scrapeNative : scrapeFirecrawl;
      tasks.push({
        store,
        strategy,
        promise: withTimeout(fn(store, query), GLOBAL_TIMEOUT_MS, store),
      });
    }

    const settled = await Promise.allSettled(tasks.map((t) => t.promise));

    const allProducts: Product[] = [];
    const perStore = settled.map((res, i) => {
      const { store, strategy } = tasks[i];
      if (res.status === 'fulfilled') {
        allProducts.push(...res.value);
        return { store, strategy, status: 'ok', count: res.value.length };
      }
      const error = res.reason instanceof Error ? res.reason.message : String(res.reason);
      console.error(`[ROUTER] ❌ ${store}: ${error}`);
      return { store, strategy, status: 'error', count: 0, error };
    });

    allProducts.sort((a, b) => a.price - b.price);

    return new Response(
      JSON.stringify({
        success: true,
        query,
        count: allProducts.length,
        perStore,
        products: allProducts,
      }, null, 2),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});