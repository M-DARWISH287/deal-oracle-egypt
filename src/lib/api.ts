import { supabase } from '@/integrations/supabase/client';
import { canonicalizeQuery, routeStores } from '@/lib/semantic';

// ── BIG 5 ARCHITECTURE + PHASE 4 SMART ROUTER ──
// All 5 stores remain in the catalog. The Smart Store Router (semantic layer)
// picks the top-N most relevant stores per query so we stop broadcasting blindly.
export const ALL_STORES = [
  'Amazon Egypt', 'Noon', 'B.TECH', 'Jumia', '2B Egypt',
] as const;

export type StoreName = typeof ALL_STORES[number];

/**
 * Phase 4: returns the top-N stores by semantic affinity for the query.
 * Low-confidence intent → full broadcast (preserves coverage). Default top-N = 3.
 */
export function getRelevantStores(query: string, topN = 3): StoreName[] {
  const intent = canonicalizeQuery(query || '');
  const { selected } = routeStores(intent, ALL_STORES, topN);
  return selected as StoreName[];
}

export interface RawProduct {
  name: string; name_ar?: string; price: number;
  url: string; image?: string; specs?: string; store: string; isRefurbished?: boolean;
  confidenceScore?: number;
}

export interface StoreOffer { store: string; price: number; url: string; currency: string; }

export interface Product {
  id: string;
  name: { ar: string; en: string };
  specs: { ar: string; en: string };
  image: string; category: string;
  offers: StoreOffer[];
  isRefurbished?: boolean; isVariant?: boolean;
  confidenceScore?: number;
  /** Extracted storage tier, e.g. "128GB" or "1TB". Empty when unknown. */
  storage?: string;
}

export interface StoreSearchResult {
  success: boolean; products: RawProduct[]; cached: boolean;
  store: string; cachedAt?: string; error?: string;
  /** Debug-mode pipeline status: 'success' | 'empty' | 'blocked' | 'failed' */
  status?: 'success' | 'empty' | 'blocked' | 'failed';
}

// ── localStorage Cache (Layer 1) ──
const LOCAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface LocalCacheEntry {
  products: RawProduct[];
  timestamp: number;
  store: string;
}

function getLocalCacheKey(query: string, store: string): string {
  return `bd_cache:${store}:${query.trim().toLowerCase()}`;
}

function getLocalCache(query: string, store: string): RawProduct[] | null {
  try {
    const raw = localStorage.getItem(getLocalCacheKey(query, store));
    if (!raw) return null;
    const entry: LocalCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > LOCAL_CACHE_TTL_MS) {
      localStorage.removeItem(getLocalCacheKey(query, store));
      return null;
    }
    return entry.products;
  } catch { return null; }
}

function setLocalCache(query: string, store: string, products: RawProduct[]) {
  if (products.length === 0) return; // never cache empty
  try {
    const entry: LocalCacheEntry = { products, timestamp: Date.now(), store };
    localStorage.setItem(getLocalCacheKey(query, store), JSON.stringify(entry));
  } catch { /* quota exceeded — ignore */ }
}

export async function searchStore(
  query: string,
  store: string,
  forceRefresh = false,
): Promise<StoreSearchResult> {
  // Layer 1: check localStorage first (skipped on force refresh)
  if (!forceRefresh) {
    const localCached = getLocalCache(query, store);
    if (localCached) {
      return { success: true, products: localCached, cached: true, store, status: 'success', cachedAt: 'local' };
    }
  } else {
    try { localStorage.removeItem(getLocalCacheKey(query, store)); } catch { /* ignore */ }
  }

  try {
    const { data, error } = await supabase.functions.invoke('scrape-prices', {
      body: { query, store, force_refresh: forceRefresh },
    });
    if (error) {
      console.error(`[${store}] Error:`, error);
      return { success: false, products: [], cached: false, store, error: error.message };
    }
    const result = data as StoreSearchResult;
    if (result.success && result.products.length > 0) {
      setLocalCache(query, store, result.products);
    }
    return result;
  } catch (err) {
    return { success: false, products: [], cached: false, store, error: String(err) };
  }
}

