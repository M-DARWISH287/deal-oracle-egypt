import { useState } from 'react';
import { Search } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';

interface SearchBarProps {
  onSearch: (query: string) => void;
  large?: boolean;
  defaultValue?: string;
}

export function SearchBar({ onSearch, large = false, defaultValue = '' }: SearchBarProps) {
  const [query, setQuery] = useState(defaultValue);
  const { t, dir } = useLanguage();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-full">
      <div className={`ai-glow flex items-center gap-2 rounded-2xl bg-white border border-border shadow-sm overflow-hidden ${large ? 'px-4 sm:px-6 py-4 sm:py-5' : 'px-3 sm:px-4 py-2.5 sm:py-3'}`}>
        <button
          type="submit"
          aria-label={t('searchButton')}
          className="shrink-0 p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
        >
          <Search className={`${large ? 'h-5 w-5 sm:h-6 sm:w-6' : 'h-4 w-4 sm:h-5 sm:w-5'}`} />
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          dir={dir}
          enterKeyHint="search"
          className={`flex-1 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground text-foreground truncate ${large ? 'text-base sm:text-lg' : 'text-sm sm:text-base'}`}
        />
        <button
          type="submit"
          className="ai-glow-btn shrink-0 rounded-xl bg-foreground px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          {t('searchButton')}
        </button>
      </div>
    </form>
  );
}
