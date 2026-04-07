export interface StoreOffer {
  store: string;
  storeLogo: string;
  price: number;
  url: string;
}

export interface Product {
  id: string;
  name: { ar: string; en: string };
  specs: { ar: string; en: string };
  image: string;
  category: string;
  offers: StoreOffer[];
}

const STORE_LOGOS: Record<string, string> = {
  'Amazon Egypt': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/200px-Amazon_logo.svg.png',
  'Noon': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Noon_logo.svg/200px-Noon_logo.svg.png',
  'B.TECH': 'https://btech.com/media/logo/stores/1/BTECH-LOGO.png',
  '2B': 'https://2b.com.eg/media/logo/stores/1/2b-logo.png',
  'Tradeline': 'https://tradeline.com.eg/skin/frontend/base/default/images/tradeline-logo.png',
};

export const storeLogos = STORE_LOGOS;

export const mockProducts: Product[] = [
  {
    id: '1',
    name: { ar: 'آيفون 15 برو ماكس 256 جيجا', en: 'iPhone 15 Pro Max 256GB' },
    specs: { ar: 'شاشة 6.7 بوصة - شريحة A17 Pro - كاميرا 48 ميجابيكسل', en: '6.7" Display - A17 Pro Chip - 48MP Camera' },
    image: 'https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/iphone-15-pro-max-blue-titanium-select?wid=400',
    category: 'phones',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 74999, url: 'https://www.amazon.eg/dp/iphone15promax' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 72499, url: 'https://www.noon.com/egypt-en/iphone-15-pro-max' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 76990, url: 'https://btech.com/iphone-15-pro-max' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 73500, url: 'https://2b.com.eg/iphone-15-pro-max' },
      { store: 'Tradeline', storeLogo: STORE_LOGOS['Tradeline'], price: 75999, url: 'https://tradeline.com.eg/iphone-15-pro-max' },
    ],
  },
  {
    id: '2',
    name: { ar: 'سامسونج جالكسي S24 الترا 256 جيجا', en: 'Samsung Galaxy S24 Ultra 256GB' },
    specs: { ar: 'شاشة 6.8 بوصة - معالج Snapdragon 8 Gen 3 - قلم S Pen', en: '6.8" Display - Snapdragon 8 Gen 3 - S Pen' },
    image: 'https://images.samsung.com/is/image/samsung/p6pim/eg/2401/gallery/eg-galaxy-s24-ultra-s928-sm-s928bztdmea-thumb-539573637?$172_172_PNG$',
    category: 'phones',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 62999, url: 'https://www.amazon.eg/dp/galaxys24ultra' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 59990, url: 'https://www.noon.com/egypt-en/galaxy-s24-ultra' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 64999, url: 'https://btech.com/galaxy-s24-ultra' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 61500, url: 'https://2b.com.eg/galaxy-s24-ultra' },
      { store: 'Tradeline', storeLogo: STORE_LOGOS['Tradeline'], price: 63499, url: 'https://tradeline.com.eg/galaxy-s24-ultra' },
    ],
  },
  {
    id: '3',
    name: { ar: 'ماك بوك إير M3 13 بوصة 256 جيجا', en: 'MacBook Air M3 13" 256GB' },
    specs: { ar: 'شريحة Apple M3 - رام 8 جيجا - شاشة Liquid Retina', en: 'Apple M3 Chip - 8GB RAM - Liquid Retina Display' },
    image: 'https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/mba13-midnight-select-202402?wid=400',
    category: 'laptops',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 54999, url: 'https://www.amazon.eg/dp/macbookairm3' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 56990, url: 'https://btech.com/macbook-air-m3' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 55500, url: 'https://2b.com.eg/macbook-air-m3' },
      { store: 'Tradeline', storeLogo: STORE_LOGOS['Tradeline'], price: 57999, url: 'https://tradeline.com.eg/macbook-air-m3' },
    ],
  },
  {
    id: '4',
    name: { ar: 'إيربودز برو 2 USB-C', en: 'AirPods Pro 2 USB-C' },
    specs: { ar: 'إلغاء ضوضاء نشط - صوت مكاني - مقاومة للعرق والماء', en: 'Active Noise Cancellation - Spatial Audio - Sweat & Water Resistant' },
    image: 'https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/MQD83?wid=400',
    category: 'audio',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 12499, url: 'https://www.amazon.eg/dp/airpodspro2' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 11990, url: 'https://www.noon.com/egypt-en/airpods-pro-2' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 13490, url: 'https://btech.com/airpods-pro-2' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 12200, url: 'https://2b.com.eg/airpods-pro-2' },
    ],
  },
  {
    id: '5',
    name: { ar: 'سامسونج جالكسي A54 128 جيجا', en: 'Samsung Galaxy A54 128GB' },
    specs: { ar: 'شاشة 6.4 بوصة Super AMOLED - كاميرا 50 ميجابيكسل - بطارية 5000mAh', en: '6.4" Super AMOLED - 50MP Camera - 5000mAh Battery' },
    image: 'https://images.samsung.com/is/image/samsung/p6pim/eg/sm-a546ezdhmea/gallery/eg-galaxy-a54-5g-sm-a546-sm-a546ezdhmea-thumb-535265498?$172_172_PNG$',
    category: 'phones',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 13999, url: 'https://www.amazon.eg/dp/galaxya54' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 12990, url: 'https://www.noon.com/egypt-en/galaxy-a54' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 14499, url: 'https://btech.com/galaxy-a54' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 13200, url: 'https://2b.com.eg/galaxy-a54' },
      { store: 'Tradeline', storeLogo: STORE_LOGOS['Tradeline'], price: 13800, url: 'https://tradeline.com.eg/galaxy-a54' },
    ],
  },
  {
    id: '6',
    name: { ar: 'آيباد إير M2 11 بوصة 128 جيجا', en: 'iPad Air M2 11" 128GB' },
    specs: { ar: 'شريحة M2 - شاشة Liquid Retina - دعم Apple Pencil Pro', en: 'M2 Chip - Liquid Retina Display - Apple Pencil Pro Support' },
    image: 'https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/ipad-air-select-wifi-blue-202403?wid=400',
    category: 'tablets',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 32999, url: 'https://www.amazon.eg/dp/ipadairm2' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 31500, url: 'https://www.noon.com/egypt-en/ipad-air-m2' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 34990, url: 'https://btech.com/ipad-air-m2' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 32500, url: 'https://2b.com.eg/ipad-air-m2' },
    ],
  },
  {
    id: '7',
    name: { ar: 'سوني WH-1000XM5 سماعات لاسلكية', en: 'Sony WH-1000XM5 Wireless Headphones' },
    specs: { ar: 'إلغاء ضوضاء رائد - 30 ساعة بطارية - صوت Hi-Res', en: 'Industry-leading ANC - 30hr Battery - Hi-Res Audio' },
    image: 'https://m.media-amazon.com/images/I/51aXvjzcukL._AC_SL1500_.jpg',
    category: 'audio',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 14999, url: 'https://www.amazon.eg/dp/sonyxm5' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 13990, url: 'https://www.noon.com/egypt-en/sony-wh-1000xm5' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 15490, url: 'https://btech.com/sony-wh-1000xm5' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 14500, url: 'https://2b.com.eg/sony-wh-1000xm5' },
    ],
  },
  {
    id: '8',
    name: { ar: 'لينوفو IdeaPad Slim 3 - رايزن 5', en: 'Lenovo IdeaPad Slim 3 - Ryzen 5' },
    specs: { ar: 'شاشة 15.6 بوصة FHD - رام 8 جيجا - SSD 512 جيجا', en: '15.6" FHD - 8GB RAM - 512GB SSD' },
    image: 'https://m.media-amazon.com/images/I/71jG+e7roXL._AC_SL1500_.jpg',
    category: 'laptops',
    offers: [
      { store: 'Amazon Egypt', storeLogo: STORE_LOGOS['Amazon Egypt'], price: 18999, url: 'https://www.amazon.eg/dp/ideapadslim3' },
      { store: 'Noon', storeLogo: STORE_LOGOS['Noon'], price: 17500, url: 'https://www.noon.com/egypt-en/ideapad-slim-3' },
      { store: 'B.TECH', storeLogo: STORE_LOGOS['B.TECH'], price: 19490, url: 'https://btech.com/ideapad-slim-3' },
      { store: '2B', storeLogo: STORE_LOGOS['2B'], price: 18200, url: 'https://2b.com.eg/ideapad-slim-3' },
      { store: 'Tradeline', storeLogo: STORE_LOGOS['Tradeline'], price: 18700, url: 'https://tradeline.com.eg/ideapad-slim-3' },
    ],
  },
];

export const trendingSearches = {
  ar: ['آيفون 15', 'سامسونج S24', 'ماك بوك', 'إيربودز', 'بلايستيشن 5', 'شاشة سامسونج', 'لابتوب ديل'],
  en: ['iPhone 15', 'Samsung S24', 'MacBook', 'AirPods', 'PlayStation 5', 'Samsung TV', 'Dell Laptop'],
};

export function searchProducts(query: string): Product[] {
  const q = query.toLowerCase();
  return mockProducts.filter(
    (p) =>
      p.name.ar.includes(query) ||
      p.name.en.toLowerCase().includes(q) ||
      p.specs.ar.includes(query) ||
      p.specs.en.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
  );
}
