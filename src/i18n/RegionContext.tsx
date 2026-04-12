import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { detectRegion, getRegion, getRegionByCode, type RegionConfig } from '@/lib/region';

interface RegionContextType {
  region: RegionConfig;
  setRegionCode: (code: string) => void;
}

const RegionContext = createContext<RegionContextType | null>(null);

export function RegionProvider({ children }: { children: ReactNode }) {
  const [region, setRegion] = useState<RegionConfig>(getRegion());

  useEffect(() => {
    detectRegion().then(setRegion);
  }, []);

  const setRegionCode = (code: string) => {
    setRegion(getRegionByCode(code));
  };

  return (
    <RegionContext.Provider value={{ region, setRegionCode }}>
      {children}
    </RegionContext.Provider>
  );
}

export function useRegion() {
  const ctx = useContext(RegionContext);
  if (!ctx) throw new Error('useRegion must be used within RegionProvider');
  return ctx;
}
