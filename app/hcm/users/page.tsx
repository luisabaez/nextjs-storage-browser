'use client';

// Users & Permissions: the portal's super users invite the people who use the
// portal, choose their role and, for agency users, the sources and agencies
// they act for. Accounts are created, disabled and re-enabled by the user and
// permission service; administrators are managed on the Admin page.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, ROLE_LABEL, apiGet, fmtDateTime, usersGet, usersPost } from '../../lib/symphony';
import HcmShell, { partyLabel, useHcm } from '../HcmShell';
import './users.css';

Amplify.configure(config);

type Status = 'active' | 'invited' | 'removed' | 'no_access' | 'no_account';
interface PortalUser {
  email: string;
  name: string;
  role: string;
  parties: string[];
  status: Status;
  created?: string | null;
  updatedBy?: string;
  updatedAt?: string;
  invitedBy?: string;
  invitedAt?: string;
  manageable: boolean;
}
interface UserList extends ApiResult { users?: PortalUser[]; roles?: string[]; you?: string; isAdmin?: boolean }
interface Saved extends ApiResult { invited?: boolean; user?: PortalUser }
interface Party { source: string; agency: string; bu?: string; party?: string }
interface Parties extends ApiResult { parties?: Party[] }

const STATUS: Record<Status, { label: string; badge: string }> = {
  active: { label: 'Active', badge: 'sy-badge sy-badge-ok' },
  invited: { label: 'Invited, not signed in yet', badge: 'sy-badge sy-badge-info' },
  removed: { label: 'Removed', badge: 'sy-badge' },
  no_access: { label: 'Registered, no access', badge: 'sy-badge sy-badge-warn' },
  no_account: { label: 'No account', badge: 'sy-badge' },
};
const ROLE_HELP: Record<string, string> = {
  agency_user: 'Sees and certifies only the sources and agencies assigned below.',
  certification_reviewer: 'Sees every source and agency, read only.',
  super_user: 'The validation team: sees everything and manages users.',
};

const NOT_CHOSEN = '-';

/** The server's key of an assignment: SOURCE|agency number, blank agency for the source level. */
const keyOf = (p: { source: string; agency: string }) => {
  const agency = (p.agency || '').trim();
  const number = /^(\d{3})(?!\d)/.exec(agency);
  return `${(p.source || '').trim().toUpperCase()}|${number ? number[1] : agency.toUpperCase()}`;
};

