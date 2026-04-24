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

// ---------- Stub dispatchers (to be implemented later) ----------
async function scrapeNative(store: string, query: string): Promise<Product[]> {
  console.log(`[ROUTER] 🟢 NATIVE  ${store}  q="${query}"`);
  return [];
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