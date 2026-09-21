'use client';

// Shell of the HCM portal: brand, Mock Cycle (HCM cycles only), the source /
// agency the user works for, sign out, and "view as agency" for staff. Every
// page under app/hcm renders inside it and reads the context with useHcm():
//
//   function Inner() {
//     const { mock, party, view, email, canWrite } = useHcm();
//     ...
//   }
//   function FilesPage() {
//     return <HcmShell title="My Files" subtitle="One sentence about the page."><Inner /></HcmShell>;
//   }
//   export default withAuthenticator(FilesPage);
//
// The page keeps Amplify.configure(config) at module top. Inner renders only once
// the session and the parties of the selected cycle are loaded. staffOnly,
// superOnly and agencyOnly replace Inner with a short message when they do not match.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'aws-amplify/auth';
import '../lib/symphony.css';
import './hcm.css';
import { ApiResult, ROLE_LABEL, SymphonySession, apiGet, useSymphonySession } from '../lib/symphony';

export interface HcmParty {
  source: string;
  agency: string;              // '' = source level
  bu?: string;
  party?: string;
  required?: number;
  certified?: number;
  with_issues?: number;
  validations_reported?: number;
  validations_committed?: number;
  signed_off?: { name: string; title: string; by: string; at: string } | null;
  status?: string;             // Signed off | Ready to sign | In progress | Not started
}

export interface HcmContext {
  session: SymphonySession;
  email: string;
  mock: string;
  mocks: string[];             // HCM cycles only
  view: 'agency' | 'staff';
  party: HcmParty | null;      // the source / agency in agency view
  parties: HcmParty[];         // agency user: their own; staff: every party of the cycle
  partiesLoading: boolean;
  cycleAvailable: boolean;     // false when certifications are not set up for the cycle
  isSuperUser: boolean;
  isReviewer: boolean;
  canWrite: boolean;
  reloadParties: () => void;
}

interface CertExpected extends ApiResult { available?: boolean; parties?: HcmParty[] }

const Ctx = createContext<HcmContext | null>(null);

export function useHcm(): HcmContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useHcm() must be called inside <HcmShell>');
  return ctx;
}

/** Source + agency is the key of a party everywhere in the portal. */
export const partyKey = (p: { source: string; agency: string }) =>
  `${(p.source || '').trim()}|${(p.agency || '').trim()}`.toUpperCase();

/** "RHUM · 018 Junta De Planificacion"; a blank agency reads "RHUM · Source level". */
export function partyLabel(p: { source: string; agency: string; bu?: string; party?: string }): string {
  const source = (p.source || '').trim().toUpperCase();
  const agency = (p.agency || '').trim();
  if (!agency) return `${source} · Source level`;
  const given = (p.party || '').trim();
  if (given.includes(' · ')) return given;
  // The server names a party by its agency code; the BU carries the agency's name.
  const named = [given, (p.bu || '').trim()].find((v) => v.toUpperCase() !== source && /[A-Za-z]/.test(v));
  let name = (named || given || agency).replace(/^(\d{3,5})\s*[-–]\s*/, '$1 ');
  if (!/^\d/.test(name)) {
    const code = /^\d{3}/.test(agency) ? agency.slice(0, 3) : (p.bu || '').trim().slice(0, 3);
    if (code) name = `${code} ${name}`;
  }
  return `${source} · ${name}`;
}

/** Badge classes for a party status (Signed off, Ready to sign, In progress, Not started). */
export function statusBadgeClass(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s.startsWith('signed')) return 'sy-badge sy-badge-ok';
  if (s.startsWith('ready')) return 'sy-badge sy-badge-info';
  if (s.startsWith('in progress')) return 'sy-badge sy-badge-warn';
  return 'sy-badge';
}

export function formatSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The selections follow the user across portal pages for the browser session.
const MOCK_KEY = 'hcm.mock';
const PARTY_KEY = 'hcm.party';
const VIEW_AS_KEY = 'hcm.viewAs';

function stored(key: string): string {
  try { return window.sessionStorage.getItem(key) || ''; } catch { return ''; }
}
function store(key: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(key, value); else window.sessionStorage.removeItem(key);
  } catch {
    // storage unavailable: the selection simply lasts for this page
  }
}

export interface HcmShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  staffOnly?: boolean;         // validation team pages (staff view)
  agencyOnly?: boolean;        // pages that need one source / agency
  superOnly?: boolean;         // super users in staff view (publish, manage)
  wide?: boolean;              // full-width body for large tables
}

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" />
  </svg>
);

