---
name: System architecture
description: 13-store adapter pattern, credit lifecycle, cascade fallback, stateless DB connections
type: feature
---
- 13 stores across 3 priority tiers: T1 (Amazon, Noon, B.TECH, Jumia), T2 (2B, Tradeline, Raya), T3 (Select.eg, Compumarts, ElNekhely, Sigma, Mobile Shop, Dream 2000)
- 15-second max timeout per store (AbortController)
- Stateless Supabase: create client → single RPC/query → let it GC (protects Free Tier 60-connection limit)
- Credit lifecycle: reserve_credits() atomically locks balance → scrape → settle_credits() adjusts actual cost, refunds difference
- Cache: 12-hour TTL, never cache empty results
- Auth: email/password + Google OAuth, auto-profile creation via trigger
