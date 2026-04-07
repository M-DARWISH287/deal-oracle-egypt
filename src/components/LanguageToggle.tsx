import { useLanguage } from '@/i18n/LanguageContext';
import { Globe } from 'lucide-react';

export function LanguageToggle() {
  const { lang, setLang, t } = useLanguage();

  const handleClick = () => {
    const newLang = lang === 'ar' ? 'en' : 'ar';
    document.title = `Switching to ${newLang} from ${lang}`;
    setLang(newLang);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="relative z-50 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary/50"
    >
      <Globe className="h-4 w-4" />
      <span>{t('language')}</span>
    </button>
  );
}
