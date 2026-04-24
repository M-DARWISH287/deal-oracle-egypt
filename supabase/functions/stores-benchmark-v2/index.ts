// Isolated discovery benchmark — tests 4 mobile-centric stores via native fetch.
// DOES NOT touch production scrape-prices or STORE_CONFIGS.
// Returns a raw Markdown table as text/plain.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const QUERY = 'iPhone 13';
const HARD_TIMEOUT_MS = 5_000;

const STORES: Record<string, (q: string) => string> = {
  'Raya Shop': (q) =>
    `https://www.rayashop.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  'Dream 2000': (q) =>
    `https://dream2000.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  'Mobile Shop': (q) =>
    `https://mobileshop.eu.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  'Cairo Sales': (q) =>
    `https://www.cairosales.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
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

interface CellResult {
  store: string;
  status: string;
  latencyMs: number;
  htmlLength: number;
  blocked: 'Yes' | 'No';
  detail?: string;
}

function detectBlock(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html) return false;
  const lower = html.toLowerCase();
  const signals = [
    'cloudflare',
    'cf-ray',
    'attention required',
    'just a moment',
    'access denied',
    'akamai',
    'incapsula',
    'imperva',
    'captcha',
    'enable javascript and cookies to continue',
  ];
  // Short HTML on a search page is also a strong block/challenge signal.
  const tooShort = html.length < 1500;
  const hasSignal = signals.some((s) => lower.includes(s));
  return hasSignal || (tooShort && status !== 404);
}

async function probeStore(
  storeName: string,
  url: string,
): Promise<CellResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort('timeout'),
    HARD_TIMEOUT_MS,
  );

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: BROWSER_HEADERS,
    });
    const html = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    const blocked = detectBlock(res.status, html);
    return {
      store: storeName,
      status: String(res.status),
      latencyMs,
      htmlLength: html.length,
      blocked: blocked ? 'Yes' : 'No',
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') ||
      String(err).includes('timeout');
    return {
      store: storeName,
      status: isAbort ? 'TIMEOUT' : 'ERROR',
      latencyMs,
      htmlLength: 0,
      blocked: 'Yes',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderMarkdown(rows: CellResult[]): string {
  const header =
    '| Store | HTTP Status | Latency (ms) | HTML Length | Detected Block |\n' +
    '|-------|-------------|--------------|-------------|----------------|';
  const body = rows
    .map(
      (r) =>
        `| ${r.store} | ${r.status}${r.detail ? ` (${r.detail})` : ''} | ${r.latencyMs} | ${r.htmlLength} | ${r.blocked} |`,
    )
    .join('\n');

  const total = rows.length;
  const usable = rows.filter(
    (r) => r.status === '200' && r.blocked === 'No',
  ).length;
  const blocked = rows.filter((r) => r.blocked === 'Yes').length;
  const avgLat = Math.round(
    rows.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, total),
  );

  const summary =
    `\n\n### Summary\n` +
    `- Query: \`${QUERY}\`\n` +
    `- Total stores: ${total}\n` +
    `- ✅ Usable (200 OK, not blocked): ${usable}\n` +
    `- 🚫 Blocked / Challenge: ${blocked}\n` +
    `- Avg latency: ${avgLat}ms\n`;

  return `# Stores Benchmark V2 — Native Fetch Discovery\n\nQuery: **${QUERY}**\n\n${header}\n${body}${summary}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const entries = Object.entries(STORES);
  const results = await Promise.all(
    entries.map(([name, build]) => probeStore(name, build(QUERY))),
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