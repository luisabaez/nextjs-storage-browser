'use client';

import React, { useCallback, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiPost } from '../../lib/symphony';
import { HistoryTab, RulesList, RulesTab } from '../../config/RulesEditor';
import HcmShell, { useHcm } from '../HcmShell';

Amplify.configure(config);

type Tab = 'rules' | 'history';
interface SyncResult extends ApiResult { updated?: number }

const TABS: { id: Tab; label: string }[] = [
  { id: 'rules', label: 'Validation rules' },
  { id: 'history', label: 'Change history' },
];
// The rules list names its database; any other name is a test copy of the rules.
const MAIN_DATABASE = 'HACIENDA_ERP';

function Rules() {
  const { email, session } = useHcm();
  const [tab, setTab] = useState<Tab>('rules');
  const [dirty, setDirty] = useState(false);
  const [database, setDatabase] = useState('');
  const [version, setVersion] = useState(0);     // a new one reloads the rules after they were filled
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');

  const onLoaded = useCallback((list: RulesList) => setDatabase(list.db || ''), []);
  const testCopy = !!database && database.toUpperCase() !== MAIN_DATABASE;

  const switchTab = (id: Tab) => {
    if (id === tab) return;
    if (tab === 'rules' && dirty && !window.confirm('Leave the validation rules and discard the unsaved changes?')) return;
    setDirty(false);
    setTab(id);
  };

  const sync = async () => {
    if (!window.confirm(
      'Fill the empty path forward values from the main database?\n\nA path forward already entered here is kept.'
      + (dirty ? '\n\nThe unsaved changes to the open rule will be discarded.' : '')
    )) return;
    setSyncing(true);
    setSyncError('');
    setSyncNotice('');
    const d = await apiPost<SyncResult>('rules_sync', { actor: email });
    setSyncing(false);
    if (!d.ok) {
      setSyncError(d.error || 'The path forward values could not be copied');
      return;
    }
    const updated = d.updated ?? 0;
    setSyncNotice(updated === 0
      ? 'Nothing to fill: no rule with an empty path forward has one in the main database.'
      : `${updated.toLocaleString()} ${updated === 1 ? 'rule' : 'rules'} received the path forward from the main database.`);
    setDirty(false);
    setVersion(v => v + 1);
  };

  return (
    <>
      <nav className="sy-tabs" aria-label="Validation rules">
        {TABS.map(t => (
          <button key={t.id} type="button" className={`sy-tab${tab === t.id ? ' active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined} onClick={() => switchTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'rules' && (
        <RulesTab key={version} email={email} onDirtyChange={setDirty} onLoaded={onLoaded} showTechnical={session.isAdmin} />
      )}
      {tab === 'history' && <HistoryTab key={version} email={email} />}

      {session.isAdmin && testCopy && (
        <section className="hcm-card">
          <div className="hcm-card-head">
            <h2>Test copy of the rules</h2>
            <button type="button" className="btn btn-secondary" disabled={syncing} onClick={sync}>
              {syncing ? 'Copying…' : 'Fill empty path forward values from the main database'}
            </button>
          </div>
          <p className="sy-muted">
            These rules are the test copy in {database}. The validation team loads the path forward into the main database;
            this brings it across for the rules that have none here.
          </p>
          {syncError && <div className="sy-error" role="alert">{syncError}</div>}
          {syncNotice && <div className="sy-success" role="status">{syncNotice}</div>}
        </section>
      )}
    </>
  );
}

function HcmRulesPage() {
  return (
    <HcmShell title="Validation Rules" staffOnly wide
      subtitle="The message, severity and path forward of every validation. The rules are the same for every Mock Cycle.">
      <Rules />
    </HcmShell>
  );
}

export default withAuthenticator(HcmRulesPage);
