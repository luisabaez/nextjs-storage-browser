'use client';

// Shared client for the pages that talk to the data-file-processor Lambda:
// one place for the URL, the response contract, the signed-in user's role and
// the configured Mock Cycle.
import { useCallback, useEffect, useState } from 'react';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { syncCurrentUserPermissions, UserRole } from '../admin/types';

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
        if (who) syncCurrentUserPermissions(who).catch(() => {});
      } catch {
        // not signed in yet — withAuthenticator handles it
      }
      await load(who);
      setReady(true);
    })();
  }, [load]);

  const role = (config?.role || '') as UserRole;
  const mocks = config ? Array.from(new Set([config.current_mock, ...config.available_mocks])) : [];
  return {
    email, role,
    isSuperUser: role === 'super_user',
    canCertify: role === 'super_user' || role === 'agency_user',
    canReview: role === 'super_user' || role === 'certification_reviewer',
    config, mock, setMock, mocks, ready, error,
    reloadConfig: () => load(email),
  };
}
