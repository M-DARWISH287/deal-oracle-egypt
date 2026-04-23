// Isolated Firecrawl benchmark — DOES NOT touch production scrape-prices.
// Runs 5 queries × 5 stores = 25 cells, 1 request each, 10s hard cap.
// Returns a raw Markdown table as text/plain for easy copy/paste.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const QUERIES = [
  'iPhone 14',
  'iPhone 15 Pro Max',
  'Samsung S24 Ultra',
  'MacBook Air M2',
  'Poco X6 Pro',
];

const STORES: Record<string, { domain: string; searchUrl: (q: string) => string }> = {
  Amazon: {
    domain: 'amazon.eg',
    searchUrl: (q) => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}`,
  },
  Noon: {
    domain: 'noon.com',
    searchUrl: (q) => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`,
  },
  Jumia: {
    domain: 'jumia.com.eg',
    searchUrl: (q) => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`,
  },
  'B.TECH': {
    domain: 'btech.com',
    searchUrl: (q) => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  },
  '2B': {
    domain: '2b.com.eg',
    searchUrl: (q) => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  },
};

const HARD_TIMEOUT_MS = 10_000;
const FIRECRAWL_V2 = 'https://api.firecrawl.dev/v2';

interface CellResult {
  query: string;
  store: string;
  items: number;
  latencyMs: number;
  status: 'Success' | 'Error' | 'Timeout';
  detail?: string;
}

/**
 * Count product items in markdown returned by Firecrawl.
 * Heuristic: count price tokens (EGP / ج.م / £E / E£ / "EGP" near digits).
 * Also count product-link patterns. Take the smaller signal to reduce noise.
 */
function countItemsFromMarkdown(md: string): number {
  if (!md) return 0;
  const priceRegex = /(?:EGP|ج\.?م|E£|£E|LE)\s?[\d,.]{2,}/gi;
  const priceMatches = md.match(priceRegex) ?? [];
  // de-dupe identical price tokens that appear in headers
  const uniquePrices = new Set(priceMatches.map((s) => s.trim().toLowerCase()));
  return uniquePrices.size;
}

async function scrapeOne(
  apiKey: string,
  query: string,
  storeName: string,
): Promise<CellResult> {
  const cfg = STORES[storeName];
  const url = cfg.searchUrl(query);
  const started = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), HARD_TIMEOUT_MS);

  try {
    const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        // No scrolling, no waitFor loops — single-shot per skill best practices.
        timeout: HARD_TIMEOUT_MS,
      }),
    });

    const latencyMs = Math.round(performance.now() - started);
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        query,
        store: storeName,
        items: 0,
        latencyMs,
        status: 'Error',
        detail: `HTTP ${res.status}`,
      };
    }

    const md: string =
      (data && (data.markdown || data?.data?.markdown)) || '';
    const items = countItemsFromMarkdown(md);

    return {
      query,
      store: storeName,
      items,
      latencyMs,
      status: 'Success',
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') ||
      String(err).includes('timeout');
    return {
      query,
      store: storeName,
      items: 0,
      latencyMs,
      status: isAbort ? 'Timeout' : 'Error',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderMarkdown(rows: CellResult[]): string {
  const header =
    '| Query | Store | Items Found | Latency (ms) | Status |\n' +
    '|-------|-------|-------------|--------------|--------|';
  const body = rows
    .map(
      (r) =>
        `| ${r.query} | ${r.store} | ${r.items} | ${r.latencyMs} | ${r.status}${
          r.detail ? ` (${r.detail})` : ''
        } |`,
    )
    .join('\n');

  // Summary
  const total = rows.length;
  const ok = rows.filter((r) => r.status === 'Success').length;
  const to = rows.filter((r) => r.status === 'Timeout').length;
  const err = rows.filter((r) => r.status === 'Error').length;
  const avgLat = Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / total);
  const successWithItems = rows.filter(
    (r) => r.status === 'Success' && r.items > 0,
  ).length;

  const summary =
    `\n\n### Summary\n` +
    `- Total cells: ${total}\n` +
    `- ✅ Success: ${ok} (with items: ${successWithItems})\n` +
    `- ⏱ Timeout: ${to}\n` +
    `- ❌ Error: ${err}\n` +
    `- Avg latency: ${avgLat}ms\n`;

  return `# Firecrawl Benchmark — 5 queries × 5 stores\n\n${header}\n${body}${summary}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) {
    return new Response('FIRECRAWL_API_KEY is not configured', {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Build full 25-cell matrix
  const cells: Array<{ query: string; store: string }> = [];
  for (const q of QUERIES) {
    for (const s of Object.keys(STORES)) {
      cells.push({ query: q, store: s });
    }
  }

  // Run in parallel — each cell independently capped at 10s.
  const results = await Promise.all(
    cells.map((c) => scrapeOne(apiKey, c.query, c.store)),
  );

  const markdown = renderMarkdown(results);

  return new Response(markdown, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});
