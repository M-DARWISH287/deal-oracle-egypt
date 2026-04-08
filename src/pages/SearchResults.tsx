import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useLanguage } from '@/i18n/LanguageContext';
import { searchStore, groupProducts, ALL_STORES, type RawProduct, type Product } from '@/lib/api';
import { Zap, Sparkles, SearchX, CheckCircle2, Loader2 } from 'lucide-react';

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const query = searchParams.get('q') || '';

  const [products, setProducts] = useState<Product[]>([]);
  const [pendingStores, setPendingStores] = useState<Set<string>>(new Set());
  const [completedStores, setCompletedStores] = useState<Map<string, { count: number; cached: boolean }>>(new Map());
  const [storeErrors, setStoreErrors] = useState<string[]>([]);
  const [hasStarted, setHasStarted] = useState(false);
  const allProductsRef = useRef<RawProduct[]>([]);
  const prevProductIdsRef = useRef<Set<string>>(new Set());

  const handleSearch = useCallback((newQuery: string) => {
    navigate(`/search?q=${encodeURIComponent(newQuery)}`);
  }, [navigate]);

  useEffect(() => {
    if (!query) return;

    // Reset state
    setProducts([]);
    setPendingStores(new Set(ALL_STORES));
    setCompletedStores(new Map());
    setStoreErrors([]);
    setHasStarted(true);
    allProductsRef.current = [];
    prevProductIdsRef.current = new Set();

    // Fire all store requests in parallel
    ALL_STORES.forEach((store) => {
      searchStore(query, store).then((result) => {
        if (result.success && result.products.length > 0) {
          allProductsRef.current = [...allProductsRef.current, ...result.products];
          const grouped = groupProducts(allProductsRef.current);
          setProducts(grouped);
          setCompletedStores(prev => new Map(prev).set(store, {
            count: result.products.length,
            cached: result.cached,
          }));
        } else {
          setCompletedStores(prev => new Map(prev).set(store, { count: 0, cached: false }));
          if (result.error) {
            setStoreErrors(prev => [...prev, `${store}: ${result.error}`]);
          }
        }
        setPendingStores(prev => {
          const next = new Set(prev);
          next.delete(store);
          return next;
        });
      });
    });
  }, [query]);

  const isLoading = pendingStores.size > 0;
  const totalStores = ALL_STORES.length;
  const doneStores = completedStores.size;

  return (
    <div className="min-h-screen gradient-mesh">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-4xl flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-1.5 shrink-0">
            <Zap className="h-5 w-5 text-primary" />
            <span className="text-lg font-bold text-foreground hidden sm:inline">{t('brand')}</span>
          </button>
          <div className="flex-1">
            <SearchBar onSearch={handleSearch} defaultValue={query} />
          </div>
          <LanguageToggle />
        </div>
      </header>

      {/* Results */}
      <main className="mx-auto max-w-4xl px-4 py-6 space-y-4">
        {/* Live progress indicator */}
        {hasStarted && (
          <div className="flex items-center gap-3 text-sm animate-fade-in">
            {isLoading ? (
              <>
                <div className="flex items-center gap-2 text-primary">
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
              <div className="flex items-center gap-2 text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                <span>{lang === 'ar' ? 'اكتمل البحث' : 'Search complete'}</span>
                <span className="text-muted-foreground">
                  · {products.length} {lang === 'ar' ? 'منتج' : 'products'}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Store status chips */}
        {hasStarted && (
          <div className="flex flex-wrap gap-1.5 animate-fade-in">
            {ALL_STORES.map((store) => {
              const done = completedStores.get(store);
              const isPending = pendingStores.has(store);
              return (
                <span
                  key={store}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-300 ${
                    isPending
                      ? 'bg-muted/50 text-muted-foreground animate-pulse'
                      : done && done.count > 0
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-muted/30 text-muted-foreground/50'
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

        {/* Product grid */}
        {products.length > 0 && (
          <div className="space-y-5">
            {products.map((product, i) => (
              <div key={product.id} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
                <ProductCard product={product} index={i} />
              </div>
            ))}
          </div>
        )}

        {/* Empty state - only show when done and no results */}
        {!isLoading && hasStarted && products.length === 0 && (
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
