import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { SearchSkeleton } from '@/components/SearchSkeleton';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useLanguage } from '@/i18n/LanguageContext';
import { searchProducts, type Product } from '@/data/mockProducts';
import { Zap, Sparkles, SearchX } from 'lucide-react';

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const query = searchParams.get('q') || '';

  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<Product[]>([]);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    // Simulate AI search delay
    const timer = setTimeout(() => {
      setResults(searchProducts(query));
      setLoading(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [query]);

  const handleSearch = (newQuery: string) => {
    navigate(`/search?q=${encodeURIComponent(newQuery)}`);
  };

  return (
    <div className="min-h-screen gradient-mesh">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-4xl flex items-center gap-3 px-4 py-3">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 shrink-0"
          >
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
      <main className="mx-auto max-w-4xl px-4 py-6 space-y-6">
        {loading ? (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground animate-fade-in">
              <Sparkles className="h-4 w-4 text-primary animate-pulse-glow" />
              {t('searching')}
            </div>
            <SearchSkeleton />
          </>
        ) : results.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t('results')} · {results.length} {t('priceComparison')}
            </p>
            <div className="space-y-5">
              {results.map((product, i) => (
                <ProductCard key={product.id} product={product} index={i} />
              ))}
            </div>
          </>
        ) : (
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
