import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { BudgetSlider } from '@/components/BudgetSlider';
import { SearchSkeleton } from '@/components/SearchSkeleton';
import { LanguageToggle } from '@/components/LanguageToggle';
import { RegionSwitcher } from '@/components/RegionSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { streamSearch, groupProducts, clientFilterWithFallback, type RawProduct, type Product } from '@/lib/api';
import { rankByBestValue, pickCheapestWinner } from '@/lib/decisionEngine';
import { BestDealCard } from '@/components/BestDealCard';
import { Zap, SearchX, CheckCircle2, Loader2, AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { sanitizeUrl } from '@/lib/utils';

// Stores the router actually scrapes (matches ROUTING_MATRIX in
// `supabase/functions/scrape-prices-router/index.ts`, excluding SKIP entries).
const ROUTER_STORES = [
  'El Shennawy',
  'Amazon Egypt',
  'Jumia',
  '2B Egypt',
  'Cairo Sales',
  'Raya Shop',
  'Tradeline',
  'Carrefour Egypt',
] as const;

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const query = searchParams.get('q') || '';

  const [products, setProducts] = useState<Product[]>([]);
  const [pendingStores, setPendingStores] = useState<Set<string>>(new Set());
  const [completedStores, setCompletedStores] = useState<Map<string, { count: number; cached: boolean; status: 'success' | 'empty' | 'blocked' | 'failed' }>>(new Map());
  const [hasStarted, setHasStarted] = useState(false);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 999999]);
  const [activeStores, setActiveStores] = useState<string[]>([]);
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const allProductsRef = useRef<RawProduct[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const handleSearch = useCallback((newQuery: string) => {
    navigate(`/search?q=${encodeURIComponent(newQuery)}`);
  }, [navigate]);

  const runSearch = useCallback((q: string, _forceRefresh: boolean) => {
    // Cancel any in-flight stream from a previous query.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const storesToSearch = [...ROUTER_STORES];
    setActiveStores(storesToSearch);
    setProducts([]);
    setCompletedStores(new Map());
    setHasStarted(true);
    allProductsRef.current = [];
    setPriceRange([0, 999999]);
    setPendingStores(new Set(storesToSearch));

    streamSearch(q, {
      signal: controller.signal,
      onLine: (line) => {
        const hasProducts = line.status === 'success' && line.products.length > 0;
        if (hasProducts) {
          // Sanitize every URL BEFORE it enters the aggregate state — strips
          // tracking/session params, forces https, and canonicalizes Amazon
          // links to /dp/ASIN so Universal Links open the native app.
          const sanitized = line.products.map(p => ({ ...p, url: sanitizeUrl(p.url) }));
          // Append, then re-group + re-sort the entire aggregate.
          allProductsRef.current = [...allProductsRef.current, ...sanitized];
          const grouped = groupProducts(allProductsRef.current);
          setProducts(grouped);
          const allPrices = grouped.flatMap(p => p.offers.map(o => o.price));
          if (allPrices.length > 0) {
            setPriceRange(prev => [
              Math.min(prev[0], Math.floor(Math.min(...allPrices))),
              Math.max(prev[1] === 999999 ? 0 : prev[1], Math.ceil(Math.max(...allPrices))),
            ]);
          }
        }

        const normalizedStatus: 'success' | 'empty' | 'blocked' | 'failed' =
          hasProducts
            ? 'success'
            : line.status === 'error' || line.status === 'failed'
              ? 'failed'
              : line.status === 'blocked'
                ? 'blocked'
                : 'empty';

        setCompletedStores(prev => new Map(prev).set(line.store, {
          count: line.products.length,
          cached: false,
          status: normalizedStatus,
        }));
        setPendingStores(prev => {
          const next = new Set(prev);
          next.delete(line.store);
          return next;
        });
      },
      onDone: ({ aborted, error }) => {
        if (aborted) return;
        if (error) console.error('[streamSearch] stream error:', error);
        // Mark any stragglers (timed out / never reported) as failed so the
        // UI doesn't show a stale "loading" chip forever.
        setPendingStores(prev => {
          if (prev.size === 0) return prev;
          setCompletedStores(c => {
            const next = new Map(c);
            for (const s of prev) {
              if (!next.has(s)) next.set(s, { count: 0, cached: false, status: 'failed' });
            }
            return next;
          });
          return new Set();
        });
      },
    });
  }, [user?.id]);

  // Cancel the stream if the user navigates away mid-search.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!query) return;
    runSearch(query, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const isLoading = pendingStores.size > 0;
  const totalStores = activeStores.length;
  const doneStores = completedStores.size;

  const { displayProducts, isRelaxed, availableStores, engineMeta, winner } = useMemo(() => {
    const { strict, relaxed } = clientFilterWithFallback(products, query);
    const base = strict.length > 0 ? strict : relaxed;
    const relaxedMode = strict.length === 0 && relaxed.length > 0;
    const priceFiltered = base.filter(p => {
      const best = Math.min(...p.offers.map(o => o.price));
      return best >= priceRange[0] && best <= priceRange[1];
    });
    const stores = Array.from(new Set(priceFiltered.flatMap(p => p.offers.map(o => o.store)))).sort();
    const filtered = storeFilter
      ? priceFiltered.filter(p => p.offers.some(o => o.store === storeFilter))
      : priceFiltered;
    // Decision Engine still computes Best-Value scoring for the "More results" list,
    // but the SINGLE hero card uses pure cheapest-wins per product spec.
    const ranked = rankByBestValue(filtered);
    const cheapest = pickCheapestWinner(filtered);
    return {
      displayProducts: ranked.products,
      isRelaxed: relaxedMode,
      availableStores: stores,
      engineMeta: ranked.scoringMeta,
      winner: cheapest,
    };
  }, [products, query, priceRange, storeFilter]);

  const sliderProducts = useMemo(() => {
    const { strict, relaxed } = clientFilterWithFallback(products, query);
    return strict.length > 0 ? strict : relaxed;
  }, [products, query]);

  useEffect(() => {
    if (sliderProducts.length > 0 && !isLoading) {
      const prices = sliderProducts.flatMap(p => p.offers.map(o => o.price));
      setPriceRange([Math.floor(Math.min(...prices)), Math.ceil(Math.max(...prices))]);
    }
  }, [sliderProducts.length, isLoading]);

  // Dev observability: log engine meta + winner pipeline trace.
  useEffect(() => {
    if (engineMeta && displayProducts.length > 0) {
      console.log('[BestValueEngine]', engineMeta);
      console.log('[CheapestWinner]', winner.pipelineTrace);
    }
  }, [engineMeta, displayProducts.length, winner.pipelineTrace]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-50 border-b border-border bg-white/90 backdrop-blur-lg">
        <div className="mx-auto max-w-4xl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-1.5 shrink-0">
            <Zap className="h-5 w-5 text-purple-500" />
            <span className="text-lg font-bold text-foreground hidden sm:inline">{t('brand')}</span>
          </button>
          <div className="flex-1 min-w-0">
            <SearchBar onSearch={handleSearch} defaultValue={query} />
          </div>
          <RegionSwitcher />
          <LanguageToggle />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-4 space-y-4">
        {hasStarted && (
          <div className="flex items-center justify-between gap-3 text-sm animate-fade-in">
            <div className="flex items-center gap-3 min-w-0">
              {isLoading ? (
                <>
                  <div className="flex items-center gap-2 text-purple-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="animate-pulse">
                      {lang === 'ar' ? 'جاري جلب أحدث العروض...' : 'Fetching live deals...'}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    ({doneStores}/{totalStores} {lang === 'ar' ? 'متجر' : 'stores'})
                  </span>
                </>
              ) : (
                <div className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{lang === 'ar' ? 'اكتمل البحث' : 'Search complete'}</span>
                  <span className="text-muted-foreground">
                    · {displayProducts.length} {lang === 'ar' ? 'منتج' : 'products'}
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={() => runSearch(query, true)}
              disabled={isLoading || !query}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
              title={lang === 'ar' ? 'تحديث وتجاهل الذاكرة المؤقتة' : 'Bypass cache and refetch'}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{lang === 'ar' ? 'تحديث' : 'Refresh'}</span>
            </button>
          </div>
        )}

        {/* Only show chips for dynamically selected stores */}
        {hasStarted && (
          <div className="flex flex-wrap gap-1.5 animate-fade-in">
            {activeStores.map((store) => {
              const done = completedStores.get(store);
              const isPending = pendingStores.has(store);
              const status = done?.status;
              const chipClass = isPending
                ? 'bg-purple-50 text-purple-400 animate-pulse'
                : status === 'success'
                  ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                  : status === 'blocked'
                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                    : status === 'failed'
                      ? 'bg-red-50 text-red-600 border border-red-200'
                      : 'bg-secondary text-muted-foreground/70 border border-border';
              const label = isPending
                ? store
                : status === 'blocked'
                  ? `${store} · ${lang === 'ar' ? 'محجوب' : 'Blocked'}`
                  : status === 'failed'
                    ? `${store} · ${lang === 'ar' ? 'فشل' : 'Failed'}`
                    : status === 'empty'
                      ? `${store} · ${lang === 'ar' ? 'لا نتائج' : 'No results'}`
                      : store;
              return (
                <span
                  key={store}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-300 ${chipClass}`}
                >
                  {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  {!isPending && status === 'success' && <CheckCircle2 className="h-3 w-3" />}
                  {!isPending && status === 'blocked' && <AlertTriangle className="h-3 w-3" />}
                  {!isPending && status === 'failed' && <AlertTriangle className="h-3 w-3" />}
                  {label}
                  {done?.cached && <span className="text-[10px] opacity-60">⚡</span>}
                </span>
              );
            })}
          </div>
        )}

        {isRelaxed && !isLoading && (
          <Alert className="border-amber-200 bg-amber-50 animate-fade-in">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 text-sm font-medium">
              {lang === 'ar'
                ? 'النسخة اللي بتدور عليها مش متاحة حالياً، بس دي نسخ مشابهة'
                : "The exact variant you searched for isn't available right now — here are similar options"}
            </AlertDescription>
          </Alert>
        )}

        {sliderProducts.length > 0 && !isLoading && (
          <BudgetSlider products={sliderProducts} range={priceRange} onChange={setPriceRange} />
        )}

        {!isLoading && availableStores.length > 1 && (
          <div data-testid="store-filter-pills" className="flex flex-wrap gap-1.5 animate-fade-in">
            <button
              onClick={() => setStoreFilter(null)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                storeFilter === null
                  ? 'bg-purple-600 text-white'
                  : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
              }`}
            >
              {lang === 'ar' ? 'كل المتاجر' : 'All stores'}
            </button>
            {availableStores.map((store) => (
              <button
                key={store}
                onClick={() => setStoreFilter(prev => prev === store ? null : store)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  storeFilter === store
                    ? 'bg-purple-600 text-white'
                    : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                }`}
              >
                {store}
              </button>
            ))}
          </div>
        )}

        {isLoading && displayProducts.length === 0 && (
          <div data-testid="search-skeleton">
            <SearchSkeleton />
          </div>
        )}

        {winner.bestProduct && winner.cheapestOffer && (
          <BestDealCard
            product={winner.bestProduct}
            cheapestOffer={winner.cheapestOffer}
            priceComparison={winner.priceComparison}
          />
        )}

        {winner.others.length > 0 && (
          <div className="space-y-3">
            <button
              onClick={() => setShowMore(v => !v)}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary transition-colors"
            >
              {showMore ? t('hideMoreResults') : `${t('moreResults')} (${winner.others.length})`}
              {showMore ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {showMore && (
              <div className="space-y-4 animate-fade-in">
                {displayProducts.slice(1).map((product, i) => (
                  <ProductCard key={product.id} product={product} index={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {!isLoading && hasStarted && displayProducts.length === 0 && (
          <div
            data-testid="empty-state"
            className="flex flex-col items-center justify-center py-20 text-center space-y-3 animate-fade-in"
          >
            <SearchX className="h-16 w-16 text-muted-foreground/30" />
            <p className="text-lg font-semibold text-foreground">
              {lang === 'ar'
                ? 'لم نتمكن من العثور على عروض لهذا المنتج'
                : "We couldn't find deals for this product"}
            </p>
            <p className="text-sm text-muted-foreground max-w-sm">
              {lang === 'ar'
                ? 'جرّب كلمات أبسط أو تحقق من الإملاء، واستخدم اسم المنتج بدلاً من رقم الموديل الكامل.'
                : 'Try simpler keywords or check spelling — use the product name instead of the full model code.'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default SearchResults;
