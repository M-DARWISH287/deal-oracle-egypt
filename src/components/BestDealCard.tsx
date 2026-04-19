import { ExternalLink, Trophy, Tag } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product, StoreOffer } from '@/lib/api';

interface BestDealCardProps {
  product: Product;
  cheapestOffer: StoreOffer;
  priceComparison: StoreOffer[];
}

export function BestDealCard({ product, cheapestOffer, priceComparison }: BestDealCardProps) {
  const { lang, t } = useLanguage();
  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-EG');

  return (
    <section
      data-testid="best-deal-card"
      className="rounded-2xl bg-white border border-emerald-200 shadow-md p-4 sm:p-6 animate-fade-in"
    >
      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          <Trophy className="h-3.5 w-3.5" />
          {lang === 'ar' ? 'أفضل صفقة' : 'Best Deal'}
        </span>
        <span className="text-xs text-muted-foreground">
          {lang === 'ar' ? 'أرخص سعر عبر كل المتاجر' : 'Cheapest across all stores'}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
        <div className="shrink-0 flex items-center justify-center w-full sm:w-48 h-48 rounded-xl bg-secondary p-4 overflow-hidden">
          {product.image ? (
            <img
              src={product.image}
              alt={product.name[lang]}
              className="max-h-full max-w-full object-contain"
              loading="eager"
            />
          ) : (
            <Tag className="h-12 w-12 text-muted-foreground/30" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <h2 className="text-lg sm:text-2xl font-bold text-foreground mb-2 line-clamp-3 break-words">
            {product.name[lang]}
          </h2>

          <div className="flex items-baseline gap-2 mb-1 flex-wrap">
            <span className="text-3xl sm:text-4xl font-extrabold text-emerald-600">
              {fmt(cheapestOffer.price)}
            </span>
            <span className="text-base font-semibold text-emerald-600">{t('egp')}</span>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('from')} <span className="font-semibold text-foreground">{cheapestOffer.store}</span>
          </p>

          <a
            href={cheapestOffer.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-5 py-3 transition-colors w-full sm:w-auto sm:self-start"
          >
            {lang === 'ar' ? 'عرض المنتج' : 'View Product'}
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      {priceComparison.length > 1 && (
        <div className="mt-5 pt-4 border-t border-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {t('priceComparison')}
          </h3>
          <ul className="space-y-1.5">
            {priceComparison.map((offer, i) => (
              <li
                key={`${offer.store}-${offer.price}-${offer.url}`}
                className={`flex items-center justify-between gap-3 text-sm py-1.5 px-2 rounded-md ${
                  i === 0 ? 'bg-emerald-50' : ''
                }`}
              >
                <span className={`font-medium truncate ${i === 0 ? 'text-emerald-700' : 'text-foreground'}`}>
                  {offer.store}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`font-bold tabular-nums ${i === 0 ? 'text-emerald-700' : 'text-foreground'}`}>
                    {fmt(offer.price)} {t('egp')}
                  </span>
                  <a
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-600 hover:text-purple-700"
                    aria-label={`Open ${offer.store}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
