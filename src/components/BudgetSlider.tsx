import { useMemo } from 'react';
import { Slider } from '@/components/ui/slider';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product } from '@/lib/api';

interface BudgetSliderProps {
  products: Product[];
  range: [number, number];
  onChange: (range: [number, number]) => void;
}

export function BudgetSlider({ products, range, onChange }: BudgetSliderProps) {
  const { lang } = useLanguage();

  const [globalMin, globalMax] = useMemo(() => {
    const prices = products.flatMap(p => p.offers.map(o => o.price));
    if (prices.length === 0) return [0, 100000];
    return [Math.floor(Math.min(...prices)), Math.ceil(Math.max(...prices))];
  }, [products]);

  if (products.length === 0 || globalMin === globalMax) return null;

  const fmt = (n: number) =>
    n.toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-EG');

  return (
    <div className="rounded-xl border border-border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">
          {lang === 'ar' ? 'الميزانية' : 'Budget'}
        </span>
        <span className="text-muted-foreground text-xs">
          {fmt(range[0])} – {fmt(range[1])} {lang === 'ar' ? 'ج.م' : 'EGP'}
        </span>
      </div>
      <Slider
        min={globalMin}
        max={globalMax}
        step={100}
        value={range}
        onValueChange={(v) => onChange(v as [number, number])}
        className="w-full"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{fmt(globalMin)}</span>
        <span>{fmt(globalMax)}</span>
      </div>
    </div>
  );
}
