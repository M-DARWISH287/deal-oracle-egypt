import { ALL_STORES } from '@/lib/api';
import { useLanguage } from '@/i18n/LanguageContext';

interface StoreSelectorProps {
  selectedStores: Set<string>;
  onToggle: (store: string) => void;
}

export function StoreSelector({ selectedStores, onToggle }: StoreSelectorProps) {
  const { lang } = useLanguage();

  return (
    <div className="w-full overflow-x-auto scrollbar-hide py-1">
      <div className="flex gap-2 min-w-max px-1">
        {ALL_STORES.map((store) => {
          const isSelected = selectedStores.has(store);
          return (
            <button
              key={store}
              onClick={() => onToggle(store)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium border transition-all duration-200 ${
                isSelected
                  ? 'bg-foreground text-white border-foreground shadow-sm'
                  : 'bg-white text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              {store}
            </button>
          );
        })}
      </div>
    </div>
  );
}
