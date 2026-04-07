import { supabase } from '@/integrations/supabase/client';

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

export interface SearchResponse {
  success: boolean;
  data?: Product[];
  cached?: boolean;
  storeErrors?: string[];
  error?: string;
}

export async function searchProducts(query: string): Promise<SearchResponse> {
  const { data, error } = await supabase.functions.invoke('scrape-prices', {
    body: { query },
  });

  if (error) {
    console.error('Edge function error:', error);
    return { success: false, error: error.message };
  }

  return data as SearchResponse;
}
