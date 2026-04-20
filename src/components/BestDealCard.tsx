import { ExternalLink, Trophy, Tag, TrendingDown, Info } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product, StoreOffer } from '@/lib/api';

interface BestDealCardProps {
  product: Product;
  cheapestOffer: StoreOffer;
  /** Pre-sorted ascending by price (cheapest first). */
  priceComparison: StoreOffer[];
}

export function BestDealCard({ product, cheapestOffer, priceComparison }: BestDealCardProps) {
  const { lang, t } = useLanguage();
  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-EG');

  // ── Savings: cheapest vs highest in the same group (most meaningful for the user). ──
  const cheapestPrice = cheapestOffer.price;
  const highestPrice = priceComparison.length > 1
    ? priceComparison[priceComparison.length - 1].price
    : cheapestPrice;
  const savings = Math.max(0, highestPrice - cheapestPrice);
  const savingsPercent = highestPrice > 0 ? Math.round((savings / highestPrice) * 100) : 0;
  const hasSavings = priceComparison.length > 1 && savings > 0;

  // ── Variant safety: warn only when comparing across different stores. ──
  const uniqueStores = new Set(priceComparison.map(o => o.store));
  const showVariantNotice = uniqueStores.size > 1;

  return (
    <section
      data-testid="best-deal-card"
      className="rounded-2xl bg-white border border-emerald-200 shadow-md p-4 sm:p-6 animate-fade-in"
    >
      <div className="flex items-center gap-2 mb-4 flex-wrap">
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
          <h2 className="text-lg sm:text-2xl font-bold text-foreground mb-1 line-clamp-3 break-words">
            {product.name[lang]}
          </h2>

          {showVariantNotice && (
            <p className="text-[11px] text-muted-foreground/80 mb-2 flex items-start gap-1 leading-snug">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                {lang === 'ar'
                  ? '*قد تختلف تفاصيل بسيطة مثل اللون أو الإصدار حسب المتجر'
                  : '*Minor specs (color/version) may vary by store'}
              </span>
            </p>
          )}

          <div className="flex items-baseline gap-2 mb-1 flex-wrap">
            <span className="text-3xl sm:text-4xl font-extrabold text-emerald-600">
              {fmt(cheapestPrice)}
            </span>
            <span className="text-base font-semibold text-emerald-600">{t('egp')}</span>
          </div>
          <p className="text-sm text-muted-foreground mb-2">
            {t('from')} <span className="font-semibold text-foreground">{cheapestOffer.store}</span>
          </p>

          {hasSavings && (
            <span
              data-testid="savings-badge"
              className="inline-flex items-center gap-1.5 self-start rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs font-bold text-emerald-700 mb-4 animate-fade-in"
            >
              <TrendingDown className="h-3.5 w-3.5" />
              {lang === 'ar'
                ? `وفّر ${fmt(savings)} جنيه (${savingsPercent}%)`
                : `Save ${fmt(savings)} EGP (${savingsPercent}%)`}
            </span>
          )}

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
            {priceComparison.map((offer, i) => {
              const isCheapest = i === 0;
              const diff = offer.price - cheapestPrice;
              return (
                <li key={`${offer.store}-${offer.price}-${offer.url}`}>
                  <a
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${offer.store} — ${fmt(offer.price)} ${t('egp')}`}
                    className={`group flex items-center justify-between gap-3 text-sm py-2 px-2 rounded-md transition-colors ${
                      isCheapest
                        ? 'bg-emerald-50 hover:bg-emerald-100'
                        : 'hover:bg-muted/60'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={`font-medium truncate ${
                          isCheapest ? 'text-emerald-700' : 'text-foreground'
                        }`}
                      >
                        {offer.store}
                      </span>
                      {isCheapest && (
                        <span className="shrink-0 rounded-full bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5 leading-none">
                          {lang === 'ar' ? 'الأرخص' : 'Cheapest'}
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`font-bold tabular-nums ${
                          isCheapest ? 'text-emerald-700' : 'text-foreground'
                        }`}
                      >
                        {fmt(offer.price)} {t('egp')}
                      </span>
                      {!isCheapest && diff > 0 && (
                        <span className="text-[11px] font-semibold tabular-nums text-rose-600">
                          +{fmt(diff)}
                        </span>
                      )}
                      <ExternalLink
                        className={`h-3.5 w-3.5 transition-colors ${
                          isCheapest
                            ? 'text-emerald-600'
                            : 'text-muted-foreground group-hover:text-foreground'
                        }`}
                      />
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
