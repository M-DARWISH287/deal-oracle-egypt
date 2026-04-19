import { supabase } from '@/integrations/supabase/client';

// ── BIG 5 ARCHITECTURE ──
// Strategic pivot: focus exclusively on the 5 most reliable Egyptian stores.
// All 5 are searched on every query (no smart routing / no Apple specialists).
export const ALL_STORES = [
  'Amazon Egypt', 'Noon', 'B.TECH', 'Jumia', '2B Egypt',
] as const;

export type StoreName = typeof ALL_STORES[number];

/** Big 5: every query hits all 5 stores. */
export function getRelevantStores(_query: string): StoreName[] {
  return [...ALL_STORES];
}

export interface RawProduct {
  name: string; name_ar?: string; price: number;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
  confidenceScore?: number;
}

export interface StoreOffer { store: string; price: number; url: string; currency: string; }

export interface Product {
  id: string;
  name: { ar: string; en: string };
  specs: { ar: string; en: string };
  image: string; category: string;
  offers: StoreOffer[];
  isRefurbished?: boolean; isVariant?: boolean;
  confidenceScore?: number;
}

export interface StoreSearchResult {
  success: boolean; products: RawProduct[]; cached: boolean;
  store: string; cachedAt?: string; error?: string;
}

// ── localStorage Cache (Layer 1) ──
const LOCAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface LocalCacheEntry {
  products: RawProduct[];
  timestamp: number;
  store: string;
}

function getLocalCacheKey(query: string, store: string): string {
  return `bd_cache:${store}:${query.trim().toLowerCase()}`;
}

function getLocalCache(query: string, store: string): RawProduct[] | null {
  try {
    const raw = localStorage.getItem(getLocalCacheKey(query, store));
    if (!raw) return null;
    const entry: LocalCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > LOCAL_CACHE_TTL_MS) {
      localStorage.removeItem(getLocalCacheKey(query, store));
      return null;
    }
    return entry.products;
  } catch { return null; }
}

function setLocalCache(query: string, store: string, products: RawProduct[]) {
  if (products.length === 0) return; // never cache empty
  try {
    const entry: LocalCacheEntry = { products, timestamp: Date.now(), store };
    localStorage.setItem(getLocalCacheKey(query, store), JSON.stringify(entry));
  } catch { /* quota exceeded — ignore */ }
}

export async function searchStore(
  query: string,
  store: string,
  forceRefresh = false,
): Promise<StoreSearchResult> {
  // Layer 1: check localStorage first (skipped on force refresh)
  if (!forceRefresh) {
    const localCached = getLocalCache(query, store);
    if (localCached) {
      return { success: true, products: localCached, cached: true, store, cachedAt: 'local' };
    }
  } else {
    try { localStorage.removeItem(getLocalCacheKey(query, store)); } catch { /* ignore */ }
  }

  try {
    const { data, error } = await supabase.functions.invoke('scrape-prices', {
      body: { query, store, force_refresh: forceRefresh },
    });
    if (error) {
      console.error(`[${store}] Error:`, error);
      return { success: false, products: [], cached: false, store, error: error.message };
    }
    const result = data as StoreSearchResult;
    if (result.success && result.products.length > 0) {
      setLocalCache(query, store, result.products);
    }
    return result;
  } catch (err) {
    return { success: false, products: [], cached: false, store, error: String(err) };
  }
}

// ── BIG 5 whitelisted domains ──
const WHITELISTED_DOMAINS = [
  'amazon.eg', 'noon.com', 'jumia.com.eg', 'btech.com', '2b.com.eg',
];

const BRAND_EXCLUSIONS: Record<string, string[]> = {
  iphone: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'realme', 'huawei', 'honor', 'vivo', 'tecno', 'infinix', 'nokia'],
  apple: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'huawei', 'honor', 'vivo'],
  ipad: ['samsung', 'galaxy', 'tab ', 'lenovo', 'huawei'],
  macbook: ['samsung', 'lenovo', 'hp ', 'dell', 'asus', 'acer'],
  samsung: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo', 'huawei'],
  galaxy: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo'],
  xiaomi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  redmi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  oppo: ['iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi'],
  huawei: ['iphone', 'samsung', 'galaxy', 'xiaomi'],
};

const ACCESSORY_KEYWORDS_CLIENT = [
  'case', 'cover', 'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder', 'stand', 'mount',
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة', 'سكرين', 'حماية',
  'earphone', 'earbuds', 'headset', 'strap', 'band', 'pouch', 'sleeve',
  'film', 'lens protector', 'camera protector',
];

