import type { Locale } from './i18n';

export function formatDate(date: Date | string, locale: Locale, opts?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const tag = locale === 'es' ? 'es-EC' : 'en-US';
  return new Intl.DateTimeFormat(tag, opts ?? { dateStyle: 'full' }).format(d);
}

export function weddingMoment(): Date {
  // 2027-03-13 15:00 in Ecuador (UTC-5, no DST)
  return new Date('2027-03-13T15:00:00-05:00');
}
