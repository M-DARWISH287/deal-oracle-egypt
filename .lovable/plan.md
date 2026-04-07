
# BestDeal.ai — Phase 1: Homepage + Search UI

## Design System
- **Dark theme**: Deep slate/black background (`#0B0F1A`), with neon purple/blue accent glows (`#8B5CF6`, `#3B82F6`)
- **Soft glowing borders** on interactive elements (search bar, cards, buttons)
- **Smooth fade-in animations** and skeleton loaders for "AI thinking" state
- **RTL layout by default** with AR/EN language toggle
- **Font**: Arabic-friendly (e.g., IBM Plex Sans Arabic for headings, Inter for English)

## Pages & Components

### 1. Homepage
- Centered hero with large **glowing search bar** (Arabic placeholder: "ابحث عن أفضل سعر...")
- Language toggle (AR/EN) in the top corner
- Subtle animated background (gradient mesh or particles)
- Trending/popular searches section below with pill-style chips
- BestDeal.ai logo and tagline

### 2. Search Results Page
- Search bar persists at top
- **Skeleton loaders** appear while "searching" (simulated 1-2s delay with mock data)
- Results grouped by product — each product card shows:
  - Product image (large, prominent)
  - Product name and key specs
  - **"أفضل سعر" (Best Price)** badge on the cheapest option, highlighted in green
  - List of stores sorted by price (each showing: store logo, price in EGP, "اشتري" buy button + "نسخ الرابط" copy link button)
  - All buy links open in new tab (`target="_blank"`)
- Filters: sort by price, store

### 3. Mock Data
- 8-10 realistic Egyptian electronics products (phones, laptops, headphones)
- Prices in EGP from stores: Amazon Egypt, Noon, B.TECH, 2B, Tradeline
- Realistic product images (placeholder URLs)
- Store logos for each retailer

### 4. Bilingual Support
- AR/EN context provider with language toggle
- All UI strings in both languages
- Layout flips between RTL (Arabic) and LTR (English)

### 5. Animations & Polish
- Search bar pulse/glow animation on focus
- Product cards fade-in staggered on load
- Skeleton shimmer loaders during search
- Smooth transitions between pages
