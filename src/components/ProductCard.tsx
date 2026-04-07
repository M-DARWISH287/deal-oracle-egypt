import { useState } from 'react';
import { ExternalLink, Copy, Check, Tag } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import type { Product } from '@/lib/api';

const STORE_LOGOS: Record<string, string> = {
  'Amazon Egypt': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/200px-Amazon_logo.svg.png',
  'Noon': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Noon_logo.svg/200px-Noon_logo.svg.png',
  'B.TECH': 'https://btech.com/media/logo/stores/1/BTECH-LOGO.png',
  '2B': 'https://2b.com.eg/media/logo/stores/1/2b-logo.png',
  'Tradeline': 'https://tradeline.com.eg/skin/frontend/base/default/images/tradeline-logo.png',
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
      className="glow-border rounded-2xl bg-card p-5 opacity-0 animate-fade-in-stagger"
      style={{ animationDelay: `${index * 100}ms`, animationFillMode: 'forwards' }}
    >
      <div className="flex flex-col sm:flex-row gap-5">
        {/* Product Image */}
        <div className="shrink-0 flex items-center justify-center w-full sm:w-36 h-36 rounded-xl bg-secondary/50 p-3 overflow-hidden">
          <img
            src={product.image}
            alt={product.name[lang]}
            className="max-h-full max-w-full object-contain"
            loading="lazy"
          />
        </div>

        {/* Product Info */}
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-bold text-foreground mb-1">{product.name[lang]}</h3>
          <p className="text-sm text-muted-foreground mb-4">{product.specs[lang]}</p>

          {/* Best Price Badge */}
          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-neon-green/15 px-3 py-1 text-sm font-semibold text-neon-green">
              <Tag className="h-3.5 w-3.5" />
              {t('bestPrice')}
            </span>
            <span className="text-xl font-bold text-foreground">
              {formatPrice(bestPrice.price)} {t('egp')}
            </span>
            <span className="text-sm text-muted-foreground">
              {t('from')} {bestPrice.store}
            </span>
          </div>

          {/* Store Offers */}
          <div className="space-y-2">
            {sortedOffers.map((offer, i) => (
              <div
                key={offer.store}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  i === 0
                    ? 'bg-neon-green/5 border border-neon-green/20'
                    : 'bg-secondary/30 hover:bg-secondary/50'
                }`}
              >
                {/* Store Logo */}
                <div className="shrink-0 w-16 h-8 flex items-center justify-center rounded bg-foreground/5 px-1">
                  <img
                    src={offer.storeLogo}
                    alt={offer.store}
                    className="max-h-full max-w-full object-contain brightness-0 invert opacity-70"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-xs text-muted-foreground font-medium">${offer.store}</span>`;
                    }}
                  />
                </div>

                {/* Price */}
                <span className={`font-bold flex-1 ${i === 0 ? 'text-neon-green' : 'text-foreground'}`}>
                  {formatPrice(offer.price)} {t('egp')}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => copyLink(offer.url)}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                    title={t('copyLink')}
                  >
                    {copiedUrl === offer.url ? (
                      <Check className="h-3.5 w-3.5 text-neon-green" />
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
                        ? 'bg-neon-green/20 text-neon-green hover:bg-neon-green/30'
                        : 'bg-primary/15 text-primary hover:bg-primary/25'
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
