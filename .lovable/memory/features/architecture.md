---
name: System architecture
description: Big 5 store scraping pipeline — Amazon EG / Jumia / B.TECH / Noon native, 2B Firecrawl
type: feature
---

# System architecture — BIG 5 (Production)

## Stores
Exactly 5: **Amazon Egypt, Jumia, 2B Egypt, Noon, B.TECH**. Every query hits all 5.

## 3-Stage Intelligent Retrieval (per store)
- **Stage 1 — Primary native API** (3s aggressive timeout via `STAGE1_NATIVE_TIMEOUT_MS`): default UA + default params. Return immediately on success.
- **Stage 2 — Smart retry** (3s, single attempt, ONLY on Stage 1 = 0 items): same scraper invoked with `stage=2` → rotated UA (`STEALTH_HEADERS_ALT`, Firefox/Linux) + modified params (B.TECH `page=2 size=30`, Jumia/Amazon `&page=2`). No identical retries.
- **Stage 3 — Firecrawl multi-strategy** (only on Stages 1+2 = 0): Attempt 1 `waitFor=5000` no-scroll. Attempt 2 (on 0): `waitFor=9000` + scroll + alternate prompt. **SKIPPED for Noon** (native-only).

## Native scrapers
- **Amazon EG** native: targets `[data-component-type="s-search-result"]`, strips Sponsored cards, `.a-price-whole`. Stage 2 drops the rh=node filter and uses page=2.
- **Jumia** PROGRESSIVE FALLBACK: streams `<article class="prd">` nodes, applies per-node accessory + relevance check. After 25 cards with 0 valid phones → returns [] → Stage 2 / Stage 3.
- **B.TECH** Next.js Server Action: POST `https://btech.com/en` with `Next-Action: 40a804c5...` header. Body `[{search, page, size}]`. Parses RSC stream lines `^[0-9a-f]+:(\{...\})$` for `data.items[]`.
- **Noon** native (Firecrawl REMOVED — 500 lifetime + 2 concurrency cap): fetches `https://www.noon.com/egypt-en/search/?q=...` with 2s timeout + 2 retries (exp backoff 200/500ms), parses `__NEXT_DATA__` JSON blob, falls back to `.productContainer` DOM scan. **Known limitation**: Noon's Akamai WAF returns HTTP 403 for all datacenter IPs and rejects Deno's HTTP/2 fingerprint with stream errors → native often returns EMPTY_RESULT cleanly. No Firecrawl fallback per product decision.
- **2B Egypt**: no native — direct Firecrawl Stage 3 only.

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
- `PIPELINE_TRACE` JSON log emitted on every exit path (success, fail, validation, crash) with `stages_attempted`, `fallback_reason`, `latency_ms`.
- Native-only stores (Noon) → Stage 3 skipped, `fallback_reason` carries the native failure cause.
