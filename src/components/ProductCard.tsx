import { useState } from 'react';
import { ExternalLink, Copy, Check, Tag, RefreshCw, Repeat, CalendarClock } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { calculateInstallment } from '@/lib/installments';

const STORE_LOGOS: Record<string, string> = {
  'Amazon Egypt': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/200px-Amazon_logo.svg.png',
  'Noon': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Noon_logo.svg/200px-Noon_logo.svg.png',
  'B.TECH': 'https://btech.com/media/logo/stores/1/BTECH-LOGO.png',
  '2B Egypt': 'https://2b.com.eg/media/logo/stores/1/2b-logo.png',
  'Tradeline': 'https://tradeline.com.eg/skin/frontend/base/default/images/tradeline-logo.png',
  'Jumia': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Jumia_Logo.svg/200px-Jumia_Logo.svg.png',
};

interface ProductCardProps {
  product: Product;
  index: number;
}

export function ProductCard({ product, index }: ProductCardProps) {
  const { lang, t } = useLanguage();
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const sortedOffers = [...product.offers].sort((a, b) => a.price - b.price);
  const bestPrice = sortedOffers[0];

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const formatPrice = (price: number) =>
    price.toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-EG');

  return (
    <div
      className="rounded-2xl bg-white border border-border p-3 sm:p-5 shadow-sm hover:shadow-md transition-shadow opacity-0 animate-fade-in overflow-hidden"
      style={{ animationDelay: `${index * 80}ms`, animationFillMode: 'forwards' }}
    >
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-5">
        <div className="shrink-0 flex items-center justify-center w-full sm:w-36 h-32 sm:h-36 rounded-xl bg-secondary p-3 overflow-hidden">
          <img
            src={product.image}
            alt={product.name[lang]}
            className="max-h-full max-w-full object-contain"
            loading="lazy"
          />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg font-bold text-foreground mb-1 line-clamp-2 break-words">
            {product.name[lang]}
          </h3>

          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {product.isRefurbished && (
              <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-[10px] sm:text-xs">
                <RefreshCw className="h-3 w-3 mr-1" />
                {lang === 'ar' ? 'مجدد' : 'Renewed'}
              </Badge>
            )}
            {product.isVariant && (
              <Badge className="bg-amber-50 text-amber-600 border-amber-200 text-[10px] sm:text-xs">
                <Repeat className="h-3 w-3 mr-1" />
                {lang === 'ar' ? 'نسخة مشابهة' : 'Variant'}
              </Badge>
            )}
          </div>

          <p className="text-xs sm:text-sm text-muted-foreground mb-3 line-clamp-1 break-words">{product.specs[lang]}</p>

          <div className="flex flex-col gap-1.5 mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg sm:text-xl font-bold text-foreground">
                {formatPrice(bestPrice.price)} {t('egp')}
              </span>
              <span className="text-xs sm:text-sm text-muted-foreground truncate">
                {t('from')} {bestPrice.store}
              </span>
            </div>
            {bestPrice.price > 0 && (() => {
              const monthly = calculateInstallment(bestPrice.price, 12, 0);
              if (monthly <= 0) return null;
              return (
                <div
                  data-testid="installment-badge"
                  className="inline-flex items-center gap-1.5 self-start rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[11px] sm:text-xs font-semibold text-emerald-700"
                >
                  <CalendarClock className="h-3 w-3" />
                  {lang === 'ar'
                    ? `أو قسط من ${formatPrice(monthly)} ج.م / شهر`
                    : `Or from ${formatPrice(monthly)} EGP / month`}
                </div>
              );
            })()}
          </div>

          <div className="space-y-2">
            {sortedOffers.map((offer, i) => (
              <div
                key={`${offer.store}-${offer.price}-${offer.url}`}
                className={`flex items-center gap-2 sm:gap-3 rounded-xl px-2.5 sm:px-3 py-2 sm:py-2.5 transition-colors ${
                  i === 0
                    ? 'bg-emerald-50 border border-emerald-200'
                    : 'bg-secondary hover:bg-secondary/80'
                }`}
              >
                {i === 0 && (
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 shrink-0">
                    <Tag className="h-2.5 w-2.5" />
                    {t('bestPrice')}
                  </span>
                )}
                <div className="shrink-0 w-12 sm:w-16 h-6 sm:h-8 flex items-center justify-center rounded bg-white px-1 overflow-hidden">
                  <img
                    src={STORE_LOGOS[offer.store] || ''}
                    alt={offer.store}
                    className="max-h-full max-w-full object-contain opacity-70"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-[10px] sm:text-xs text-muted-foreground font-medium truncate">${offer.store}</span>`;
                    }}
                  />
                </div>

                <span className={`font-bold text-sm sm:text-base flex-1 min-w-0 truncate ${i === 0 ? 'text-emerald-600' : 'text-foreground'}`}>
                  {formatPrice(offer.price)} {t('egp')}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => copyLink(offer.url)}
                    className="inline-flex items-center gap-1 rounded-lg px-1.5 sm:px-2.5 py-1 sm:py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white transition-colors"
                    title={t('copyLink')}
                  >
                    {copiedUrl === offer.url ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">{copiedUrl === offer.url ? t('copied') : t('copyLink')}</span>
                  </button>
                  <a
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-xs font-semibold transition-colors ${
                      i === 0
                        ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                        : 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                    }`}
                  >
                    {t('buy')}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}