// ── BIG 5 whitelisted domains ──
const WHITELISTED_DOMAINS = [
  'amazon.eg', 'noon.com', 'jumia.com.eg', 'btech.com', '2b.com.eg',
];

const BRAND_EXCLUSIONS: Record<string, string[]> = {
  iphone: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'realme', 'huawei', 'honor', 'vivo', 'tecno', 'infinix', 'nokia'],
  apple: ['samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'huawei', 'honor', 'vivo'],
  ipad: ['samsung', 'galaxy', 'tab ', 'lenovo', 'huawei'],
  macbook: ['samsung', 'lenovo', 'hp ', 'dell', 'asus', 'acer'],
  samsung: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo', 'huawei'],
  galaxy: ['iphone', 'apple ', 'xiaomi', 'redmi', 'oppo'],
  xiaomi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  redmi: ['iphone', 'samsung', 'galaxy', 'oppo', 'huawei'],
  oppo: ['iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi'],
  huawei: ['iphone', 'samsung', 'galaxy', 'xiaomi'],
};

const ACCESSORY_KEYWORDS_CLIENT = [
  // Pure accessory phrases only — never bare 'case'/'cover' as substrings
  // (substring match on those produces false positives like "showcase",
  // "coverage"). Bare case/cover are caught by ACCESSORY_REGEX_CLIENT below.
  'protector', 'screen protector', 'tempered glass',
  'cable', 'charger', 'adapter', 'holder',
  'جراب', 'كفر', 'شاحن', 'كابل', 'حامل', 'واقي شاشة', 'سكرين', 'حماية',
  'earphone', 'earbuds', 'headset', 'strap', 'band', 'pouch', 'sleeve',
  'lens protector', 'camera protector',
];

// Word-boundary regex mirrors the server (supabase/functions/scrape-prices/index.ts).
// Catches phrasings like "Wallet Case,Black" / "Flip Cover" without false positives.
const ACCESSORY_REGEX_CLIENT = /\b(case|cover|wallet case|flip cover|back cover|skin)\b/i;

