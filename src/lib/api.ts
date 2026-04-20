import { supabase } from '@/integrations/supabase/client';
import { canonicalizeQuery, routeStores } from '@/lib/semantic';

// ── BIG 5 ARCHITECTURE + PHASE 4 SMART ROUTER ──
// All 5 stores remain in the catalog. The Smart Store Router (semantic layer)
// picks the top-N most relevant stores per query so we stop broadcasting blindly.
export const ALL_STORES = [
  'Amazon Egypt', 'Noon', 'B.TECH', 'Jumia', '2B Egypt',
] as const;

export type StoreName = typeof ALL_STORES[number];

/**
 * Phase 4: returns the top-N stores by semantic affinity for the query.
 * Low-confidence intent → full broadcast (preserves coverage). Default top-N = 3.
 */
export function getRelevantStores(query: string, topN = 3): StoreName[] {
  const intent = canonicalizeQuery(query || '');
  const { selected } = routeStores(intent, ALL_STORES, topN);
  return selected as StoreName[];
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
    const rel = validateRelevance(query, titleForRelevance);
    if (!rel.isRelevant) continue;
    // Take the higher of server-attached score vs client-recomputed score.
    if (rel.score > (clone.confidenceScore ?? 0)) clone.confidenceScore = rel.score;

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

// ── Title normalization for strict product grouping ──
// Extracts brand + model + storage from a raw title so that offers from
// different stores collapse into ONE group only when they describe the
// exact same SKU (same model + same storage). Color is intentionally ignored.
const BRAND_PATTERNS: Array<{ re: RegExp; brand: string }> = [
  { re: /\bapple\b|\biphone\b|\bipad\b|\bmacbook\b|\bairpods?\b/i, brand: 'apple' },
  { re: /\bsamsung\b|\bgalaxy\b/i, brand: 'samsung' },
  { re: /\bxiaomi\b|\bredmi\b|\bpoco\b/i, brand: 'xiaomi' },
  { re: /\bhuawei\b|\bhonor\b/i, brand: 'huawei' },
  { re: /\boppo\b/i, brand: 'oppo' },
  { re: /\bvivo\b/i, brand: 'vivo' },
  { re: /\brealme\b/i, brand: 'realme' },
  { re: /\binfinix\b/i, brand: 'infinix' },
  { re: /\btecno\b/i, brand: 'tecno' },
  { re: /\bsony\b|\bplaystation\b|\bps5\b|\bps4\b/i, brand: 'sony' },
  { re: /\bmicrosoft\b|\bxbox\b|\bsurface\b/i, brand: 'microsoft' },
  { re: /\bnintendo\b|\bswitch\b/i, brand: 'nintendo' },
  { re: /\bdell\b/i, brand: 'dell' },
  { re: /\bhp\b|\bhewlett\b/i, brand: 'hp' },
  { re: /\blenovo\b|\bthinkpad\b/i, brand: 'lenovo' },
  { re: /\basus\b|\brog\b/i, brand: 'asus' },
  { re: /\bacer\b/i, brand: 'acer' },
  { re: /\blg\b/i, brand: 'lg' },
];

interface NormalizedTitle {
  brand: string;        // e.g. "apple" or "" if unknown
  model: string;        // e.g. "iphone 15 pro" or first 2-4 distinguishing tokens
  storage: string;      // e.g. "128gb" or "" if missing
  raw: string;          // lowercased cleaned title (for fallback comparisons)
}

function normalizeTitle(title: string): NormalizedTitle {
  const raw = (title || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // Brand
  let brand = '';
  for (const { re, brand: b } of BRAND_PATTERNS) {
    if (re.test(raw)) { brand = b; break; }
  }

  // Storage — only count units that match real storage tiers, ignore RAM-only tokens.
  // Match "128 gb", "128gb", "1 tb", "1tb"; skip values < 16gb (likely RAM).
  let storage = '';
  const storageMatches = Array.from(raw.matchAll(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/g));
  // Prefer the LARGEST storage-looking value (RAM is usually 4/6/8/12/16; storage is 64/128/256/512/1024).
  let bestVal = 0;
  for (const m of storageMatches) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    const gb = unit === 'tb' ? n * 1024 : n;
    if (gb >= 32 && gb > bestVal) {
      bestVal = gb;
      storage = unit === 'tb' ? `${n}tb` : `${Math.round(n)}gb`;
    }
  }

  // Model: strip brand + storage + common noise, then keep first ~4 tokens.
  let modelSrc = raw
    .replace(/\((.*?)\)/g, ' ')                               // drop parentheticals
    .replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/g, ' ')         // drop storage tokens
    .replace(/\b\d+\s*(?:hz|w|mah|mp|inch|"|''|cm|mm)\b/g, ' ') // drop spec units
    .replace(/\b(black|white|blue|red|green|gold|silver|gray|grey|pink|purple|titanium|graphite|midnight|starlight|natural|space|rose|yellow|orange|أسود|أبيض|أزرق|أحمر|أخضر|ذهبي|فضي)\b/g, ' ')
    .replace(/\b(new|brand|original|sealed|unlocked|dual|sim|5g|4g|lte|wifi|with|and|the|for|smartphone|mobile|phone|laptop|tablet)\b/g, ' ')
    .replace(/[^\w\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (brand) modelSrc = modelSrc.replace(new RegExp(`\\b${brand}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();

  const tokens = modelSrc.split(' ').filter(Boolean).slice(0, 5);
  const model = tokens.join(' ');

  return { brand, model, storage, raw };
}

// Stable group key: brand_model_storage. If storage is missing, suffix with the URL
// so the offer is NOT merged into a group whose storage we DO know — preventing
// 128GB and 256GB (or unknown) from being compared as the same SKU.
function buildGroupKey(n: NormalizedTitle, fallbackId: string): string {
  if (!n.brand && !n.model) return `unknown_${fallbackId}`;
  if (!n.storage) return `${n.brand}_${n.model}_nostorage_${fallbackId}`;
  return `${n.brand}_${n.model}_${n.storage}`;
}

// Pick the canonical image for a group. Priority:
//   1) image already assigned to the group, 2) Amazon Egypt offer image,
//   3) first non-empty offer image. We track per-store images on the group
//   via a side-map kept on the Product object (non-enumerable would be nicer
//   but we just store on a known field).
interface ProductWithImageMap extends Product {
  _imagesByStore?: Record<string, string>;
}

function pickGroupImage(group: ProductWithImageMap): string {
  if (group.image) return group.image;
  const map = group._imagesByStore || {};
  return map['Amazon Egypt'] || Object.values(map).find(Boolean) || '';
}

export function groupProducts(allProducts: RawProduct[]): Product[] {
  const grouped = new Map<string, ProductWithImageMap>();

  for (const p of allProducts) {
    if (!p.price || p.price <= 0) continue;
    const norm = normalizeTitle(p.name || '');
    const key = buildGroupKey(norm, p.url);

    let group = grouped.get(key);
    if (!group) {
      group = {
        id: crypto.randomUUID(),
        name: { en: p.name || '', ar: p.name_ar || p.name || '' },
        specs: { en: p.specs || '', ar: p.specs || '' },
        image: '',
        category: 'electronics',
        offers: [],
        isRefurbished: p.isRefurbished || false,
        confidenceScore: p.confidenceScore ?? 0,
        _imagesByStore: {},
      };
      grouped.set(key, group);
    }

    if (!group.offers.some(o => o.store === p.store && o.url === p.url)) {
      group.offers.push({ store: p.store, price: p.price, url: p.url, currency: 'EGP' });
    }
    if (p.image) {
      group._imagesByStore![p.store] = group._imagesByStore![p.store] || p.image;
    }
    if ((p.confidenceScore ?? 0) > (group.confidenceScore ?? 0)) {
      group.confidenceScore = p.confidenceScore;
    }
    // Prefer a title that contains the storage signal as the canonical display name.
    if (norm.storage && !/\d+\s*(?:tb|gb)\b/i.test(group.name.en)) {
      group.name = { en: p.name || group.name.en, ar: p.name_ar || p.name || group.name.ar };
    }
  }

  return Array.from(grouped.values())
    .map(p => {
      p.image = pickGroupImage(p);
      delete p._imagesByStore;
      p.offers.sort((a, b) => a.price - b.price);
      return p as Product;
    })
    .sort((a, b) => {
      // 1) Confidence score DESC, 2) price ASC.
      const sa = a.confidenceScore ?? 0;
      const sb = b.confidenceScore ?? 0;
      if (sb !== sa) return sb - sa;
      return a.offers[0].price - b.offers[0].price;
    })
    .slice(0, 30);
}
