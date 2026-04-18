---
name: System architecture
description: 17-store smart routing, dual-layer caching, Safety Valve fallback, credit lifecycle, stateless DB
type: feature
---
- 17 stores across 4 categories: GENERAL (Amazon, Noon, B.TECH, Jumia, 2B, RayaShop), APPLE_ONLY (Tradeline, iShop, Switch Plus), PC_HARDWARE (Sigma, ElNekhely, Compumarts, Maximum Hardware), MOBILE_ONLY (Dream 2000, Select.eg, Mobile Shop, Dubai Phone)
- 2-tier scraping: native (zero-cost) + firecrawl (1 credit). SerpApi RETIRED.
- Native stores: Amazon Egypt, Jumia, 2B, RayaShop (Hyvä-aware), iShop, Compumarts, Select.eg
- Firecrawl-only stores: Noon, Tradeline (Supabase edge IPs are blocked at TLS/HTTP2 layer), B.TECH, Switch Plus, Sigma, ElNekhely, Maximum Hardware, Dream 2000, Mobile Shop, Dubai Phone
- **Safety Valve**: every native store has a searchUrl. If native returns 0 items, edge function silently retries via Firecrawl. Charges 1 credit ONLY when fallback recovers items.
- matchesIntent (relaxed): only filters Pro Max / Ultra when query is base. Allows "iPhone 15 Pro" to surface when user typed "iPhone 15".
- Smart client-side routing: getRelevantStores(query) filters stores by regex before calling edge function
- Dual-layer caching: L1 localStorage (24h TTL), L2 Supabase search_cache (12h TTL, UPSERT on unique query key)
- 15-second max timeout per store (AbortController)
- Stateless Supabase: create client → single RPC/query → let it GC (protects Free Tier 60-connection limit)
- Credit lifecycle: reserve_credits() atomically locks balance → scrape → settle_credits() adjusts actual cost, refunds difference
- Cache: never cache empty results (both layers)
- Auth: email/password, auto-profile creation via trigger
