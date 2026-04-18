import { supabase } from '@/integrations/supabase/client';

// ALL 17 STORES — 4 categories
export const ALL_STORES = [
  // GENERAL (always searched)
  'Amazon Egypt', 'Noon', 'B.TECH', 'Jumia', '2B Egypt', 'RayaShop',
  // APPLE_ONLY
  'Tradeline', 'iShop', 'Switch Plus',
  // PC_HARDWARE
  'Sigma', 'ElNekhely', 'Compumarts', 'Maximum Hardware',
  // MOBILE_ONLY
  'Dream 2000', 'Select.eg', 'Mobile Shop', 'Dubai Phone',
] as const;

export type StoreName = typeof ALL_STORES[number];

// Category routing regexes
const APPLE_RE = /iphone|mac|apple|ipad|airpods|watch|آيفون|ماك|ايربودز/i;
const PC_RE = /laptop|pc|monitor|rtx|intel|amd|لاب|كمبيوتر|شاشة|gpu|ram|ssd|processor/i;
const MOBILE_RE = /samsung|oppo|xiaomi|realme|هاتف|موبايل|vivo|huawei|honor|tecno|infinix/i;

const GENERAL_STORES: StoreName[] = ['Amazon Egypt', 'Noon', 'B.TECH', 'Jumia', '2B Egypt', 'RayaShop'];
const APPLE_STORES: StoreName[] = ['Tradeline', 'iShop', 'Switch Plus'];
const PC_STORES: StoreName[] = ['Sigma', 'ElNekhely', 'Compumarts', 'Maximum Hardware'];
const MOBILE_STORES: StoreName[] = ['Dream 2000', 'Select.eg', 'Mobile Shop', 'Dubai Phone'];

/** Smart routing: only search stores relevant to the query */
export function getRelevantStores(query: string): StoreName[] {
  const stores = new Set<StoreName>(GENERAL_STORES);
  const isApple = APPLE_RE.test(query);
  const isPC = PC_RE.test(query);
  const isMobile = MOBILE_RE.test(query);

  if (isApple) APPLE_STORES.forEach(s => stores.add(s));
  if (isPC) PC_STORES.forEach(s => stores.add(s));
  if (isMobile) MOBILE_STORES.forEach(s => stores.add(s));

  // Fallback: if no specific category matched, add mobile stores
  if (!isApple && !isPC && !isMobile) {
    MOBILE_STORES.forEach(s => stores.add(s));
  }

  return Array.from(stores);
}

export interface RawProduct {
  name: string; name_ar?: string; price: number;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
}

export interface StoreOffer { store: string; price: number; url: string; currency: string; }

export interface Product {
  id: string;
  name: { ar: string; en: string };
  specs: { ar: string; en: string };
  image: string; category: string;
  offers: StoreOffer[];
  isRefurbished?: boolean; isVariant?: boolean;
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
    // Wipe local entry so future calls fetch fresh
    try { localStorage.removeItem(getLocalCacheKey(query, store)); } catch { /* ignore */ }
  }

  try {
    // NOTE: user_id is NOT sent in the body — the edge function derives it from the
    // verified JWT (auto-attached by supabase.functions.invoke when a session exists).
    const { data, error } = await supabase.functions.invoke('scrape-prices', {
      body: { query, store, force_refresh: forceRefresh },
    });
    if (error) {
      console.error(`[${store}] Error:`, error);
      return { success: false, products: [], cached: false, store, error: error.message };
    }
    const result = data as StoreSearchResult;
    // Save to localStorage if successful
    if (result.success && result.products.length > 0) {
      setLocalCache(query, store, result.products);
    }
    return result;
  } catch (err) {
    return { success: false, products: [], cached: false, store, error: String(err) };
  }
}

const WHITELISTED_DOMAINS = [
  'amazon.eg', 'noon.com', 'jumia.com.eg', 'btech.com',
  '2b.com.eg', 'tradeline.com.eg', 'rfrsh.me', 'rayashop.com',
  'select.eg', 'compumarts.com', 'elnekhely.com',
  'sigma-computer.com', 'mobileshop.com.eg', 'dream2000.com',
  'ishop.com.eg', 'switchplus.eg', 'maximumhardware.com', 'dubaiphone.eg',
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