function UserForm({ user, roles, parties, onSaved, onCancel }: {
  user: PortalUser | null;        // null: a new user
  roles: string[];
  parties: Party[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState(user?.role && roles.includes(user.role) ? user.role : 'agency_user');
  const [assigned, setAssigned] = useState<string[]>(user?.parties ?? []);
  const [source, setSource] = useState('');
  const [agency, setAgency] = useState(NOT_CHOSEN);    // '' is the source level
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => { first.current?.focus(); }, []);

  const labels = useMemo(() => new Map(parties.map(p => [keyOf(p), partyLabel(p)])), [parties]);
  const sources = useMemo(() => Array.from(new Set(parties.map(p => p.source.toUpperCase()))).sort(), [parties]);
  const agencies = parties.filter(p => p.source.toUpperCase() === source).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const isNew = !user || user.status === 'no_account';
  const needsParties = role === 'agency_user';

  const add = () => {
    if (!source || agency === NOT_CHOSEN) return;
    const key = `${source}|${agency}`;
    if (!assigned.includes(key)) setAssigned([...assigned, key]);
    setAgency(NOT_CHOSEN);
  };

  const why = !email.trim() ? 'Enter the e-mail address.'
    : !role ? 'Choose a role.'
      : needsParties && assigned.length === 0 ? 'Add at least one source / agency.' : '';

  const save = async () => {
    setSaving(true);
    setError('');
    const d = await usersPost<Saved>('portal_user_save', {
      email: email.trim(), name: name.trim(), role, parties: needsParties ? assigned : [], invite: isNew,
    });
    setSaving(false);
    if (!d.ok) {
      setError(d.error || 'The user could not be saved. Please try again in a moment.');
      return;
    }
    onSaved(d.invited
      ? `An invitation was e-mailed to ${email.trim()}. They sign in with the temporary password in it and choose their own.`
      : `${email.trim()} was saved.`);
  };

  return (
    <section className="hcm-card hus-form" aria-labelledby="hus-form-title">
      <h2 id="hus-form-title">{isNew ? 'Add a user' : user?.status === 'removed' || user?.status === 'no_access' ? `Give ${user.email} access` : `Change ${user?.email}`}</h2>
      <div className="sy-form-grid">
        <label className="sy-field">
          <span>E-mail address</span>
          <input ref={first} type="email" value={email} maxLength={200} disabled={!isNew || saving} autoComplete="off"
            onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="sy-field">
          <span>Full name</span>
          <input type="text" value={name} maxLength={200} disabled={saving} onChange={e => setName(e.target.value)} />
        </label>
        <label className="sy-field">
          <span>Role</span>
          <select value={role} disabled={saving} onChange={e => setRole(e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </select>
          {ROLE_HELP[role] && <small className="sy-muted">{ROLE_HELP[role]}</small>}
        </label>
      </div>

      {needsParties && (
        <fieldset className="hus-parties" disabled={saving}>
          <legend>Sources and agencies this person acts for</legend>
          {assigned.length === 0 ? <p className="sy-muted">None yet.</p> : (
            <ul className="hus-chips">
              {assigned.map(k => (
                <li key={k} className="hus-chip">
                  <span>{labels.get(k) || k.replace('|', ' · ') + (k.endsWith('|') ? 'Source level' : '')}</span>
                  <button type="button" className="sy-link" aria-label={`Remove ${labels.get(k) || k}`}
                    onClick={() => setAssigned(assigned.filter(x => x !== k))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="hus-add">
            <label className="sy-field">
              <span>Source</span>
              <select value={source} onChange={e => { setSource(e.target.value); setAgency(NOT_CHOSEN); }}>
                <option value="">Choose a source</option>
                {sources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="sy-field">
              <span>Agency</span>
              <select value={agency} disabled={!source} onChange={e => setAgency(e.target.value)}>
                <option value={NOT_CHOSEN}>Choose an agency</option>
                {agencies.map(p => {
                  const value = keyOf(p).split('|')[1];
                  return <option key={value || 'source'} value={value}>{value ? partyLabel(p).split(' · ').slice(1).join(' · ') : 'Source level (no agency)'}</option>;
                })}
              </select>
            </label>
            <button type="button" className="btn btn-secondary" disabled={!source || agency === NOT_CHOSEN} onClick={add}>Add</button>
          </div>
        </fieldset>
      )}

      {error && <div className="sy-error" role="alert">{error}</div>}
      <div className="hus-actions">
        {why && <span className="hus-why">{why}</span>}
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !!why} onClick={save}>
          {saving ? 'Saving…' : isNew ? 'Send invitation' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function Users() {
  const { mock, email } = useHcm();
  const [list, setList] = useState<UserList | null>(null);
  const [parties, setParties] = useState<Party[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<PortalUser | null | 'new'>(null);
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const d = await usersGet<UserList>('portal_users');
    if (id !== latest.current) return;
    setError(d.ok ? '' : d.error || 'The users could not be loaded');
    if (d.ok) setList(d);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiGet<Parties>('pub_parties', { mock, email }).then(d => { if (d.ok) setParties(d.parties ?? []); });
  }, [mock, email]);

  const labels = useMemo(() => new Map(parties.map(p => [keyOf(p), partyLabel(p)])), [parties]);
  const users = useMemo(() => list?.users ?? [], [list]);
  const shown = users.filter(u => (!roleFilter || u.role === roleFilter) && (!statusFilter || u.status === statusFilter)
    && (!search.trim() || [u.email, u.name, ...u.parties.map(k => labels.get(k) || k)].join(' ').toLowerCase().includes(search.trim().toLowerCase())));
  const countOf = (f: (u: PortalUser) => boolean) => users.filter(f).length;

  const act = async (u: PortalUser, action: 'portal_user_remove' | 'portal_user_resend', done: string) => {
    setBusy(u.email);
    setError('');
    setNotice('');
    const d = await usersPost<ApiResult>(action, { email: u.email });
    setBusy('');
    if (!d.ok) {
      setError(d.error || 'That did not work. Please try again in a moment.');
      return;
    }
    setNotice(done);
    load();
  };
  const remove = (u: PortalUser) => {
    if (!window.confirm(`Remove ${u.email}?\n\nThey can no longer sign in and lose their role and assignments. You can give them access again later.`)) return;
    act(u, 'portal_user_remove', `${u.email} was removed.`);
  };

  if (!list) return error ? <div className="sy-error">{error} <button type="button" className="sy-link" onClick={load}>Try again</button></div>
    : <p className="hcm-loading">Loading…</p>;
  return (
    <>
      <section className="sy-stats" aria-label="Users of the portal">
        <div className="sy-stat"><div className="sy-stat-num">{countOf(u => u.role === 'agency_user' && u.status !== 'removed')}</div><div className="sy-stat-label">Agency users</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{countOf(u => u.role === 'certification_reviewer' && u.status !== 'removed')}</div><div className="sy-stat-label">Certification reviewers</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{countOf(u => u.role === 'super_user' && u.status !== 'removed')}</div><div className="sy-stat-label">Super users</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{countOf(u => u.status === 'invited')}</div><div className="sy-stat-label">Invited, not signed in yet</div></div>
      </section>
      <p className="sy-muted small">
        Invitations are e-mailed by the sign-in service, which sends at most 50 e-mails a day. The person signs in with the temporary password in the e-mail and chooses their own.
        {!list.isAdmin && ' Super users are added by an administrator.'}
      </p>

      {error && <div className="sy-error" role="alert">{error}</div>}
      {notice && <div className="sy-success" role="status">{notice}</div>}

      {editing !== null ? (
        <UserForm key={editing === 'new' ? 'new' : editing.email} user={editing === 'new' ? null : editing}
          roles={list.roles ?? []} parties={parties}
          onCancel={() => setEditing(null)}
          onSaved={message => { setEditing(null); setNotice(message); load(); }} />
      ) : (
        <div className="hus-toolbar">
          <label className="sy-field">
            <span>Search</span>
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, e-mail, source or agency" />
          </label>
          <label className="sy-field">
            <span>Role</span>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              {['agency_user', 'certification_reviewer', 'super_user', ''].map(r => <option key={r || 'none'} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="sy-field">
            <span>Status</span>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              {(Object.keys(STATUS) as Status[]).map(s => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={() => { setNotice(''); setEditing('new'); }}>Add a user</button>
        </div>
      )}

      <div className="hcm-card sy-scroll">
        <table className="sy-table hus-table">
          <thead>
            <tr><th>User</th><th>Role</th><th>Sources and agencies</th><th>Status</th><th>Last change</th><th /></tr>
          </thead>
          <tbody>
            {shown.map(u => (
              <tr key={u.email}>
                <td>
                  <div className="hus-name">{u.name || u.email}</div>
                  {u.name && <div className="sy-muted small">{u.email}</div>}
                </td>
                <td>{u.role ? ROLE_LABEL[u.role] || u.role : '—'}</td>
                <td>
                  {u.role === 'agency_user'
                    ? (u.parties.length ? u.parties.map(k => <div key={k}>{labels.get(k) || k.replace('|', ' · ')}</div>) : '—')
                    : u.role ? <span className="sy-muted">All</span> : '—'}
                </td>
                <td><span className={STATUS[u.status].badge}>{STATUS[u.status].label}</span></td>
                <td className="small">{u.updatedAt ? `${fmtDateTime(u.updatedAt).slice(0, 16)}${u.updatedBy ? ` · ${u.updatedBy}` : ''}` : '—'}</td>
                <td>
                  {u.manageable ? (
                    <div className="hus-row-actions">
                      <button type="button" className="btn btn-secondary" disabled={busy === u.email || editing !== null}
                        onClick={() => { setNotice(''); setEditing(u); }}>
                        {u.status === 'removed' || u.status === 'no_access' ? 'Give access' : u.status === 'no_account' ? 'Invite' : 'Change'}
                      </button>
                      {u.status === 'invited' && (
                        <button type="button" className="btn btn-secondary" disabled={busy === u.email}
                          onClick={() => act(u, 'portal_user_resend', `The invitation was e-mailed again to ${u.email}.`)}>Resend invitation</button>
                      )}
                      {(u.status === 'active' || u.status === 'invited' || (u.status === 'no_account' && u.role)) && (
                        <button type="button" className="btn btn-secondary" disabled={busy === u.email} onClick={() => remove(u)}>Remove</button>
                      )}
                    </div>
                  ) : <span className="sy-muted small">{u.email === list.you ? 'You' : 'Managed by an administrator'}</span>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="sy-muted">No user matches the filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HcmUsersPage() {
  return (
    <HcmShell title="Users & Permissions" superOnly wide
      subtitle="Invite the people who use the portal, choose their role and the sources and agencies they act for.">
      <Users />
    </HcmShell>
  );
}

export default withAuthenticator(HcmUsersPage);
