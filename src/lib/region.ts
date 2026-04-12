export interface RegionConfig {
  code: string;
  name: string;
  currency: string;
  currencySymbol: string;
  domainSuffix: string; // e.g. ".eg" for Egypt
  locale: string;
}

const REGIONS: Record<string, RegionConfig> = {
  EG: {
    code: 'EG',
    name: 'Egypt',
    currency: 'EGP',
    currencySymbol: 'ج.م',
    domainSuffix: '.eg',
    locale: 'ar-EG',
  },
  SA: {
    code: 'SA',
    name: 'Saudi Arabia',
    currency: 'SAR',
    currencySymbol: 'ر.س',
    domainSuffix: '.sa',
    locale: 'ar-SA',
  },
  AE: {
    code: 'AE',
    name: 'UAE',
    currency: 'AED',
    currencySymbol: 'د.إ',
    domainSuffix: '.ae',
    locale: 'ar-AE',
  },
};

const DEFAULT_REGION = 'EG';

let cachedRegion: RegionConfig | null = null;

export async function detectRegion(): Promise<RegionConfig> {
  if (cachedRegion) return cachedRegion;

  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const code = (data.country_code || '').toUpperCase();
      if (REGIONS[code]) {
        cachedRegion = REGIONS[code];
        return cachedRegion;
      }
    }
  } catch {
    // Silently fall back to default
  }

  cachedRegion = REGIONS[DEFAULT_REGION];
  return cachedRegion;
}

export function getRegion(): RegionConfig {
  return cachedRegion || REGIONS[DEFAULT_REGION];
}

export function getRegionByCode(code: string): RegionConfig {
  return REGIONS[code.toUpperCase()] || REGIONS[DEFAULT_REGION];
}
