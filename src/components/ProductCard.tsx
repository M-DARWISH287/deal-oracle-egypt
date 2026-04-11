import { useState } from 'react';
import { ExternalLink, Copy, Check, Tag, RefreshCw } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

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
      className="rounded-2xl bg-white border border-border p-5 shadow-sm hover:shadow-md transition-shadow opacity-0 animate-fade-in"
      style={{ animationDelay: `${index * 80}ms`, animationFillMode: 'forwards' }}
    >
      <div className="flex flex-col sm:flex-row gap-5">
        <div className="shrink-0 flex items-center justify-center w-full sm:w-36 h-36 rounded-xl bg-secondary p-3 overflow-hidden">
          <img
            src={product.image}
            alt={product.name[lang]}
            className="max-h-full max-w-full object-contain"
            loading="lazy"
          />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-bold text-foreground mb-1">
            {product.name[lang]}
            {product.isRefurbished && (
              <Badge className="ml-2 bg-orange-100 text-orange-700 border-orange-200 text-xs align-middle">
                <RefreshCw className="h-3 w-3 mr-1" />
                {lang === 'ar' ? 'مجدد' : 'Renewed'}
              </Badge>
            )}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">{product.specs[lang]}</p>

          <div className="flex items-center gap-2 mb-4">
            <span className="text-xl font-bold text-foreground">
              {formatPrice(bestPrice.price)} {t('egp')}
            </span>
            <span className="text-sm text-muted-foreground">
              {t('from')} {bestPrice.store}
            </span>
          </div>

          <div className="space-y-2">
            {sortedOffers.map((offer, i) => (
              <div
                key={offer.store}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  i === 0
                    ? 'bg-emerald-50 border border-emerald-200'
                    : 'bg-secondary hover:bg-secondary/80'
                }`}
              >
                {i === 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    <Tag className="h-2.5 w-2.5" />
                    {t('bestPrice')}
                  </span>
                )}
                <div className="shrink-0 w-16 h-8 flex items-center justify-center rounded bg-white px-1">
                  <img
                    src={STORE_LOGOS[offer.store] || ''}
                    alt={offer.store}
                    className="max-h-full max-w-full object-contain opacity-70"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-xs text-muted-foreground font-medium">${offer.store}</span>`;
                    }}
                  />
                </div>

                <span className={`font-bold flex-1 ${i === 0 ? 'text-emerald-600' : 'text-foreground'}`}>
                  {formatPrice(offer.price)} {t('egp')}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => copyLink(offer.url)}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white transition-colors"
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
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
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
