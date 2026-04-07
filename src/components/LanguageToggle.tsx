import { useLanguage } from '@/i18n/LanguageContext';
import { Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LanguageToggle() {
  const { lang, setLang, t } = useLanguage();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        console.log('TOGGLE CLICKED, current lang:', lang, 'switching to:', lang === 'ar' ? 'en' : 'ar');
        setLang(lang === 'ar' ? 'en' : 'ar');
      }}
      className="gap-2 text-muted-foreground hover:text-foreground"
    >
      <Globe className="h-4 w-4" />
      <span>{t('language')}</span>
    </Button>
  );
}
