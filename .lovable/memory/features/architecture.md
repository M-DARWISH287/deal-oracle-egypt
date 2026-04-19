---
name: System architecture
description: Big 5 store scraping pipeline — Amazon EG / Jumia / B.TECH native, 2B / Noon Firecrawl
type: feature
---

# System architecture — BIG 5 (Production)

## Stores
Exactly 5: **Amazon Egypt, Jumia, 2B Egypt, Noon, B.TECH**. Every query hits all 5.

## Scraping
- **Native** (Amazon EG, Jumia, B.TECH): direct fetch wrapped in `raceWithTimeout(..., 12000)`. On 0-results or timeout → Firecrawl Safety Valve fallback.
- **Firecrawl direct** (2B Egypt, Noon): Cloudflare/WAF/Magento markup churn forced full migration. 2B native scraper is permanently disabled.
- Amazon EG: targets `[data-component-type="s-search-result"]`, strips Sponsored cards, `.a-price-whole` for clean integer price.
- **Jumia PROGRESSIVE FALLBACK**: streams `<article class="prd">` nodes, applies per-node accessory + relevance check. After scanning 25 cards with 0 valid phones → returns [] → Safety Valve immediately routes to Firecrawl.
- **B.TECH NEXT.JS SERVER ACTION** (no Firecrawl primary path): POST `https://btech.com/en` with header `Next-Action: 40a804c5...` (the `getProductsByFilterAction` reference lifted from public chunks) and body `[{search, page:'1', size:50}]`. Response is an RSC stream; we scan lines matching `^[0-9a-f]+:(\{...\})$` for the JSON containing `data.items[]`. Each item has `title / slug / main_image / price.final_float_price / categories_tree`. URL = `https://btech.com/en/{slug}`, image = `https://dwecxxryy5p59.cloudfront.net/{main_image}`. Sub-2s, no headless browser, no skeleton-loader noise. If action ID rotates after a B.TECH rebuild → 0 items → Safety Valve fires Firecrawl as backup.

## Firecrawl strategies
- **Noon, 2B Egypt + Safety Valve fallbacks**: multi-stage actions = wait → scroll → wait → scroll → wait. Stage-2 retry on 0-result with 9s wait + alt selector prompt.

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
