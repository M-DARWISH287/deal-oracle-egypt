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
    <form onSubmit={handleSubmit} className="w-full">
      <div className={`ai-glow flex items-center gap-3 rounded-2xl bg-white border border-border shadow-sm ${large ? 'px-6 py-5' : 'px-4 py-3'}`}>
        <Search className={`${large ? 'h-6 w-6' : 'h-5 w-5'} text-muted-foreground shrink-0`} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          dir={dir}
          className={`flex-1 bg-transparent outline-none placeholder:text-muted-foreground text-foreground ${large ? 'text-lg' : 'text-base'}`}
        />
        <button
          type="submit"
          className="ai-glow-btn shrink-0 rounded-xl bg-foreground px-5 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          {t('searchButton')}
        </button>
      </div>
    </form>
  );
}