// ── GLOBAL RELEVANCE VALIDATOR (client mirror of the edge-function rules) ──
// Generic, brand-agnostic. Strict numeric matching, ≥60% non-numeric token overlap.
function normalizeForRelevance(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeForRelevance(s: string): string[] {
  return normalizeForRelevance(s)
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter(t => t.length >= 2);
}

export interface RelevanceResult {
  isRelevant: boolean;
  score: number;
}

export function validateRelevance(query: string, title: string): RelevanceResult {
  const qTokens = tokenizeForRelevance(query);
  const tTokens = tokenizeForRelevance(title);
  if (qTokens.length === 0 || tTokens.length === 0) return { isRelevant: false, score: 0 };
  const tSet = new Set(tTokens);
  const qNumbers = qTokens.filter(t => /^\d+$/.test(t));
  const qWords = qTokens.filter(t => !/^\d+$/.test(t));
  // Strict numeric: instant fail if any query number missing.
  for (const n of qNumbers) if (!tSet.has(n)) return { isRelevant: false, score: 0 };
  let hits = 0;
  for (const w of qWords) if (tSet.has(w)) hits++;
  const totalHits = hits + qNumbers.length;
  const totalQ = qWords.length + qNumbers.length;
  const overlapPct = totalQ > 0 ? (totalHits / totalQ) * 100 : 0;
  const normQ = normalizeForRelevance(query).trim();
  const normT = normalizeForRelevance(title);
  const substringBonus = normQ.length > 0 && normT.includes(normQ) ? 20 : 0;
  const score = Math.min(100, Math.round(overlapPct + substringBonus));
  let isRelevant: boolean;
  if (qWords.length === 0) {
    isRelevant = qNumbers.length > 0;
  } else {
    const required = Math.max(1, Math.ceil(qWords.length * 0.6));
    isRelevant = hits >= required;
  }
  return { isRelevant, score };
}

export function clientFilterWithFallback(
  products: Product[], query: string
): { strict: Product[]; relaxed: Product[] } {
  const q = query.toLowerCase();
  // Cross-model protection: if the query does NOT mention these suffixes, drop
  // products whose title does. Prevents "iPhone 14" matching "iPhone 14 Mini",
  // "Samsung S24" matching "S24 FE", "MacBook Air" matching "MacBook Air Lite", etc.
  const variants = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'lite'] as const;
  const queryNumbers = q.match(/\d+/g) || [];
  const strict: Product[] = [];
  const relaxed: Product[] = [];

  for (const p of products) {
    const clone = deepCloneProduct(p);
    const bestPrice = Math.min(...clone.offers.map(o => o.price));
    if (bestPrice < 1500) continue;

    const nameLower = (clone.name.en + ' ' + clone.name.ar).toLowerCase();

    // Drop accessories — regex first (word-boundary case/cover), then phrase list.
    if (ACCESSORY_REGEX_CLIENT.test(nameLower)) continue;
    if (ACCESSORY_KEYWORDS_CLIENT.some(kw => nameLower.includes(kw))) continue;

    // GLOBAL RELEVANCE GATE — reject anything whose title doesn't match the query.
    const titleForRelevance = `${clone.name.en} ${clone.name.ar}`;
    const rel = validateRelevance(query, titleForRelevance);
    if (!rel.isRelevant) continue;
    // Take the higher of server-attached score vs client-recomputed score.
    if (rel.score > (clone.confidenceScore ?? 0)) clone.confidenceScore = rel.score;

    // Strict brand matching: drop cross-brand pollution
    let brandMismatch = false;
    for (const [brandKw, excluded] of Object.entries(BRAND_EXCLUSIONS)) {
      if (q.includes(brandKw) && excluded.some(bad => nameLower.includes(bad))) {
        brandMismatch = true; break;
      }
    }
    if (brandMismatch) continue;

    clone.offers = clone.offers.filter(o => {
      try {
        const hostname = new URL(o.url).hostname;
        return WHITELISTED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
      } catch { return false; }
    });
    if (clone.offers.length === 0) continue;

    const name = clone.name.en.toLowerCase();
    if (['restored', 'renewed', 'refurbished', 'مجدد'].some(w => name.includes(w) || clone.name.ar.includes(w))) {
      clone.isRefurbished = true;
    }

    const seen = new Set<string>();
    clone.offers = clone.offers.filter(o => {
      const key = `${o.store}|${o.price}|${o.url}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    let passesIntent = true;
    for (const v of variants) {
      // Word-boundary check on BOTH sides — substring matching causes false drops
      // (e.g. "fe" inside "feature", "mini" inside "aluminium").
      const re = new RegExp(`\\b${v}\\b`, 'i');
      if (!re.test(q) && re.test(name)) { passesIntent = false; break; }
    }
    if (passesIntent && queryNumbers.length > 0) {
      const nameNumbers: string[] = name.match(/\d+/g) || [];
      for (const qn of queryNumbers) {
        if (!nameNumbers.includes(qn)) { passesIntent = false; break; }
      }
    }

    if (passesIntent) { strict.push(clone); }
    else { clone.isVariant = true; relaxed.push(clone); }
  }
  return { strict, relaxed };
}

export function clientFilter(products: Product[], query: string): Product[] {
  return clientFilterWithFallback(products, query).strict;
}

function deepCloneProduct(p: Product): Product {
  return { ...p, name: { ...p.name }, specs: { ...p.specs }, offers: p.offers.map(o => ({ ...o })) };
}

// ════════════════════════════════════════════════════════════════════
// PRODUCT GROUPING
// ────────────────────────────────────────────────────────────────────
// Strict, production-safe grouping by (brand + model + storage).
// Color and RAM are intentionally ignored. Different storage tiers
// (128GB vs 256GB) ALWAYS render as separate cards. Offers without a
// detectable storage are grouped under a `nostorage` bucket UNLESS that
// bucket would mix with a known-storage bucket for the same model — in
// which case we split them apart (smart merge / split rule).
// ════════════════════════════════════════════════════════════════════

// ── Brand patterns ──
const BRAND_PATTERNS: Array<{ re: RegExp; brand: string }> = [
  { re: /\bapple\b|\biphone\b|\bipad\b|\bmacbook\b|\bairpods?\b/i, brand: 'apple' },
  { re: /\bsamsung\b|\bgalaxy\b/i, brand: 'samsung' },
  { re: /\bxiaomi\b|\bredmi\b|\bpoco\b/i, brand: 'xiaomi' },
  { re: /\bhuawei\b|\bhonor\b/i, brand: 'huawei' },
  { re: /\boppo\b/i, brand: 'oppo' },
  { re: /\bvivo\b/i, brand: 'vivo' },
  { re: /\brealme\b/i, brand: 'realme' },
  { re: /\binfinix\b/i, brand: 'infinix' },
  { re: /\btecno\b/i, brand: 'tecno' },
  { re: /\bsony\b|\bplaystation\b|\bps5\b|\bps4\b/i, brand: 'sony' },
  { re: /\bmicrosoft\b|\bxbox\b|\bsurface\b/i, brand: 'microsoft' },
  { re: /\bnintendo\b|\bswitch\b/i, brand: 'nintendo' },
  { re: /\bdell\b/i, brand: 'dell' },
  { re: /\bhp\b|\bhewlett\b/i, brand: 'hp' },
  { re: /\blenovo\b|\bthinkpad\b/i, brand: 'lenovo' },
  { re: /\basus\b|\brog\b/i, brand: 'asus' },
  { re: /\bacer\b/i, brand: 'acer' },
  { re: /\blg\b/i, brand: 'lg' },
];

// Pretty brand labels for the canonical product name.
const BRAND_LABELS: Record<string, string> = {
  apple: 'Apple', samsung: 'Samsung', xiaomi: 'Xiaomi', huawei: 'Huawei',
  oppo: 'OPPO', vivo: 'Vivo', realme: 'Realme', infinix: 'Infinix',
  tecno: 'Tecno', sony: 'Sony', microsoft: 'Microsoft', nintendo: 'Nintendo',
  dell: 'Dell', hp: 'HP', lenovo: 'Lenovo', asus: 'ASUS', acer: 'Acer', lg: 'LG',
};

// ── Pattern-based model extractors (priority order) ──
// Each returns a normalized model string (lowercase, brand kept) or null.
const MODEL_EXTRACTORS: Array<(raw: string) => string | null> = [
  // iPhone: "iphone 15 pro max", "iphone 15 pro", "iphone 15 plus", "iphone se"
  (raw) => {
    const m = raw.match(/iphone\s*(se|\d{1,2})\s*(pro\s*max|pro|plus|max|mini)?/i);
    if (!m) return null;
    const num = m[1].toLowerCase();
    const variant = m[2] ? ' ' + m[2].toLowerCase().replace(/\s+/g, ' ') : '';
    return `iphone ${num}${variant}`.trim();
  },
  // iPad: "ipad pro 11", "ipad air", "ipad mini 6"
  (raw) => {
    const m = raw.match(/ipad\s*(pro|air|mini)?\s*(\d{1,2})?/i);
    if (!m) return null;
    const variant = m[1] ? ' ' + m[1].toLowerCase() : '';
    const num = m[2] ? ' ' + m[2] : '';
    return `ipad${variant}${num}`.trim();
  },
  // MacBook: "macbook pro 14", "macbook air m2"
  (raw) => {
    const m = raw.match(/macbook\s*(pro|air)?\s*(\d{1,2})?\s*(m\d)?/i);
    if (!m) return null;
    const variant = m[1] ? ' ' + m[1].toLowerCase() : '';
    const size = m[2] ? ' ' + m[2] : '';
    const chip = m[3] ? ' ' + m[3].toLowerCase() : '';
    return `macbook${variant}${size}${chip}`.trim();
  },
  // Samsung Galaxy: "galaxy s24 ultra", "galaxy a54", "galaxy z fold 5", "galaxy note 20"
  (raw) => {
    const m = raw.match(/galaxy\s*(z\s*fold|z\s*flip|note|s|a|m|f|tab)\s*(\d{1,3})\s*(ultra|plus|fe|\+)?/i);
    if (!m) return null;
    const series = m[1].toLowerCase().replace(/\s+/g, ' ');
    const num = m[2];
    const variant = m[3] ? ' ' + m[3].toLowerCase().replace('+', 'plus') : '';
    return `galaxy ${series}${num}${variant}`.trim();
  },
  // Xiaomi Redmi / Mi / Poco: "redmi note 13 pro", "poco x6", "mi 11"
  (raw) => {
    const m = raw.match(/(redmi|poco|mi)\s*(note|k)?\s*(\d{1,3})\s*(pro\s*plus|pro|ultra|\+)?/i);
    if (!m) return null;
    const series = m[1].toLowerCase();
    const sub = m[2] ? ' ' + m[2].toLowerCase() : '';
    const num = m[3];
    const variant = m[4] ? ' ' + m[4].toLowerCase().replace('+', 'plus').replace(/\s+/g, ' ') : '';
    return `${series}${sub} ${num}${variant}`.trim();
  },
  // PlayStation / Xbox / Switch
  (raw) => {
    const m = raw.match(/\b(ps5|ps4|playstation\s*\d|xbox\s*(series\s*[xs]|one)|nintendo\s*switch(?:\s*oled|\s*lite)?)\b/i);
    return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
  },
];

interface NormalizedTitle {
  brand: string;        // e.g. "apple"
  model: string;        // e.g. "iphone 15 pro max" — brand-prefix kept where natural
  storage: string;      // e.g. "128gb" or "1tb" — empty if missing
  raw: string;          // cleaned lowercased title (for fallbacks)
}

export function normalizeTitle(title: string): NormalizedTitle {
  const raw = (title || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // ── Brand ──
  let brand = '';
  for (const { re, brand: b } of BRAND_PATTERNS) {
    if (re.test(raw)) { brand = b; break; }
  }

  // ── Storage ── pick LARGEST valid storage tier. RAM (< 32GB) is ignored.
  let storage = '';
  let bestGB = 0;
  for (const m of raw.matchAll(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/g)) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    const gb = unit === 'tb' ? n * 1024 : n;
    if (gb >= 32 && gb > bestGB) {
      bestGB = gb;
      storage = unit === 'tb' ? `${n}tb` : `${Math.round(n)}gb`;
    }
  }

  // ── Model ── pattern-first extraction; brand is intentionally kept.
  let model = '';
  for (const extract of MODEL_EXTRACTORS) {
    const m = extract(raw);
    if (m) { model = m; break; }
  }

  // Fallback: strip noise words and keep first 3-5 meaningful tokens. Brand stays.
  if (!model) {
    const cleaned = raw
      .replace(/\((.*?)\)/g, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/g, ' ')
      .replace(/\b\d+\s*(?:hz|w|mah|mp|inch|"|''|cm|mm)\b/g, ' ')
      .replace(/\b(black|white|blue|red|green|gold|silver|gray|grey|pink|purple|titanium|graphite|midnight|starlight|natural|space|rose|yellow|orange|أسود|أبيض|أزرق|أحمر|أخضر|ذهبي|فضي)\b/g, ' ')
      .replace(/\b(new|brand|original|sealed|unlocked|dual|sim|5g|4g|lte|wifi|with|and|the|for|smartphone|mobile|phone|laptop|tablet)\b/g, ' ')
      .replace(/[^\w\s\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    model = cleaned.split(' ').filter(Boolean).slice(0, 5).join(' ');
  }

  return { brand, model, storage, raw };
}

// ── Group key ──
// brand_model_storage  (or _nostorage when missing). The smart-split pass
// later removes the nostorage bucket if a known-storage bucket exists for
// the same brand+model.
function buildGroupKey(n: NormalizedTitle, fallbackId: string): string {
  if (!n.brand && !n.model) return `unknown_${fallbackId}`;
  const base = `${n.brand}_${n.model}`.replace(/\s+/g, '-');
  return n.storage ? `${base}_${n.storage}` : `${base}_nostorage`;
}

// ── Canonical product name ──
// "Apple iPhone 15 Pro Max 256GB" — capitalized brand, detected model, optional storage suffix.
export function buildCanonicalName(n: NormalizedTitle): string {
  const brandLabel = BRAND_LABELS[n.brand] || (n.brand ? n.brand.charAt(0).toUpperCase() + n.brand.slice(1) : '');
  // Title-case model tokens. Keep "M2", "Pro Max", "Ultra" naturally.
  const model = n.model
    .split(' ')
    .map(tok => tok.length <= 2 ? tok.toUpperCase() : tok.charAt(0).toUpperCase() + tok.slice(1))
    .join(' ');
  const storage = n.storage ? n.storage.toUpperCase() : '';

  // Avoid duplicating the brand if the model already starts with it (e.g. "iphone …" under apple).
  const modelLower = model.toLowerCase();
  const includesBrandWord = n.brand === 'apple'
    ? /^(iphone|ipad|macbook|airpods)\b/i.test(modelLower)
    : n.brand === 'samsung'
      ? /^galaxy\b/i.test(modelLower)
      : n.brand === 'sony'
        ? /^(playstation|ps\d|xbox)\b/i.test(modelLower)
        : false;
  const head = includesBrandWord ? `${brandLabel} ${model}` : [brandLabel, model].filter(Boolean).join(' ');
  return [head, storage].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ── Image picker ── stable, never tied to cheapest offer.
interface ProductWithMeta extends Product {
  _imagesByStore?: Record<string, string>;
  _norm?: NormalizedTitle;
}
function pickGroupImage(group: ProductWithMeta): string {
  if (group.image) return group.image;
  const map = group._imagesByStore || {};
  return map['Amazon Egypt'] || Object.values(map).find(Boolean) || '';
}

export function groupProducts(allProducts: RawProduct[]): Product[] {
  const grouped = new Map<string, ProductWithMeta>();

  // ── Pass 1: bucket by group key ──
  for (const p of allProducts) {
    if (!p.price || p.price <= 0) continue;
    const norm = normalizeTitle(p.name || '');
    const key = buildGroupKey(norm, p.url);

    let group = grouped.get(key);
    if (!group) {
      group = {
        id: crypto.randomUUID(),
        name: { en: '', ar: '' },
        specs: { en: p.specs || '', ar: p.specs || '' },
        image: '',
        category: 'electronics',
        offers: [],
        isRefurbished: p.isRefurbished || false,
        confidenceScore: p.confidenceScore ?? 0,
        storage: norm.storage ? norm.storage.toUpperCase() : '',
        _imagesByStore: {},
        _norm: norm,
      };
      grouped.set(key, group);
    }

    if (!group.offers.some(o => o.store === p.store && o.url === p.url)) {
      group.offers.push({ store: p.store, price: p.price, url: p.url, currency: 'EGP' });
    }
    if (p.image) {
      group._imagesByStore![p.store] = group._imagesByStore![p.store] || p.image;
    }
    if ((p.confidenceScore ?? 0) > (group.confidenceScore ?? 0)) {
      group.confidenceScore = p.confidenceScore;
    }
  }

  // ── Pass 2: smart split — drop the `_nostorage` bucket when a sibling
  // with the same brand+model has a known storage. We never silently merge
  // unknown into known, but we also avoid a permanent dangling "no storage"
  // bucket polluting the UI for already-resolved products.
  const knownStorageBases = new Set<string>();
  for (const key of grouped.keys()) {
    if (!key.endsWith('_nostorage') && !key.startsWith('unknown_')) {
      knownStorageBases.add(key.replace(/_[^_]+$/, ''));
    }
  }
  for (const key of Array.from(grouped.keys())) {
    if (key.endsWith('_nostorage')) {
      const base = key.replace(/_nostorage$/, '');
      if (knownStorageBases.has(base)) grouped.delete(key);
    }
  }

  // ── Pass 3: finalize each group ──
  return Array.from(grouped.values())
    .map(p => {
      p.image = pickGroupImage(p);
      const canonical = p._norm ? buildCanonicalName(p._norm) : '';
      if (canonical) {
        p.name = { en: canonical, ar: canonical };
      } else {
        // Fallback: use the longest offer title we saw — better than empty.
        const fallback = allProducts.find(rp => p.offers.some(o => o.url === rp.url))?.name || '';
        p.name = { en: fallback, ar: fallback };
      }
      delete p._imagesByStore;
      delete p._norm;
      p.offers.sort((a, b) => a.price - b.price);
      return p as Product;
    })
    .sort((a, b) => {
      const sa = a.confidenceScore ?? 0;
      const sb = b.confidenceScore ?? 0;
      if (sb !== sa) return sb - sa;
      return a.offers[0].price - b.offers[0].price;
    })
    .slice(0, 30);
}
