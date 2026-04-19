---
name: System architecture
description: Big 5 store scraping pipeline — Amazon EG / Jumia / B.TECH native, 2B / Noon Firecrawl
type: feature
---

# System architecture — BIG 5 (Production)

## Stores
Exactly 5: **Amazon Egypt, Jumia, 2B Egypt, Noon, B.TECH**. Every query hits all 5.

## 3-Stage Intelligent Retrieval (per store)
- **Stage 1 — Primary native API** (3s aggressive timeout via `STAGE1_NATIVE_TIMEOUT_MS`): default UA + default params. Return immediately on success.
- **Stage 2 — Smart retry** (3s, single attempt, ONLY on Stage 1 = 0 items): same scraper invoked with `stage=2` → rotated UA (`STEALTH_HEADERS_ALT`, Firefox/Linux) + modified params (B.TECH `page=2 size=30`, Jumia/Amazon `&page=2`). No identical retries.
- **Stage 3 — Firecrawl multi-strategy** (only on Stages 1+2 = 0): Attempt 1 `waitFor=5000` no-scroll. Attempt 2 (on 0): `waitFor=9000` + scroll + alternate prompt.

## Native scrapers
- **Amazon EG** native: targets `[data-component-type="s-search-result"]`, strips Sponsored cards, `.a-price-whole`. Stage 2 drops the rh=node filter and uses page=2.
- **Jumia** PROGRESSIVE FALLBACK: streams `<article class="prd">` nodes, applies per-node accessory + relevance check. After 25 cards with 0 valid phones → returns [] → Stage 2 / Stage 3.
- **B.TECH** Next.js Server Action: POST `https://btech.com/en` with `Next-Action: 40a804c5...` header. Body `[{search, page, size}]`. Parses RSC stream lines `^[0-9a-f]+:(\{...\})$` for `data.items[]`. URL = `https://btech.com/en/{slug}`, image = `https://dwecxxryy5p59.cloudfront.net/{main_image}`.
- **2B Egypt + Noon**: no native — direct Firecrawl Stage 3 only.

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
