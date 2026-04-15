import { supabase } from '@/integrations/supabase/client';

// TOP 6 CORE STORES ONLY — secondary stores disabled to stop credit burn
export const ALL_STORES = [
  'Amazon Egypt', 'Noon', 'B.TECH',
  'Jumia', '2B Egypt', 'Tradeline',
] as const;

export type StoreName = typeof ALL_STORES[number];

export interface RawProduct {
  name: string;
  name_ar?: string;
  price: number;
  url: string;
  image?: string;
  specs?: string;
  store: string;
  isRefurbished?: boolean;
}

export interface StoreOffer {
  store: string;
  price: number;
  url: string;
  currency: string;
}

export interface Product {
  id: string;
  name: { ar: string; en: string };
  specs: { ar: string; en: string };
  image: string;
  category: string;
  offers: StoreOffer[];
  isRefurbished?: boolean;
  isVariant?: boolean; // true when shown via relaxed intent
}

export interface StoreSearchResult {
  success: boolean;
  products: RawProduct[];
  cached: boolean;
  store: string;
  cachedAt?: string;
  error?: string;
}

export async function searchStore(query: string, store: string): Promise<StoreSearchResult> {
  try {
    const { data, error } = await supabase.functions.invoke('scrape-prices', {
      body: { query, store },
    });

    if (error) {
      console.error(`[${store}] Error:`, error);
      return { success: false, products: [], cached: false, store, error: error.message };
    }

    return data as StoreSearchResult;
  } catch (err) {
    return { success: false, products: [], cached: false, store, error: String(err) };
  }
}

/**
 * Strict client-side filter. Returns { strict, relaxed } where:
 * - strict: products passing all intent rules
 * - relaxed: products passing price + domain rules only (used as fallback)
 */
export function clientFilterWithFallback(
  products: Product[],
  query: string
): { strict: Product[]; relaxed: Product[] } {
  const q = query.toLowerCase();
  const variants = ['pro', 'max', 'plus', 'ultra'] as const;
  const queryNumbers = q.match(/\d+/g) || [];

  const strict: Product[] = [];
  const relaxed: Product[] = [];

  for (const p of products) {
    // --- Hard rules (never relaxed) ---
    const clone = deepCloneProduct(p);

    // 1. Min price threshold
    const bestPrice = Math.min(...clone.offers.map(o => o.price));
    if (bestPrice < 1500) continue;

    // 2. Domain whitelist — only keep offers from known Egyptian stores
    const WHITELISTED_DOMAINS = [
      'amazon.eg', 'noon.com', 'jumia.com.eg', 'btech.com',
      '2b.com.eg', 'tradeline.com.eg', 'raya.com',
    ];
    clone.offers = clone.offers.filter(o => {
      try {
        const hostname = new URL(o.url).hostname;
        return WHITELISTED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
      } catch { return false; }
    });
    if (clone.offers.length === 0) continue;

    // 5. Refurbished tagging
    const name = clone.name.en.toLowerCase();
    const refurbWords = ['restored', 'renewed', 'refurbished', 'مجدد'];
    if (refurbWords.some(w => name.includes(w) || clone.name.ar.includes(w))) {
      clone.isRefurbished = true;
    }

    // 6. De-duplicate offers
    const seen = new Set<string>();
    clone.offers = clone.offers.filter(o => {
      const key = `${o.store}|${o.price}|${o.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // --- Intent rules (relaxable) ---
    let passesIntent = true;

    // 3. Strict variant filtering
    for (const v of variants) {
      if (!q.includes(v) && name.includes(v)) { passesIntent = false; break; }
    }

    // 4. Strict number/model matching
    if (passesIntent && queryNumbers.length > 0) {
      const nameNumbers: string[] = name.match(/\d+/g) || [];
      for (const qn of queryNumbers) {
        if (!nameNumbers.includes(qn)) { passesIntent = false; break; }
      }
    }

    if (passesIntent) {
      strict.push(clone);
    } else {
      clone.isVariant = true;
      relaxed.push(clone);
    }
  }

  return { strict, relaxed };
}

/** Legacy wrapper — returns strict results only */
export function clientFilter(products: Product[], query: string): Product[] {
  return clientFilterWithFallback(products, query).strict;
}

function deepCloneProduct(p: Product): Product {
  return {
    ...p,
    name: { ...p.name },
    specs: { ...p.specs },
    offers: p.offers.map(o => ({ ...o })),
  };
}

export function groupProducts(allProducts: RawProduct[]): Product[] {
  const grouped: Map<string, Product> = new Map();

  for (const p of allProducts) {
    if (!p.price || p.price <= 0) continue;
    
    const normalizedName = (p.name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

    let matched = false;
    for (const [key, group] of grouped) {
      if (
        normalizedName.includes(key.slice(0, 25)) ||
        key.includes(normalizedName.slice(0, 25))
      ) {
        if (!group.offers.some(o => o.store === p.store && o.url === p.url)) {
          group.offers.push({
            store: p.store,
            price: p.price,
            url: p.url,
            currency: 'EGP',
          });
        }
        if (p.image && !group.image) group.image = p.image;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const id = crypto.randomUUID();
      grouped.set(normalizedName, {
        id,
        name: { en: p.name || '', ar: p.name_ar || p.name || '' },
        specs: { en: p.specs || '', ar: p.specs || '' },
        image: p.image || '',
        category: 'electronics',
        offers: [{ store: p.store, price: p.price, url: p.url, currency: 'EGP' }],
        isRefurbished: p.isRefurbished || false,
      });
    }
  }

  return Array.from(grouped.values())
    .map((p) => {
      p.offers.sort((a, b) => a.price - b.price);
      return p;
    })
    .sort((a, b) => {
      if (b.offers.length !== a.offers.length) return b.offers.length - a.offers.length;
      return a.offers[0].price - b.offers[0].price;
    })
    .slice(0, 30);
}
