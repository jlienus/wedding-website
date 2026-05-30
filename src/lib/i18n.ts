import en from '../i18n/en.json';
import es from '../i18n/es.json';

export type Locale = 'en' | 'es';
export const locales: Locale[] = ['en', 'es'];
export const defaultLocale: Locale = 'en';

const dictionaries = { en, es } as const;

export function getLocaleFromUrl(url: URL): Locale {
  const seg = url.pathname.split('/').filter(Boolean)[0];
  return seg === 'es' ? 'es' : 'en';
}

/** Lookup a dotted key like "nav.home" in the locale dictionary. Returns the key if missing. */
export function t(locale: Locale, key: string): string {
  const dict = dictionaries[locale] as Record<string, unknown>;
  const parts = key.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return key;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : key;
}

/** Build a localized href. For default locale, no prefix. For es, prefix /es. */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return locale === 'en' ? clean : `/es${clean === '/' ? '' : clean}`;
}
