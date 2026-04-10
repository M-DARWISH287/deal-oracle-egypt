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
