import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ════════════════════════════════════════════════════════════════════
// URL SANITIZATION
// ────────────────────────────────────────────────────────────────────
// Strips tracking/session params, forces https, and rewrites Amazon
// product URLs to the canonical `/dp/ASIN` form so they cleanly trigger
// the native Amazon app via Universal Links on iOS/Android.
// Always falls back to the original string on parse failure — the
// streaming pipeline must never crash on a malformed scraper URL.
// ════════════════════════════════════════════════════════════════════

const TRACKING_PARAMS = new Set<string>([
  // Session / referral
  'session-id', 'session-id-time', 'session-token', 'sid', 'sessionid',
  'ref', 'ref_', 'refRID', 'ref_src', 'tag', 'linkCode', 'linkId',
  'creative', 'creativeasin', 'ascsubtag', 'asc_campaign', 'asc_refurl',
  'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m',
  'pd_rd_w', 'pd_rd_wg', 'pd_rd_r', 'pd_rd_i', 'content-id',
  'th', 'psc', 'smid', 'spIA', 'qid', 'sr', 'keywords', '_encoding',
  // UTM family
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_brand',
  // Click IDs
  'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', 'mc_eid', 'mc_cid',
  'igshid', 'ttclid', 'twclid',
  // Jumia / Noon / generic affiliate
  'src', 'source', 'campaign', 'aff', 'affiliate', 'aff_id', 'aff_sub',
  'tracker_id', 'click_id', 'sub_id', 'partner', 'partner_id',
]);

// Match an ASIN sitting after /dp/ or /product/ — Amazon embeds tracking
// segments AFTER the ASIN (e.g. `/dp/B0CQXYZ/ref=sr_1_1`) so we anchor on
// the marker and accept any trailing path/query.
const AMAZON_ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
// Strips path-embedded tracking like `/ref=sr_1_1`, `/ref=cm_sw_r_…` from
// any URL pathname. Amazon (and a few others) hide trackers in the path,
// not the query string.
const PATH_REF_RE = /\/ref=[^/?#]*/gi;

export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();

  try {
    // Force https:// — upgrade http and protocol-relative URLs.
    let normalized = trimmed;
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;
    else if (normalized.startsWith('http://')) normalized = `https://${normalized.slice(7)}`;
    else if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

    const url = new URL(normalized);
    url.protocol = 'https:';

    // Strip tracking params (case-insensitive on the key).
    const keysToDelete: string[] = [];
    url.searchParams.forEach((_, key) => {
      if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(k => url.searchParams.delete(k));

    // Amazon canonicalization → https://www.amazon.<tld>/dp/ASIN
    const host = url.hostname.toLowerCase();
    if (host.includes('amazon.')) {
      const asinMatch = url.pathname.match(AMAZON_ASIN_RE);
      if (asinMatch?.[1]) {
        // Force the canonical Egyptian Amazon storefront on /dp/ASIN.
        // Anything else (locale prefixes like /-/en/, slugs, /ref=… tails)
        // is discarded — this is the form that reliably triggers the
        // native Amazon app via Universal Links on iOS/Android.
        return `https://www.amazon.eg/dp/${asinMatch[1].toUpperCase()}`;
      }
      // No ASIN parseable — at least scrub /ref=… from the path so we
      // don't leak session trackers.
      url.pathname = url.pathname.replace(PATH_REF_RE, '');
    } else {
      // Generic fallback: strip /ref=… path segments on any host.
      url.pathname = url.pathname.replace(PATH_REF_RE, '');
    }

    // Drop a dangling "?" if all params were stripped.
    let out = url.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    // Malformed URL — return the raw string so the pipeline keeps moving.
    return trimmed;
  }
}
