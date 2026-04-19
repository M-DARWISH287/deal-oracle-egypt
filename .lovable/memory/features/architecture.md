---
name: System architecture
description: Big 5 store scraping pipeline — Amazon EG, Jumia, 2B (native) + Noon, B.TECH (Firecrawl)
type: feature
---

# System architecture — BIG 5 (Production)

## Stores
Exactly 5: **Amazon Egypt, Jumia, 2B Egypt, Noon, B.TECH**. Every query hits all 5 (no smart routing, no Apple specialists).
Removed entirely: RayaShop, Dream 2000, Cairo Sales, Select Egypt, Tradeline, Switch Plus, iShop, MyPlus.

## Scraping
- **Native** (Amazon EG, Jumia, 2B Egypt): direct fetch wrapped in `raceWithTimeout(..., 12000)`. On 0-results or timeout → Firecrawl Safety Valve fallback.
- **Firecrawl direct** (Noon, B.TECH): Cloudflare/WAF too aggressive for direct fetch — straight to Firecrawl extract.
- Amazon EG: targets `[data-component-type="s-search-result"]` containers, `.a-price-whole` for clean integer price (decimals ignored).
- 2B Egypt: `extractLowestPrice` strips `.old-price` / `.regular-price` / `<s>` / `<del>` nodes BEFORE collecting candidates → fixes crossed-out price bug. Prefers `data-price-type="finalPrice"` and `.special-price`. Math.min over remaining candidates picks the active discount.
- Jumia: `<article class="prd">` parser unchanged.

## Filtering
- Out-of-stock (AR + EN: `out of stock`, `sold out`, `نفدت الكمية`, `غير متوفر`) and accessories (case, cover, شاحن, جراب, سكرين, كابل…) dropped.
- Brand cross-pollution exclusion preserved.
- Floor: `MINIMUM_PRICE_THRESHOLD = 1500`. No higher hardcoded minimum.

## Caching & credits
- L1 `localStorage` 24h, L2 Supabase `search_cache` 12h UPSERT.
- Credits: `reserve_credits()` → scrape → `settle_credits()`. Native = free unless Firecrawl Safety Valve fires.

## Resilience
- Client invokes 5 stores via `Promise.allSettled` → one store's failure never blocks the others.
- Server-side analytics insert into `search_logs` fire-and-forget via `SUPABASE_SERVICE_ROLE_KEY`.
- Firecrawl: AbortController 90s, body `timeout: 75000`.
