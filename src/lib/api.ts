import { supabase } from '@/integrations/supabase/client';

// ALL 13 STORES — 3 tiers
export const ALL_STORES = [
  // Tier 1
  'Amazon Egypt', 'Noon', 'B.TECH', 'Jumia',
  // Tier 2
  '2B Egypt', 'Tradeline', 'Raya',
  // Tier 3
  'Select.eg', 'Compumarts', 'ElNekhely', 'Sigma', 'Mobile Shop', 'Dream 2000',
] as const;

export const STORE_TIERS: Record<string, 1 | 2 | 3> = {
  'Amazon Egypt': 1, 'Noon': 1, 'B.TECH': 1, 'Jumia': 1,
  '2B Egypt': 2, 'Tradeline': 2, 'Raya': 2,
  'Select.eg': 3, 'Compumarts': 3, 'ElNekhely': 3, 'Sigma': 3, 'Mobile Shop': 3, 'Dream 2000': 3,
};

export type StoreName = typeof ALL_STORES[number];

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

export async function searchStore(query: string, store: string, userId?: string): Promise<StoreSearchResult> {
  try {
    const { data, error } = await supabase.functions.invoke('scrape-prices', {
      body: { query, store, user_id: userId },
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

const WHITELISTED_DOMAINS = [
  'amazon.eg', 'noon.com', 'jumia.com.eg', 'btech.com',
  '2b.com.eg', 'tradeline.com.eg', 'raya.com', 'rfrsh.me',
  'select.eg', 'compumarts.com', 'elnekhely.com',
  'sigma-computer.com', 'mobileshop.com.eg', 'dream2000.com',
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
      const nameNumbers = name.match(/\d+/g) || [];
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
