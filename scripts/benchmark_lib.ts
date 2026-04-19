// Shared benchmark helpers (extracted so we can run a parallel runner without timing out).
const SUPABASE_URL = 'https://guynfpxitlwzndninzfo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eW5mcHhpdGx3em5kbmluemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NTYyODgsImV4cCI6MjA5MTEzMjI4OH0.Dk_bhtyKQcsacePdiKtVea9jWU9C_-Tvs81smR2axGQ';

const ACCESSORY_KW = ['case','cover','protector','screen protector','tempered glass','cable','charger','adapter','holder','stand','mount','earphone','earbuds','headset','strap','band','pouch','sleeve','film','lens protector','جراب','كفر','شاحن','كابل','حامل','واقي شاشة','سكرين','حماية'];
const BRAND_MAP: Record<string,string[]> = {
  iphone:['apple','iphone','ايفون','آيفون'], apple:['apple','iphone','ipad','macbook','ايفون'],
  samsung:['samsung','galaxy','سامسونج'], galaxy:['samsung','galaxy'],
  xiaomi:['xiaomi','redmi','poco','mi '], redmi:['xiaomi','redmi'],
};
const ALL_BRANDS = ['apple','iphone','samsung','galaxy','xiaomi','redmi','oppo','huawei','honor','vivo','realme','tecno','infinix','nokia','sony'];

export function normalize(s: string): string {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/[٠-٩]/g,(d)=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[\u064B-\u0652\u0670\u0640]/g,'')
    .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function tokenize(s: string){ return normalize(s).split(/[^a-z0-9\u0600-\u06FF]+/).filter(t=>t.length>=2); }

export function relevanceScore(query: string, title: string): number {
  const q = tokenize(query); const t = new Set(tokenize(title));
  if (!q.length || !t.size) return 0;
  const qNums = q.filter(x=>/^\d+$/.test(x));
  const qWords = q.filter(x=>!/^\d+$/.test(x));
  for (const n of qNums) if (!t.has(n)) return 0;
  let hits = 0; for (const w of qWords) if (t.has(w)) hits++;
  const total = qWords.length + qNums.length;
  const overlap = total ? ((hits + qNums.length) / total) * 100 : 0;
  const nq = normalize(query); const nt = normalize(title);
  const bonus = nq && nt.includes(nq) ? 20 : 0;
  return Math.min(100, Math.round(overlap + bonus));
}

export function isInvalid(query: string, title: string): { invalid: boolean; reason?: string } {
  const t = normalize(title);
  for (const kw of ACCESSORY_KW) if (t.includes(normalize(kw))) return { invalid: true, reason: 'accessory' };
  if (/\b(sponsored|إعلان)\b/i.test(title)) return { invalid: true, reason: 'sponsored' };
  const q = normalize(query);
  let expected: string[] | null = null;
  for (const [kw, brands] of Object.entries(BRAND_MAP)) if (q.includes(kw)) { expected = brands.map(normalize); break; }
  if (expected) {
    const matches = expected.some(b => t.includes(b));
    if (!matches) {
      const other = ALL_BRANDS.map(normalize).some(b => t.includes(b));
      if (other) return { invalid: true, reason: 'wrong-brand' };
    }
  }
  return { invalid: false };
}

export interface RunResult { latencyMs: number; items: number; cached: boolean; usedFallback: boolean; products: Array<{name:string;price:number}>; error?: string; }
export async function runOnce(query: string, store: string): Promise<RunResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/scrape-prices`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${SUPABASE_ANON_KEY}`, 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ query, store, force_refresh: true }),
    });
    const ms = Math.round(performance.now() - t0);
    const data = await res.json();
    return { latencyMs: ms, items: Array.isArray(data?.products) ? data.products.length : 0,
      cached: !!data?.cached, usedFallback: !!data?.usedFallback,
      products: (data?.products ?? []).map((p: any)=>({ name: p.name ?? '', price: p.price ?? 0 })),
      error: data?.error };
  } catch (err) {
    return { latencyMs: Math.round(performance.now()-t0), items: 0, cached: false, usedFallback: false, products: [], error: err instanceof Error ? err.message : String(err) };
  }
}
