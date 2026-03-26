/** Parámetros de tracking a eliminar en normalización de URLs */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "fbclid", "gclid", "msclkid", "twclid", "ttclid",
  "ref", "referral", "source", "mc_cid", "mc_eid",
  "_ga", "igshid", "s_cid",
]);

/**
 * Normaliza una URL para hashing consistente:
 * - Elimina tracking params
 * - Normaliza a https
 * - Elimina trailing slash del path
 * - Elimina fragmento (#)
 * - Lowercase
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    url.protocol = "https:";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.hash = "";
    return url.toString().toLowerCase();
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}