export default function HcmShell({ title, subtitle, children, staffOnly, agencyOnly, superOnly, wide }: HcmShellProps) {
  const session = useSymphonySession();
  const { email, role, ready, isAdmin } = session;
  const pathname = (usePathname() || '').replace(/\/+$/, '');
  const isHome = pathname === '/hcm';

  const allowed = isAdmin || !!role;
  const agencyUser = role === 'agency_user' && !isAdmin;
  const isSuperUser = isAdmin || role === 'super_user';
  const isReviewer = role === 'certification_reviewer' && !isAdmin;

  // Mock Cycle: HCM cycles only
  const mocks = useMemo(() => session.mocks.filter(m => /HCM/i.test(m)), [session.mocks]);
  const [mockChoice, setMockChoice] = useState(() => stored(MOCK_KEY));
  const configured = session.config?.current_mock || '';
  const mock = mocks.includes(mockChoice) ? mockChoice : mocks.includes(configured) ? configured : mocks[0] || '';
  const { mock: sessionMock, setMock: setSessionMock } = session;
  useEffect(() => {
    if (mock && sessionMock !== mock) setSessionMock(mock);
  }, [mock, sessionMock, setSessionMock]);
  const chooseMock = (m: string) => { setMockChoice(m); store(MOCK_KEY, m); };

  // Parties of the cycle. `loaded.mock` tells which cycle they belong to, so a
  // reload keeps the page on screen while a cycle change waits for its own data.
  const [loaded, setLoaded] = useState<{ mock: string; available: boolean; parties: HcmParty[]; error: string } | null>(null);
  const [partiesLoading, setPartiesLoading] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (!ready || !allowed || !mock || !email) return;
    const id = ++latest.current;
    setPartiesLoading(true);
    apiGet<CertExpected>('cert_expected', { mock, email }).then(d => {
      if (id !== latest.current) return;   // a newer selection is already loading
      const available = d.ok && d.available !== false;
      setLoaded({
        mock, available,
        parties: available && Array.isArray(d.parties) ? d.parties : [],
        error: d.ok ? '' : d.error || 'The certification setup could not be loaded',
      });
      setPartiesLoading(false);
    });
  }, [ready, allowed, mock, email, reloadCount]);
  const reloadParties = useCallback(() => setReloadCount(n => n + 1), []);

  const current = loaded && loaded.mock === mock ? loaded : null;
  const parties = useMemo(() => current?.parties ?? [], [current]);

  // Which source / agency is on screen
  const [ownParty, setOwnParty] = useState(() => stored(PARTY_KEY));
  const [viewAs, setViewAs] = useState(() => stored(VIEW_AS_KEY));
  const chooseOwnParty = (key: string) => { setOwnParty(key); store(PARTY_KEY, key); };
  const chooseViewAs = (key: string) => { setViewAs(key); store(VIEW_AS_KEY, key); };

  const party = useMemo(() => {
    if (agencyUser) return parties.find(p => partyKey(p) === ownParty) || parties[0] || null;
    return (viewAs && parties.find(p => partyKey(p) === viewAs)) || null;
  }, [agencyUser, parties, ownParty, viewAs]);
  const view: 'agency' | 'staff' = agencyUser || party ? 'agency' : 'staff';
  const viewingAs = !agencyUser && !!party;

  const value = useMemo<HcmContext>(() => ({
    session, email, mock, mocks, view, party, parties, partiesLoading,
    cycleAvailable: !!current?.available,
    isSuperUser, isReviewer,
    canWrite: isSuperUser || role === 'agency_user',
    reloadParties,
  }), [session, email, mock, mocks, view, party, parties, partiesLoading, current, isSuperUser, isReviewer, role, reloadParties]);

  if (!ready) return <div className="hcm-app"><main className="hcm-main"><p className="hcm-loading">Loading…</p></main></div>;

  if (!allowed) {
    return (
      <div className="hcm-app">
        <main className="hcm-main">
          <div className="hcm-message">
            <h2>HCM Data Validation</h2>
            {session.error
              ? <p>The portal could not be loaded right now. Please try again in a moment.</p>
              : <p>{email || 'This account'} does not have access yet. Please ask the validation team to set up your access, then sign in again.</p>}
            <div className="hcm-message-actions">
              {session.error && <button type="button" className="btn btn-primary" onClick={() => session.reloadConfig()}>Try again</button>}
              <button type="button" className="btn btn-secondary" onClick={() => signOut()}>Sign out</button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const message = (heading: string, text: string, exit?: boolean) => (
    <div className="hcm-message">
      <h2>{heading}</h2>
      <p>{text}</p>
      <div className="hcm-message-actions">
        {exit && <button type="button" className="btn btn-secondary" onClick={() => chooseViewAs('')}>Exit agency view</button>}
        {!isHome && <Link href="/hcm" className="btn btn-primary">Back to Home</Link>}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (!mock) {
    body = <div className="hcm-empty"><h2>No HCM cycle yet</h2><p>No HCM Mock Cycle has been set up yet.</p></div>;
  } else if (!current) {
    body = <p className="hcm-loading">Loading…</p>;
  } else if (superOnly && !isSuperUser) {
    body = message('This page is for super users', 'Your account can look at the portal but cannot manage it.');
  } else if ((staffOnly || superOnly) && agencyUser) {
    body = message('This page is for the validation team', 'Everything for your agency is on the home page.');
  } else if ((staffOnly || superOnly) && view === 'agency') {
    body = message('This page is not part of what an agency sees', 'Exit the agency view to open it.', true);
  } else if (agencyOnly && view === 'staff') {
    body = message('Choose an agency first', 'This page shows one source and agency at a time. Pick one under "View as agency" at the top of the page.');
  } else if (view === 'agency' && !party) {
    body = current.error ? (
      <div className="hcm-message">
        <h2>Your information could not be loaded</h2>
        <p>Please try again in a moment.</p>
        <div className="hcm-message-actions">
          <button type="button" className="btn btn-primary" disabled={partiesLoading} onClick={reloadParties}>Try again</button>
        </div>
      </div>
    ) : <div className="hcm-empty"><p>Nothing has been published for your agency in this cycle yet.</p></div>;
  } else {
    body = children;
  }

  return (
    <Ctx.Provider value={value}>
      <div className="hcm-app">
        <a className="hcm-skip" href="#hcm-main">Skip to content</a>
        <header className="hcm-header">
          <Link href="/hcm" className="hcm-brand">
            <span className="hcm-brand-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 12l2 2 4-4" /><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
              </svg>
            </span>
            <span>
              <span className="hcm-brand-name">Data Symphony</span>
              <span className="hcm-brand-sub">HCM Data Validation</span>
            </span>
          </Link>
          {!isHome && (
            <nav aria-label="Portal">
              <Link href="/hcm" className="hcm-nav-link"><HomeIcon />Home</Link>
            </nav>
          )}
          <div className="hcm-user">
            {isAdmin && <Link href="/" className="hcm-quiet-link">File Browser</Link>}
            <span className="hcm-user-email">{email}</span>
            <span className="sy-pill sy-pill-role">{role ? ROLE_LABEL[role] || role : 'Administrator'}</span>
            <button type="button" className="hcm-signout" onClick={() => signOut()}>Sign out</button>
          </div>
        </header>

        <section className="hcm-context" aria-label="Mock Cycle and agency">
          <label className="hcm-context-field">
            <span>Mock Cycle</span>
            <select value={mock} onChange={e => chooseMock(e.target.value)} disabled={mocks.length === 0}>
              {mocks.length === 0 && <option value="">None</option>}
              {mocks.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {agencyUser && parties.length > 1 && (
            <label className="hcm-context-field">
              <span>Source / Agency</span>
              <select value={party ? partyKey(party) : ''} onChange={e => chooseOwnParty(e.target.value)}>
                {parties.map(p => <option key={partyKey(p)} value={partyKey(p)}>{partyLabel(p)}</option>)}
              </select>
            </label>
          )}
          {agencyUser && parties.length === 1 && party && (
            <span className="hcm-context-field">Source / Agency <span className="hcm-context-value">{partyLabel(party)}</span></span>
          )}
          {!agencyUser && (
            <label className="hcm-context-field">
              <span>View as agency</span>
              <select value={party ? partyKey(party) : ''} onChange={e => chooseViewAs(e.target.value)}>
                <option value="">Staff view</option>
                {parties.map(p => <option key={partyKey(p)} value={partyKey(p)}>{partyLabel(p)}</option>)}
              </select>
            </label>
          )}
        </section>

        {viewingAs && party && (
          <div className="hcm-viewing" role="status">
            <span>Viewing as <strong>{partyLabel(party)}</strong> — what this agency sees</span>
            <button type="button" className="btn btn-secondary" onClick={() => chooseViewAs('')}>Exit</button>
          </div>
        )}

        <main id="hcm-main" className={`hcm-main${wide ? ' hcm-main-wide' : ''}`}>
          <div className="hcm-heading">
            <h1 className="hcm-title">{title}</h1>
            {subtitle && <p className="hcm-subtitle">{subtitle}</p>}
          </div>
          {session.error && <div className="sy-error">{session.error}</div>}
          {/* The server's own wording is for administrators; the validation team gets a plain sentence. */}
          {current?.error && !agencyUser && (
            <div className="sy-error">{isAdmin ? current.error : 'The certifications of this cycle could not be loaded. Please try again in a moment.'}</div>
          )}
          {body}
        </main>
      </div>
    </Ctx.Provider>
  );
}
