// ════════════════════════════════════════════════════════════════════
// BEST VALUE DECISION ENGINE
// ────────────────────────────────────────────────────────────────────
// Layered on top of the Big-5 scraping pipeline. Re-ranks offers using
// price + store reliability + scraping data confidence — the cheapest
// offer is NOT necessarily the winner.
//
// Score formula (per offer):
//   score = priceScore * 0.6 + storeReliability * 0.3 + dataConfidence * 0.1
//
// Failure rule: stores that returned empty / timeout / invalid results
// are simply not present in the offer list — they don't penalize others.
// One bad store NEVER blocks the engine (Promise.allSettled upstream).
// ════════════════════════════════════════════════════════════════════

import type { Product, StoreOffer } from '@/lib/api';

// ── 1. STATIC STORE RELIABILITY WEIGHTS ──
// Tuned against measured pass-rate, latency and data-quality across
// recent benchmarks. Adjust here only — the engine reads from this map.
export const STORE_RELIABILITY: Record<string, number> = {
  'Amazon Egypt': 1.0,
  'B.TECH': 0.9,
  'Jumia': 0.85,
  '2B Egypt': 0.6,
  'Noon': 0.55,
};
const DEFAULT_RELIABILITY = 0.5; // unknown / future stores

// ── 2. DATA CONFIDENCE per store (scraping method quality) ──
// Reflects HOW the data was extracted — structured API > clean HTML > fallback.
//   1.0  → structured JSON / Server Action API (B.TECH)
//   0.7  → clean HTML parser (Amazon, Jumia, Noon native)
//   0.4  → Firecrawl fallback / partial markup (2B Egypt)
const STORE_DATA_CONFIDENCE: Record<string, number> = {
  'B.TECH': 1.0,        // Next.js Server Action → typed JSON
  'Amazon Egypt': 0.7,  // HTML parser
  'Jumia': 0.7,         // HTML parser
  'Noon': 0.7,          // __NEXT_DATA__ JSON / DOM fallback
  '2B Egypt': 0.4,      // Firecrawl fallback
};
const DEFAULT_DATA_CONFIDENCE = 0.5;

// ── 3. SCORED OFFER + RANKED PRODUCT TYPES ──
export interface ScoredOffer extends StoreOffer {
  score: number;            // 0..1 final composite score
  priceScore: number;       // 0..1 normalized inverse price
  reliability: number;      // 0..1 store reliability weight
  dataConfidence: number;   // 0..1 scraping quality
  isBestValue: boolean;     // true for the single best-value offer in the product
}

export interface RankedProduct extends Omit<Product, 'offers'> {
  offers: ScoredOffer[];          // sorted: best-value first
  bestOfferScore: number;          // top offer's composite score (used for product-level ranking)
  bestValueOffer: ScoredOffer;     // shortcut to the winner
}

export interface DecisionEngineResult {
  products: RankedProduct[];           // sorted by bestOfferScore DESC
  bestOffer: { product: RankedProduct; offer: ScoredOffer } | null;
  scoringMeta: {
    storeWeightsUsed: true;
    rankingMethod: 'best_value_engine';
    totalProducts: number;
    totalOffers: number;
    storesEvaluated: string[];
  };
}

// ── 4. CORE SCORING ──
// priceScore = normalized inverse price across the offer set.
//   cheapest offer → 1.0, most expensive → 0.0, single offer → 1.0.
// We normalize per-product so cross-product price ranges don't skew weights.
function scoreOffersForProduct(offers: StoreOffer[]): ScoredOffer[] {
  if (offers.length === 0) return [];
  const prices = offers.map(o => o.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP;

  const scored: ScoredOffer[] = offers.map((o) => {
    // Inverse normalized price (lower price → higher score). Clamp to [0,1].
    const priceScore = range === 0 ? 1 : Math.max(0, Math.min(1, 1 - (o.price - minP) / range));
    const reliability = STORE_RELIABILITY[o.store] ?? DEFAULT_RELIABILITY;
    const dataConfidence = STORE_DATA_CONFIDENCE[o.store] ?? DEFAULT_DATA_CONFIDENCE;
    const score = priceScore * 0.6 + reliability * 0.3 + dataConfidence * 0.1;
    return { ...o, score, priceScore, reliability, dataConfidence, isBestValue: false };
  });

  // Mark the single best-value offer (highest composite score, ties → cheaper price wins).
  scored.sort((a, b) => (b.score - a.score) || (a.price - b.price));
  scored[0].isBestValue = true;
  return scored;
}

// ── 5. PUBLIC API ──
// Takes the grouped+filtered Product[] (output of clientFilterWithFallback)
// and returns the same set re-ranked by composite Best-Value score.
export function rankByBestValue(products: Product[]): DecisionEngineResult {
  const ranked: RankedProduct[] = products.map((p) => {
    const scored = scoreOffersForProduct(p.offers);
    const winner = scored[0];
    return {
      ...p,
      offers: scored,
      bestOfferScore: winner?.score ?? 0,
      bestValueOffer: winner,
    };
  });

  // Product-level sort:
  //   1) Composite best-offer score DESC (the actual "best value" intent),
  //   2) Confidence score DESC (existing relevance signal),
  //   3) Cheapest offer ASC (final tiebreaker).
  ranked.sort((a, b) => {
    if (b.bestOfferScore !== a.bestOfferScore) return b.bestOfferScore - a.bestOfferScore;
    const ca = a.confidenceScore ?? 0;
    const cb = b.confidenceScore ?? 0;
    if (cb !== ca) return cb - ca;
    return (a.bestValueOffer?.price ?? 0) - (b.bestValueOffer?.price ?? 0);
  });

  // System-level "best offer" = the best-value offer of the top-ranked product.
  const top = ranked[0];
  const bestOffer = top ? { product: top, offer: top.bestValueOffer } : null;

  const allStores = new Set<string>();
  let totalOffers = 0;
  for (const p of ranked) {
    for (const o of p.offers) { allStores.add(o.store); totalOffers++; }
  }

  return {
    products: ranked,
    bestOffer,
    scoringMeta: {
      storeWeightsUsed: true,
      rankingMethod: 'best_value_engine',
      totalProducts: ranked.length,
      totalOffers,
      storesEvaluated: Array.from(allStores).sort(),
    },
  };
}
