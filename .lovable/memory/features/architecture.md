---
name: System architecture
description: Big 5 store scraping pipeline — Amazon EG, Jumia (native + early Firecrawl fallback), 2B/Noon/B.TECH (Firecrawl)
type: feature
---

# System architecture — BIG 5 (Production)

## Stores
Exactly 5: **Amazon Egypt, Jumia, 2B Egypt, Noon, B.TECH**. Every query hits all 5.

## Scraping
- **Native** (Amazon EG, Jumia): direct fetch wrapped in `raceWithTimeout(..., 12000)`. On 0-results or timeout → Firecrawl Safety Valve fallback.
- **Firecrawl direct** (2B Egypt, Noon, B.TECH): Cloudflare/WAF/Magento markup churn forced full migration. 2B native scraper is permanently disabled (kept defined but not wired into STORE_CONFIGS).
- Amazon EG: targets `[data-component-type="s-search-result"]`, strips Sponsored cards, `.a-price-whole` for clean integer price.
- **Jumia PROGRESSIVE FALLBACK**: streams `<article class="prd">` nodes, applies per-node accessory + relevance check. After scanning 25 cards with 0 valid phones → returns [] → Safety Valve immediately routes to Firecrawl. Avoids 200-card full-DOM walks.

## Firecrawl strategies
- **Default (Noon, 2B)**: multi-stage actions = wait → scroll → wait → scroll → wait. Stage-2 retry on 0-result with 9s wait + alt selector prompt.
- **B.TECH SPECIAL**: NO scroll actions (caused skeleton-loader noise). Uses waitFor + selector wait (`.product-item, [data-product-id], .products-grid`). Prompt explicitly ignores skeleton/placeholder/shimmer cards. Stage-2 retry bumps waitFor to 7s and switches to an alt prompt that mines embedded JSON (`<script type="application/ld+json">`, `__INITIAL_STATE__`, `dataLayer`) when the visible grid is still empty.

## Filtering
- Out-of-stock + accessories dropped per-node.
- Brand cross-pollution exclusion preserved.
- Floor: `MINIMUM_PRICE_THRESHOLD = 1500`.

## Caching & credits
- L1 `localStorage` 24h, L2 Supabase `search_cache` 3h UPSERT (key = `store:query`).
- Credits: `reserve_credits()` → scrape → `settle_credits()`. Native = free unless Firecrawl Safety Valve fires.

## Resilience
- Client invokes 5 stores via `Promise.allSettled` → one store's failure never blocks the others.
- Server-side analytics insert into `search_logs` fire-and-forget via `SUPABASE_SERVICE_ROLE_KEY`.
- Firecrawl: AbortController 90s, body `timeout: 75000`.
