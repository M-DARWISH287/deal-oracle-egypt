import { useNavigate } from 'react-router-dom';
import { SearchBar } from '@/components/SearchBar';
import { LanguageToggle } from '@/components/LanguageToggle';
import { RegionSwitcher } from '@/components/RegionSwitcher';
import { UserMenu } from '@/components/UserMenu';
import { useLanguage } from '@/i18n/LanguageContext';
import { Sparkles, Zap } from 'lucide-react';

const trendingSearches = {
  ar: ['آيفون 15', 'سامسونج S24', 'ماك بوك', 'إيربودز', 'بلايستيشن 5', 'شاشة سامسونج', 'لابتوب ديل'],
  en: ['iPhone 15', 'Samsung S24', 'MacBook', 'AirPods', 'PlayStation 5', 'Samsung TV', 'Dell Laptop'],
};

const Index = () => {
  const navigate = useNavigate();
  const { lang, t } = useLanguage();

  const handleSearch = (query: string) => {
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="flex items-center justify-end gap-2 px-3 sm:px-4 py-3">
        <UserMenu />
        <RegionSwitcher />
        <LanguageToggle />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-3 sm:px-4 -mt-16">
        <div className="w-full max-w-2xl mx-auto text-center space-y-6 sm:space-y-8">
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center justify-center gap-2">
              <Zap className="h-7 w-7 sm:h-8 sm:w-8 text-purple-500" />
              <h1 className="text-3xl sm:text-5xl font-bold text-foreground">
                {t('brand')}
              </h1>
            </div>
            <p className="text-muted-foreground text-sm sm:text-lg px-2">{t('tagline')}</p>
          </div>

          <div className="animate-fade-in" style={{ animationDelay: '150ms' }}>
            <SearchBar onSearch={handleSearch} large />
          </div>

          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground animate-fade-in" style={{ animationDelay: '250ms' }}>
            <Sparkles className="h-3.5 w-3.5 text-purple-500" />
            {t('poweredByAI')}
          </div>

          <div className="space-y-3 animate-fade-in" style={{ animationDelay: '350ms' }}>
            <p className="text-sm text-muted-foreground">{t('trending')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2 px-2">
              {trendingSearches[lang].map((term) => (
                <button
                  key={term}
                  onClick={() => handleSearch(term)}
                  className="rounded-full border border-border bg-white px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-foreground/80 transition-all hover:bg-secondary hover:border-foreground/20 hover:shadow-sm"
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
