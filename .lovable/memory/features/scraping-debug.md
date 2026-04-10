---
name: Scraping debug findings
description: Root causes for 0-result bugs in SerpApi and Firecrawl integrations
type: feature
---
- SerpApi google_shopping engine does NOT support gl=eg (Egypt). Removed gl param entirely.
- SerpApi site:amazon.eg filter returns 0 results. Changed to append store domain as keyword instead.
- Firecrawl extract mode needs 30s timeout (was 15s, caused timeouts for Noon/Jumia/2B).
- Tradeline returns empty extract from Firecrawl — site may not be parseable.
- Secondary stores (Select.eg, Compumarts, ElNekhely, Sigma, Raya, Mobile Shop, Dream 2000) disabled to reduce credit burn.
