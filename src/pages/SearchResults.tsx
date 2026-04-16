import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { StoreSelector } from '@/components/StoreSelector';
import { ProductCard } from '@/components/ProductCard';
import { BudgetSlider } from '@/components/BudgetSlider';
import { LanguageToggle } from '@/components/LanguageToggle';
import { RegionSwitcher } from '@/components/RegionSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { searchStore, groupProducts, clientFilterWithFallback, ALL_STORES, type RawProduct, type Product } from '@/lib/api';
import { Zap, SearchX, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const query = searchParams.get('q') || '';

  const [products, setProducts] = useState<Product[]>([]);
  const [pendingStores, setPendingStores] = useState<Set<string>>(new Set());
  const [completedStores, setCompletedStores] = useState<Map<string, { count: number; cached: boolean }>>(new Map());
  const [hasStarted, setHasStarted] = useState(false);
  const [selectedStores, setSelectedStores] = useState<Set<string>>(new Set(ALL_STORES));
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 999999]);
  const allProductsRef = useRef<RawProduct[]>([]);

  const handleSearch = useCallback((newQuery: string) => {
    navigate(`/search?q=${encodeURIComponent(newQuery)}`);
  }, [navigate]);

  const toggleStore = useCallback((store: string) => {
    setSelectedStores(prev => {
      const next = new Set(prev);
      if (next.has(store)) next.delete(store);
      else next.add(store);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!query) return;

    setProducts([]);
    setCompletedStores(new Map());
    setHasStarted(true);
    allProductsRef.current = [];
    setPriceRange([0, 999999]);

    const storesToSearch = ALL_STORES.filter(s => selectedStores.has(s));
    setPendingStores(new Set(storesToSearch));

    storesToSearch.forEach((store) => {
      searchStore(query, store, user?.id).then((result) => {
        if (result.success && result.products.length > 0) {
          allProductsRef.current = [...allProductsRef.current, ...result.products];
          const grouped = groupProducts(allProductsRef.current);
          setProducts(grouped);
          const allPrices = grouped.flatMap(p => p.offers.map(o => o.price));
          if (allPrices.length > 0) {
            setPriceRange(prev => [
              Math.min(prev[0], Math.floor(Math.min(...allPrices))),
              Math.max(prev[1] === 999999 ? 0 : prev[1], Math.ceil(Math.max(...allPrices))),
            ]);
          }
          setCompletedStores(prev => new Map(prev).set(store, {
            count: result.products.length,
            cached: result.cached,
          }));
        } else {
          setCompletedStores(prev => new Map(prev).set(store, { count: 0, cached: false }));
        }
        setPendingStores(prev => {
          const next = new Set(prev);
          next.delete(store);
          return next;
        });
      });
    });
  }, [query, selectedStores]);

  const isLoading = pendingStores.size > 0;
  const totalStores = ALL_STORES.filter(s => selectedStores.has(s)).length;
  const doneStores = completedStores.size;

  const { displayProducts, isRelaxed } = useMemo(() => {
    const { strict, relaxed } = clientFilterWithFallback(products, query);
    const base = strict.length > 0 ? strict : relaxed;
    const relaxedMode = strict.length === 0 && relaxed.length > 0;
    const filtered = base.filter(p => {
      const best = Math.min(...p.offers.map(o => o.price));
      return best >= priceRange[0] && best <= priceRange[1];
    });
    return { displayProducts: filtered, isRelaxed: relaxedMode };
  }, [products, query, priceRange]);

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
        <StoreSelector selectedStores={selectedStores} onToggle={toggleStore} />

        {hasStarted && (
          <div className="flex items-center gap-3 text-sm animate-fade-in">
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
        )}

        {hasStarted && (
          <div className="flex flex-wrap gap-1.5 animate-fade-in">
            {ALL_STORES.filter(s => selectedStores.has(s)).map((store) => {
              const done = completedStores.get(store);
              const isPending = pendingStores.has(store);
              return (
                <span
                  key={store}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-300 ${
                    isPending
                      ? 'bg-purple-50 text-purple-400 animate-pulse'
                      : done && done.count > 0
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : 'bg-secondary text-muted-foreground/50'
                  }`}
                >
                  {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  {!isPending && done && done.count > 0 && <CheckCircle2 className="h-3 w-3" />}
                  {store}
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

        {displayProducts.length > 0 && (
          <div className="space-y-4">
            {displayProducts.map((product, i) => (
              <ProductCard key={product.id} product={product} index={i} />
            ))}
          </div>
        )}

        {!isLoading && hasStarted && displayProducts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-fade-in">
            <SearchX className="h-16 w-16 text-muted-foreground/30" />
            <p className="text-lg text-muted-foreground">{t('noResults')}</p>
          </div>
        )}
      </main>
    </div>
  );
};

export default SearchResults;
