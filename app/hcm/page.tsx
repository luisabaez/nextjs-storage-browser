'use client';

import React from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { fmtDateTime } from '../lib/symphony';
import HcmShell, { HcmParty, partyLabel, statusBadgeClass, useHcm } from './HcmShell';

Amplify.configure(config);

const icon = (...paths: string[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICONS = {
  files: icon('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'),
  certifications: icon('M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z', 'M8 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2', 'M9 13l2 2 4-4'),
  validations: icon('M4 6l1.5 1.5L8 5', 'M4 12l1.5 1.5L8 11', 'M4 18l1.5 1.5L8 17', 'M11 6h9', 'M11 12h9', 'M11 18h9'),
  guide: icon('M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'),
  log: icon('M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M10 5v14'),
  rules: icon('M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 5v4', 'M8 15v4'),
  recon: icon('M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'),
  publish: icon('M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'),
};

interface TileProps {
  href: string;
  title: string;
  text: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  external?: boolean;          // opens in a new tab
  disabled?: boolean;
}

function Tile({ href, title, text, icon: tileIcon, badge, external, disabled }: TileProps) {
  const inner = (
    <>
      <span className="hcm-tile-icon">{tileIcon}</span>
      <span className="hcm-tile-body">
        <span className="hcm-tile-title">{title}</span>
        <span className="hcm-tile-text">{text}</span>
      </span>
      {badge && <span className="hcm-tile-badge">{badge}</span>}
    </>
  );
  if (disabled) return <div className="hcm-tile hcm-tile-disabled" aria-disabled="true">{inner}</div>;
  if (external) return <a className="hcm-tile" href={href} target="_blank" rel="noopener noreferrer">{inner}</a>;
  return <Link className="hcm-tile" href={href}>{inner}</Link>;
}

const pendingOf = (p: HcmParty) => Math.max(0, (p.required ?? 0) - (p.certified ?? 0));
const awaitingOf = (p: HcmParty) => Math.max(0, (p.validations_reported ?? 0) - (p.validations_committed ?? 0));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function AgencyHome({ party }: { party: HcmParty }) {
  const pending = pendingOf(party);
  const awaiting = awaitingOf(party);
  const parts: string[] = [];
  if (party.required !== undefined) parts.push(`${party.certified ?? 0} of ${party.required} certifications completed`);
  if (party.validations_reported !== undefined) {
    parts.push(awaiting > 0
      ? `${plural(awaiting, 'validation', 'validations')} awaiting your path forward`
      : 'Every validation has a path forward');
  }
  parts.push(party.signed_off
    ? `Signed off by ${party.signed_off.name} on ${fmtDateTime(party.signed_off.at).slice(0, 10)}`
    : 'Final signature pending');

  return (
    <>
      <div className="hcm-summary">
        <span className="hcm-summary-party">{partyLabel(party)}</span>
        {party.status && <span className={statusBadgeClass(party.status)}>{party.status}</span>}
        <p className="hcm-summary-text">{parts.join(' · ')}</p>
      </div>
      <div className="hcm-tiles">
        <Tile href="/hcm/files" title="My Files" icon={ICONS.files}
          text="Open the files published for your agency, by module, file type and entity." />
        <Tile href="/hcm/certifications" title="Certifications" icon={ICONS.certifications}
          text="Certify each file you reviewed, report issues and sign the final certification."
          badge={party.required === undefined ? undefined : pending > 0
            ? <span className="sy-badge sy-badge-warn">{pending} pending</span>
            : <span className="sy-badge sy-badge-ok">Complete</span>} />
        <Tile href="/hcm/validations" title="Validations & Path Forward" icon={ICONS.validations}
          text="Review the validations found in your data and confirm the path forward for each one."
          badge={awaiting > 0 ? <span className="sy-badge sy-badge-warn">{awaiting} awaiting</span> : undefined} />
        <Tile href="/hcm/guide" title="User Guide" icon={ICONS.guide}
          text="Step-by-step instructions for this cycle." />
      </div>
    </>
  );
}

function StaffHome() {
  const { session, parties, cycleAvailable, isSuperUser, mock } = useHcm();
  const reconUrl = (session.config?.recon_tool_url || '').trim();
  const reconReady = /^https:\/\//i.test(reconUrl);
  const pending = parties.reduce((n, p) => n + pendingOf(p), 0);
  const withIssues = parties.reduce((n, p) => n + (p.with_issues ?? 0), 0);
  const signedOff = parties.filter(p => p.signed_off).length;

  return (
    <>
      {cycleAvailable ? (
        <div className="hcm-summary">
          <span className="hcm-summary-party">{mock}</span>
          <p className="hcm-summary-text">
            {[
              `${signedOff} of ${plural(parties.length, 'source and agency', 'sources and agencies')} signed off`,
              `${plural(pending, 'certification', 'certifications')} pending`,
              `${plural(withIssues, 'certification', 'certifications')} with reported issues`,
            ].join(' · ')}
          </p>
        </div>
      ) : (
        <div className="hcm-banner">Certifications have not been set up for {mock} yet, so there are no agencies to show for this cycle.</div>
      )}
      <div className="hcm-tiles">
        <Tile href="/hcm/files" title="Files by Source & Agency" icon={ICONS.files}
          text="Browse everything published to each source and agency." />
        <Tile href="/hcm/certifications" title="Certifications" icon={ICONS.certifications}
          text="Pending, completed and reported issues"
          badge={pending > 0 ? <span className="sy-badge sy-badge-warn">{pending} pending</span> : undefined} />
        <Tile href="/hcm/cleanse-log" title="Data Cleanse Log" icon={ICONS.log}
          text="Every validation reported in the cycle, by source and agency." />
        <Tile href="/hcm/rules" title="Validation Rules" icon={ICONS.rules}
          text="Messages, severity and path forward of each validation." />
        <Tile href={reconUrl} title="Recon Report Tools" icon={ICONS.recon} external disabled={!reconReady}
          text={reconReady ? 'Opens the reconciliation report tools in a new tab.' : 'Link not set up yet'} />
      </div>
      {/* Managing is for super users; reviewers keep a way to read the guide */}
      <h2 className="hcm-section">{isSuperUser ? 'Manage' : 'Reference'}</h2>
      <div className="hcm-tiles hcm-tiles-small">
        {isSuperUser && (
          <Tile href="/hcm/publish" title="Publish Files" icon={ICONS.publish}
            text="Send files to the agencies they belong to." />
        )}
        <Tile href="/hcm/guide" title="User Guides" icon={ICONS.guide}
          text={isSuperUser ? 'Add or replace the guide agencies see.' : 'The guide agencies see for this cycle.'} />
      </div>
    </>
  );
}

function Home() {
  const { view, party } = useHcm();
  return view === 'agency' && party ? <AgencyHome party={party} /> : <StaffHome />;
}

function HcmHomePage() {
  return (
    <HcmShell title="Welcome" subtitle="Choose what you want to do.">
      <Home />
    </HcmShell>
  );
}

export default withAuthenticator(HcmHomePage);
