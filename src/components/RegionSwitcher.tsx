import { useRegion } from '@/i18n/RegionContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const REGIONS = [
  { code: 'EG', flag: '🇪🇬', label: 'مصر' },
  { code: 'SA', flag: '🇸🇦', label: 'السعودية' },
  { code: 'AE', flag: '🇦🇪', label: 'الإمارات' },
];

export function RegionSwitcher() {
  const { region, setRegionCode } = useRegion();

  return (
    <Select value={region.code} onValueChange={setRegionCode}>
      <SelectTrigger className="h-8 w-auto min-w-0 gap-1 rounded-full border-border bg-white px-2.5 text-xs font-medium shadow-none">
        <SelectValue>
          {REGIONS.find(r => r.code === region.code)?.flag} {region.code}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-[120px]">
        {REGIONS.map(r => (
          <SelectItem key={r.code} value={r.code} className="text-xs">
            <span className="flex items-center gap-2">
              <span>{r.flag}</span>
              <span>{r.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
