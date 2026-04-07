import { useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useLanguage } from '@/i18n/LanguageContext';

const trendingSearches = {
  ar: ['آيفون 15', 'سامسونج S24', 'ماك بوك', 'إيربودز', 'بلايستيشن 5', 'شاشة سامسونج', 'لابتوب ديل'],
  en: ['iPhone 15', 'Samsung S24', 'MacBook', 'AirPods', 'PlayStation 5', 'Samsung TV', 'Dell Laptop'],
};
import { Sparkles, Zap } from 'lucide-react';

const Index = () => {
  const navigate = useNavigate();
  const { lang, t } = useLanguage();

  const handleSearch = (query: string) => {
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div className="min-h-screen gradient-mesh flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3">
        <div />
        <LanguageToggle />
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 -mt-16">
        <div className="w-full max-w-2xl mx-auto text-center space-y-8">
          {/* Logo */}
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center justify-center gap-2">
              <Zap className="h-8 w-8 text-primary animate-pulse-glow" />
              <h1 className="text-4xl sm:text-5xl font-bold text-foreground glow-text">
                {t('brand')}
              </h1>
            </div>
            <p className="text-muted-foreground text-base sm:text-lg">{t('tagline')}</p>
          </div>

          {/* Search Bar */}
          <div className="animate-fade-in" style={{ animationDelay: '150ms' }}>
            <SearchBar onSearch={handleSearch} large />
          </div>

          {/* Powered by AI Badge */}
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground animate-fade-in" style={{ animationDelay: '250ms' }}>
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {t('poweredByAI')}
          </div>

          {/* Trending Searches */}
          <div className="space-y-3 animate-fade-in" style={{ animationDelay: '350ms' }}>
            <p className="text-sm text-muted-foreground">{t('trending')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {trendingSearches[lang].map((term) => (
                <button
                  key={term}
                  onClick={() => handleSearch(term)}
                  className="rounded-full border border-border bg-secondary/30 px-4 py-2 text-sm text-foreground/80 transition-all hover:bg-secondary/60 hover:border-primary/30 hover:shadow-md"
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