// ── GLOBAL RELEVANCE VALIDATOR (client mirror of the edge-function rules) ──
// Generic, brand-agnostic. Strict numeric matching, ≥60% non-numeric token overlap.
function normalizeForRelevance(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeForRelevance(s: string): string[] {
  return normalizeForRelevance(s)
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter(t => t.length >= 2);
}

export interface RelevanceResult {
  isRelevant: boolean;
  score: number;
}

export function validateRelevance(query: string, title: string): RelevanceResult {
  const qTokens = tokenizeForRelevance(query);
  const tTokens = tokenizeForRelevance(title);
  if (qTokens.length === 0 || tTokens.length === 0) return { isRelevant: false, score: 0 };
  const tSet = new Set(tTokens);
  const qNumbers = qTokens.filter(t => /^\d+$/.test(t));
  const qWords = qTokens.filter(t => !/^\d+$/.test(t));
  // Strict numeric: instant fail if any query number missing.
  for (const n of qNumbers) if (!tSet.has(n)) return { isRelevant: false, score: 0 };
  let hits = 0;
  for (const w of qWords) if (tSet.has(w)) hits++;
  const totalHits = hits + qNumbers.length;
  const totalQ = qWords.length + qNumbers.length;
  const overlapPct = totalQ > 0 ? (totalHits / totalQ) * 100 : 0;
  const normQ = normalizeForRelevance(query).trim();
  const normT = normalizeForRelevance(title);
  const substringBonus = normQ.length > 0 && normT.includes(normQ) ? 20 : 0;
  const score = Math.min(100, Math.round(overlapPct + substringBonus));
  let isRelevant: boolean;
  if (qWords.length === 0) {
    isRelevant = qNumbers.length > 0;
  } else {
    const required = Math.max(1, Math.ceil(qWords.length * 0.6));
    isRelevant = hits >= required;
  }
  return { isRelevant, score };
}

export function clientFilterWithFallback(
  products: Product[], query: string
): { strict: Product[]; relaxed: Product[] } {
  const q = query.toLowerCase();
  const variants = ['pro', 'max', 'plus', 'ultra'] as const;
  const queryNumbers = q.match(/\d+/g) || [];
  const strict: Product[] = [];
  const relaxed: Product[] = [];

  for (const p of products) {
    const clone = deepCloneProduct(p);
    const bestPrice = Math.min(...clone.offers.map(o => o.price));
    if (bestPrice < 1500) continue;

    const nameLower = (clone.name.en + ' ' + clone.name.ar).toLowerCase();

    // Drop accessories
    if (ACCESSORY_KEYWORDS_CLIENT.some(kw => nameLower.includes(kw))) continue;

    // GLOBAL RELEVANCE GATE — reject anything whose title doesn't match the query.
    const titleForRelevance = `${clone.name.en} ${clone.name.ar}`;
    if (!validateRelevance(query, titleForRelevance)) continue;

    // Strict brand matching: drop cross-brand pollution
    let brandMismatch = false;
    for (const [brandKw, excluded] of Object.entries(BRAND_EXCLUSIONS)) {
      if (q.includes(brandKw) && excluded.some(bad => nameLower.includes(bad))) {
        brandMismatch = true; break;
      }
    }
    if (brandMismatch) continue;

    clone.offers = clone.offers.filter(o => {
      try {
        const hostname = new URL(o.url).hostname;
        return WHITELISTED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
      } catch { return false; }
    });
    if (clone.offers.length === 0) continue;

    const name = clone.name.en.toLowerCase();
    if (['restored', 'renewed', 'refurbished', 'مجدد'].some(w => name.includes(w) || clone.name.ar.includes(w))) {
      clone.isRefurbished = true;
    }

    const seen = new Set<string>();
    clone.offers = clone.offers.filter(o => {
      const key = `${o.store}|${o.price}|${o.url}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    let passesIntent = true;
    for (const v of variants) {
      if (!q.includes(v) && name.includes(v)) { passesIntent = false; break; }
    }
    if (passesIntent && queryNumbers.length > 0) {
      const nameNumbers: string[] = name.match(/\d+/g) || [];
      for (const qn of queryNumbers) {
        if (!nameNumbers.includes(qn)) { passesIntent = false; break; }
      }
    }

    if (passesIntent) { strict.push(clone); }
    else { clone.isVariant = true; relaxed.push(clone); }
  }
  return { strict, relaxed };
}

export function clientFilter(products: Product[], query: string): Product[] {
  return clientFilterWithFallback(products, query).strict;
}

function deepCloneProduct(p: Product): Product {
  return { ...p, name: { ...p.name }, specs: { ...p.specs }, offers: p.offers.map(o => ({ ...o })) };
}

export function groupProducts(allProducts: RawProduct[]): Product[] {
  const grouped = new Map<string, Product>();
  for (const p of allProducts) {
    if (!p.price || p.price <= 0) continue;
    const normalizedName = (p.name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    let matched = false;
    for (const [key, group] of grouped) {
      if (normalizedName.includes(key.slice(0, 25)) || key.includes(normalizedName.slice(0, 25))) {
        if (!group.offers.some(o => o.store === p.store && o.url === p.url)) {
          group.offers.push({ store: p.store, price: p.price, url: p.url, currency: 'EGP' });
        }
        if (p.image && !group.image) group.image = p.image;
        matched = true; break;
      }
    }
    if (!matched) {
      grouped.set(normalizedName, {
        id: crypto.randomUUID(),
        name: { en: p.name || '', ar: p.name_ar || p.name || '' },
        specs: { en: p.specs || '', ar: p.specs || '' },
        image: p.image || '', category: 'electronics',
        offers: [{ store: p.store, price: p.price, url: p.url, currency: 'EGP' }],
        isRefurbished: p.isRefurbished || false,
      });
    }
  }
  return Array.from(grouped.values())
    .map(p => { p.offers.sort((a, b) => a.price - b.price); return p; })
    .sort((a, b) => {
      if (b.offers.length !== a.offers.length) return b.offers.length - a.offers.length;
      return a.offers[0].price - b.offers[0].price;
    }).slice(0, 30);
}
