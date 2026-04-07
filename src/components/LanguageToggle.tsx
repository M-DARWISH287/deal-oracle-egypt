import { useLanguage } from '@/i18n/LanguageContext';
import { Globe } from 'lucide-react';

export function LanguageToggle() {
  const { lang, setLang, t } = useLanguage();

  return (
    <button
      type="button"
      onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
      className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary/50"
    >
      <Globe className="h-4 w-4" />
      <span>{t('language')}</span>
    </button>
  );
}
