import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductCard } from '@/components/ProductCard';
import type { Product } from '@/lib/api';
import { calculateInstallment } from '@/lib/installments';

// Minimal LanguageContext mock — ProductCard only consumes `lang` + `t`.
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({
    lang: 'ar',
    t: (k: string) => {
      const map: Record<string, string> = {
        egp: 'ج.م',
        from: 'من',
        bestPrice: 'أفضل سعر',
        copyLink: 'نسخ الرابط',
        copied: 'تم النسخ',
        buy: 'شراء',
      };
      return map[k] ?? k;
    },
  }),
}));

const mockProduct: Product = {
  id: 'test-1',
  name: { ar: 'آيفون 15', en: 'iPhone 15' },
  specs: { ar: '128GB', en: '128GB' },
  image: 'https://example.com/iphone.jpg',
  category: 'electronics',
  offers: [
    { store: 'RayaShop', price: 12000, url: 'https://www.rayashop.com/iphone-15.html', currency: 'EGP' },
  ],
};

describe('calculateInstallment utility', () => {
  it('returns price / 12 for 0% interest', () => {
    expect(calculateInstallment(12000)).toBe(1000);
    expect(calculateInstallment(20000, 12, 0)).toBe(Math.round(20000 / 12));
  });
  it('returns 0 for invalid input', () => {
    expect(calculateInstallment(0)).toBe(0);
    expect(calculateInstallment(-100)).toBe(0);
    expect(calculateInstallment(NaN)).toBe(0);
    expect(calculateInstallment(1000, 0)).toBe(0);
  });
  it('handles non-zero APR via amortization', () => {
    // Sanity: monthly should be > price/months when interest > 0
    const m = calculateInstallment(12000, 12, 0.18);
    expect(m).toBeGreaterThan(1000);
  });
});

describe('ProductCard installment badge', () => {
  it('renders the 0%-interest installment badge with correct math (12000 → 1000 ج.م)', () => {
    render(<ProductCard product={mockProduct} index={0} />);
    const badge = screen.getByTestId('installment-badge');
    expect(badge).toBeInTheDocument();
    // Arabic locale: numerals may render as Arabic-Indic digits ("١٬٠٠٠") via toLocaleString('ar-EG').
    // Accept either Latin "1,000" or Arabic-Indic equivalent.
    const text = badge.textContent ?? '';
    const hasLatin = text.includes('1,000') || text.includes('1000');
    const hasArabicIndic = /[٠-٩]/.test(text) && /١[٬,]?٠٠٠/.test(text);
    expect(hasLatin || hasArabicIndic).toBe(true);
    // Always contains the EGP symbol and "month"
    expect(text).toMatch(/ج\.م/);
    expect(text).toMatch(/شهر/);
  });

  it('does not render the badge when price is 0', () => {
    const zeroProduct: Product = {
      ...mockProduct,
      offers: [{ store: 'X', price: 0, url: 'https://x.com', currency: 'EGP' }],
    };
    render(<ProductCard product={zeroProduct} index={0} />);
    expect(screen.queryByTestId('installment-badge')).not.toBeInTheDocument();
  });
});
