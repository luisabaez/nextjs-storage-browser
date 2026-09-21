'use client';

// Shared client for the pages that talk to the data-file-processor Lambda:
// one place for the URL, the response contract, the signed-in user's role and
// the configured Mock Cycle.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { getUserRole, isAdminUser, syncCurrentUserPermissions, UserRole } from '../admin/types';

export const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

export interface ApiResult { ok: boolean; error?: string }

function query(action: string, params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams({ action });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  return `${LAMBDA_URL}?${q.toString()}`;
}

/** GET ?action=…; always resolves to an object with `ok` (network errors included). */
export async function apiGet<T extends ApiResult>(
  action: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
): Promise<T> {
  try {
    return (await (await fetch(query(action, params))).json()) as T;
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` } as T;
  }
}

/** POST ?action=… with a JSON body; same contract as apiGet. */
export async function apiPost<T extends ApiResult>(action: string, body: Record<string, unknown>): Promise<T> {
  try {
    const resp = await fetch(query(action, {}), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await resp.json()) as T;
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` } as T;
  }
}

export interface AppConfig extends ApiResult {
  current_mock: string;
  default_mock: string;
  updated_by: string | null;
  updated_at: string | null;
  available_mocks: string[];
  history: { key: string; old: string | null; new: string | null; by: string | null; at: string | null }[];
  role: UserRole;
  is_admin?: boolean;
  portal_only?: boolean;       // has a role and is not an administrator: sees the HCM portal only
  parties?: { source: string; agency: string }[];   // agency users; agency '' = source level
  recon_tool_url?: string;
}

export const fetchAppConfig = (email?: string) => apiGet<AppConfig>('app_config_get', { email });

export const ROLE_LABEL: Record<string, string> = {
  super_user: 'Super User',
  agency_user: 'Agency User',
  certification_reviewer: 'Certification Review',
  '': 'No role assigned',
};

export const fmtDateTime = (iso: string | null | undefined) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');

export interface SymphonySession {
  email: string;
  role: UserRole;            // resolved on the server (isAdmin / bootstrap list => super_user)
  isSuperUser: boolean;
  canCertify: boolean;       // super_user or agency_user
  canReview: boolean;        // super_user or certification_reviewer
  isAdmin: boolean;          // developer / administrator: keeps the file browser and the processing screens
  portalOnly: boolean;       // every other user with a role works in the HCM portal only
  parties: { source: string; agency: string }[];
  config: AppConfig | null;
  mock: string;              // the mock the page is showing (starts at the configured cycle)
  setMock: (m: string) => void;
  mocks: string[];           // cycles that can be chosen
  ready: boolean;
  error: string;
  reloadConfig: () => Promise<void>;
}

/**
 * Signed-in user + role + configured Mock Cycle for a page. `mock` starts at
 * the configured current cycle; a page may let the user look at another one
 * with setMock without changing the configuration.
 */
export function useSymphonySession(): SymphonySession {
  const [email, setEmail] = useState('');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [mock, setMock] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (who: string) => {
    const cfg = await fetchAppConfig(who);
    if (!cfg.ok) {
      setError(cfg.error || 'Could not load the configuration');
    } else {
      setError('');
      setConfig(cfg);
      setMock(prev => prev || cfg.current_mock);
    }
  }, []);

  useEffect(() => {
    (async () => {
      let who = '';
      try {
        who = ((await fetchUserAttributes()).email || '').toLowerCase();
        setEmail(who);
      } catch {
        // not signed in yet — withAuthenticator handles it
      }
      // The cached permissions feed isAdminUser below, so they are in place before `ready`.
      await Promise.all([load(who), who ? syncCurrentUserPermissions(who).catch(() => null) : null]);
      setReady(true);
    })();
  }, [load]);

  const role = (config?.role || '') as UserRole;
  const mocks = useMemo(() => (config ? Array.from(new Set([config.current_mock, ...config.available_mocks])) : []), [config]);
  // Until the server sends is_admin / portal_only, work them out from the cached permissions.
  const cachedAdmin = useMemo(() => ready && isAdminUser(email), [ready, email]);
  const isAdmin = config?.is_admin ?? cachedAdmin;
  // When the configuration could not be read, the cached role still keeps a portal user out of the other screens.
  const cachedRole = useMemo(() => (ready && !config ? getUserRole(email) : ''), [ready, config, email]);
  const portalOnly = config?.portal_only ?? (!!(role || cachedRole) && !isAdmin);
  const parties = useMemo(() => config?.parties ?? [], [config]);
  const reloadConfig = useCallback(() => load(email), [load, email]);
  // One object per change, so a page can hand the session to a context or an effect.
  return useMemo(() => ({
    email, role,
    isSuperUser: role === 'super_user',
    canCertify: role === 'super_user' || role === 'agency_user',
    canReview: role === 'super_user' || role === 'certification_reviewer',
    isAdmin, portalOnly, parties,
    config, mock, setMock, mocks, ready, error, reloadConfig,
  }), [email, role, isAdmin, portalOnly, parties, config, mock, mocks, ready, error, reloadConfig]);
}

/**
 * Keeps portal-only users out of the file browser and the processing screens:
 * sends them to the HCM portal and returns true while that is pending, so the
 * page can render nothing meanwhile.
 */
export function usePortalGuard(session: SymphonySession): boolean {
  const router = useRouter();
  const redirecting = session.ready && session.portalOnly;
  useEffect(() => {
    if (redirecting) router.replace('/hcm');
  }, [redirecting, router]);
  return redirecting;
}
