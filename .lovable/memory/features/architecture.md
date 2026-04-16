---
name: System architecture
description: 17-store smart routing, dual-layer caching, credit lifecycle, stateless DB
type: feature
---
- 17 stores across 4 categories: GENERAL (Amazon, Noon, B.TECH, Jumia, 2B, RayaShop), APPLE_ONLY (Tradeline, iShop, Switch Plus), PC_HARDWARE (Sigma, ElNekhely, Compumarts, Maximum Hardware), MOBILE_ONLY (Dream 2000, Select.eg, Mobile Shop, Dubai Phone)
- Smart client-side routing: getRelevantStores(query) filters stores by regex before calling edge function
- Dual-layer caching: L1 localStorage (24h TTL), L2 Supabase search_cache (12h TTL, UPSERT on unique query key)
- 15-second max timeout per store (AbortController)
- Stateless Supabase: create client → single RPC/query → let it GC (protects Free Tier 60-connection limit)
- Credit lifecycle: reserve_credits() atomically locks balance → scrape → settle_credits() adjusts actual cost, refunds difference
- Cache: never cache empty results (both layers)
- Auth: email/password, auto-profile creation via trigger
