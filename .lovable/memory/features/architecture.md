---
name: System architecture
description: 13-store smart routing (Golden Version), 12s native race + Firecrawl fallback, dual-layer cache, credit lifecycle
type: feature
---
- 13 stores in 2 categories (Golden Version):
  - GENERAL (always, 9): Amazon Egypt, Noon, B.TECH, Jumia, RayaShop, 2B Egypt, Dream 2000, Cairo Sales, Select Egypt
  - APPLE_ONLY (4, only on iPhone/Mac/iPad/AirPods queries): Tradeline, Switch Plus, iShop (uses ishopegypt.com), MyPlus
- Removed (vs prior 17): Sigma, ElNekhely, Compumarts, Maximum Hardware, Mobile Shop, Dubai Phone
- 2-tier scraping: native (zero-cost) + firecrawl (1 credit). SerpApi RETIRED.
- Native stores: Amazon Egypt, Jumia, 2B Egypt, RayaShop (Hyvä-aware), Select Egypt
- Firecrawl-only stores: Noon, B.TECH, Dream 2000, Cairo Sales, Tradeline, Switch Plus, iShop, MyPlus
- **12-Second Rule**: every native scraper runs through `raceWithTimeout(...12000ms)`. If native exceeds 12s OR returns 0 items → Safety Valve fires Firecrawl fallback. Charges 1 credit only when fallback recovers items.
- Firecrawl: AbortController 90s, body `timeout: 75000` (renders JS + waitFor 5s + LLM extract).
- Inventory filter: drops out-of-stock items (`out of stock`, `sold out`, `نفدت الكمية`, `غير متوفر`).
- Accessory filter: drops case/cover/screen/charger (EN + AR).
- iShop fix: ishop.com.eg DNS dead → switched to ishopegypt.com via Firecrawl.
- Amazon scraper: splits on `data-asin` for resilience against wrapper class changes.
- matchesIntent (relaxed): only filters Pro Max / Ultra when query is base.
- Smart client routing: getRelevantStores(query) — General + Apple specialists when APPLE_RE matches.
- Dual-layer caching: L1 localStorage (24h TTL), L2 Supabase search_cache (12h TTL, UPSERT on unique query key).
- Stateless Supabase: create client → single RPC/query → let it GC.
- Credit lifecycle: reserve_credits() atomically locks balance → scrape → settle_credits() refunds difference.
- Server-side analytics: scrape-prices logs every search to search_logs via SUPABASE_SERVICE_ROLE_KEY (RLS-bypass, fire-and-forget).
- Auth: email/password, auto-profile creation via trigger.
