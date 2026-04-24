// Isolated hybrid benchmark V4 — compares Native Fetch vs Firecrawl for grouped stores.
// DOES NOT touch production scrape-prices or STORE_CONFIGS.
// Accepts { group: "A" | "B" | "C", query?: string } and returns a Markdown table.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const NATIVE_TIMEOUT_MS = 6_000;
const FIRECRAWL_TIMEOUT_MS = 12_000;
const FIRECRAWL_V2 = 'https://api.firecrawl.dev/v2';

type StoreDef = { name: string; url: (q: string) => string };

const GROUPS: Record<string, StoreDef[]> = {
  A: [
    { name: 'Amazon Egypt', url: (q) => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}` },
    { name: 'Noon', url: (q) => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}` },
    { name: 'Jumia', url: (q) => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}` },
    { name: 'B.TECH', url: (q) => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}` },
    { name: '2B Egypt', url: (q) => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}` },
  ],
  B: [
    { name: 'Raya Shop', url: (q) => `https://rayashop.com/catalogsearch/result/?q=${encodeURIComponent(q)}` },
    { name: 'Dream 2000', url: (q) => `https://dream2000.com/catalogsearch/result/?q=${encodeURIComponent(q)}` },
    { name: 'Mobile Shop', url: (q) => `https://mobileshop.com.eg/?s=${encodeURIComponent(q)}` },
    { name: 'Cairo Sales', url: (q) => `https://cairosales.com/?s=${encodeURIComponent(q)}` },
    { name: 'Tradeline', url: (q) => `https://tradelinestores.com/search?q=${encodeURIComponent(q)}` },
  ],
  C: [
    { name: 'Dubai Phone', url: (q) => `https://dubaiphone.net/search?q=${encodeURIComponent(q)}` },
    { name: 'Select', url: (q) => `https://select.eg/search?q=${encodeURIComponent(q)}` },
    { name: 'El Shennawy', url: (q) => `https://elshennawy.com/search?q=${encodeURIComponent(q)}` },
    { name: 'Rizkalla', url: (q) => `https://rizkallaco.com/search?q=${encodeURIComponent(q)}` },
    { name: 'Carrefour Egypt', url: (q) => `https://www.carrefouregypt.com/mafegy/en/search?keyword=${encodeURIComponent(q)}` },
  ],
};

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
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

interface MethodResult {
  status: string;
  latencyMs: number;
  success: boolean;
  detail?: string;
}

interface RowResult {
  store: string;
  native: MethodResult;
  firecrawl: MethodResult;
}

function detectNativeSuccess(status: number, html: string): boolean {
  if (status !== 200) return false;
  if (!html || html.length < 5000) return false;
  const lower = html.toLowerCase();
  const blockSignals = [
    'attention required',
    'just a moment',
    'access denied',
    'enable javascript and cookies',
    'captcha',
  ];
  if (blockSignals.some((s) => lower.includes(s))) return false;
  // Heuristic: look for price tokens or product-link patterns
  const priceHit = /(?:EGP|ج\.?م|E£|£E|LE)\s?[\d,.]{2,}/i.test(html);
  const productHit = /\b(product|item|sku|add to cart|add-to-cart)\b/i.test(html);
  return priceHit || productHit;
}

async function nativeFetch(url: string): Promise<MethodResult> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), NATIVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: BROWSER_HEADERS,
    });
    const html = await res.text();
    const latencyMs = Math.round(performance.now() - t0);
    const success = detectNativeSuccess(res.status, html);
    return { status: String(res.status), latencyMs, success };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') ||
      String(err).includes('timeout');
    return {
      status: isAbort ? 'TIMEOUT' : 'ERROR',
      latencyMs,
      success: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function firecrawlScrape(apiKey: string, url: string): Promise<MethodResult> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FIRECRAWL_TIMEOUT_MS);
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
        timeout: FIRECRAWL_TIMEOUT_MS - 1000,
      }),
    });
    const latencyMs = Math.round(performance.now() - t0);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        status: `HTTP ${res.status}`,
        latencyMs,
        success: false,
        detail: data?.error ?? res.statusText,
      };
    }
    const md: string = (data && (data.markdown || data?.data?.markdown)) || '';
    const priceMatches = md.match(/(?:EGP|ج\.?م|E£|£E|LE)\s?[\d,.]{2,}/gi) ?? [];
    const success = priceMatches.length >= 2;
    return { status: '200', latencyMs, success };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') ||
      String(err).includes('timeout');
    return {
      status: isAbort ? 'TIMEOUT' : 'ERROR',
      latencyMs,
      success: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function verdict(n: MethodResult, f: MethodResult): string {
  if (n.success && f.success) return '🥇 Native (free + works)';
  if (n.success && !f.success) return '🥇 Native only';
  if (!n.success && f.success) return '🔥 Firecrawl only';
  return '❌ Both failed';
}

function renderMarkdown(group: string, query: string, rows: RowResult[]): string {
  const header =
    '| Store | Native Status | Native Latency (ms) | Firecrawl Status | Firecrawl Latency (ms) | Verdict |\n' +
    '|-------|---------------|---------------------|------------------|------------------------|---------|';
  const body = rows
    .map((r) => {
      const ns = `${r.native.status}${r.native.success ? ' ✅' : ''}`;
      const fs = `${r.firecrawl.status}${r.firecrawl.success ? ' ✅' : ''}`;
      return `| ${r.store} | ${ns} | ${r.native.latencyMs} | ${fs} | ${r.firecrawl.latencyMs} | ${verdict(r.native, r.firecrawl)} |`;
    })
    .join('\n');

  const total = rows.length;
  const nativeOk = rows.filter((r) => r.native.success).length;
  const fcOk = rows.filter((r) => r.firecrawl.success).length;
  const summary =
    `\n\n### Summary — Group ${group}\n` +
    `- Query: \`${query}\`\n` +
    `- Stores tested: ${total}\n` +
    `- ✅ Native success: ${nativeOk}/${total}\n` +
    `- 🔥 Firecrawl success: ${fcOk}/${total}\n`;

  return `# Hybrid Benchmark V4 — Group ${group}\n\n${header}\n${body}${summary}`;
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

  let body: { group?: string; query?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const group = (body.group ?? 'A').toUpperCase();
  const query = body.query ?? 'iPhone 13';
  const stores = GROUPS[group];
  if (!stores) {
    return new Response(`Unknown group: ${group}. Use A, B, or C.`, {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const rows: RowResult[] = await Promise.all(
    stores.map(async (s) => {
      const url = s.url(query);
      const [native, firecrawl] = await Promise.all([
        nativeFetch(url),
        firecrawlScrape(apiKey, url),
      ]);
      return { store: s.name, native, firecrawl };
    }),
  );

  const markdown = renderMarkdown(group, query, rows);
  return new Response(markdown, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
  });
});