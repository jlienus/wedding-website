// Application Insights wrapper for the wedding site frontend.
// Initialized once from Base.astro with the connection string baked in at
// build time (PUBLIC_APPINSIGHTS_CONNECTION_STRING). Exposes a tiny global
// `window.appTelemetry` surface so inline component scripts can fire named
// events without importing this module directly.
//
// Connection strings are NOT secrets — they identify the AI resource for
// ingestion and are designed to be visible in client-side JS. Anyone can
// post telemetry to them (Azure rate-limits), but nobody can read your data
// without auth on the AI resource itself.

import { ApplicationInsights } from '@microsoft/applicationinsights-web';

type EventProps = Record<string, string | number | boolean | null | undefined>;

interface AppTelemetry {
  trackEvent(name: string, properties?: EventProps): void;
  trackException(error: unknown, properties?: EventProps): void;
  setAuthenticatedUser(userId: string): void;
  clearAuthenticatedUser(): void;
}

declare global {
  interface Window {
    appTelemetry?: AppTelemetry;
  }
}

let ai: ApplicationInsights | null = null;

function sanitizeProps(props?: EventProps): Record<string, string> | undefined {
  if (!props) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function initTelemetry(connectionString: string): void {
  if (!connectionString || ai) return;
  try {
    ai = new ApplicationInsights({
      config: {
        connectionString,
        enableAutoRouteTracking: true,
        autoTrackPageVisitTime: true,
        disableFetchTracking: false,
        enableAjaxErrorStatusText: true,
        enableCorsCorrelation: false,
        disableExceptionTracking: false,
        // Don't capture full referrer if it contains tokens
        disableInstrumentationKeyValidation: false,
        // Privacy: cookies for anon session correlation only
        cookieCfg: { enabled: true },
      },
    });
    ai.loadAppInsights();
    ai.trackPageView();
  } catch (err) {
    // Don't let telemetry init break the page
    console.warn('[telemetry] init failed', err);
    ai = null;
    return;
  }

  const api: AppTelemetry = {
    trackEvent(name, properties) {
      if (!ai || !name) return;
      try {
        ai.trackEvent({ name }, sanitizeProps(properties));
      } catch {}
    },
    trackException(error, properties) {
      if (!ai) return;
      try {
        const e = error instanceof Error ? error : new Error(String(error));
        ai.trackException({ exception: e }, sanitizeProps(properties));
      } catch {}
    },
    setAuthenticatedUser(userId) {
      if (!ai || !userId) return;
      try {
        ai.setAuthenticatedUserContext(userId, undefined, true);
      } catch {}
    },
    clearAuthenticatedUser() {
      if (!ai) return;
      try {
        ai.clearAuthenticatedUserContext();
      } catch {}
    },
  };

  window.appTelemetry = api;

  // Auto-track unhandled errors (the SDK also does this, but belt + suspenders)
  window.addEventListener('error', (e) => {
    try {
      ai?.trackException({ exception: e.error ?? new Error(e.message) });
    } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      ai?.trackException({ exception: reason });
    } catch {}
  });
}
