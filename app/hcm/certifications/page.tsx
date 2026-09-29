'use client';

import React from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import HcmShell, { partyKey, useHcm } from '../HcmShell';
import AgencyView from './AgencyView';
import StaffView from './StaffView';
import './certifications.css';

Amplify.configure(config);

function Certifications() {
  const { view, party, cycleAvailable, mock } = useHcm();
  if (view === 'agency' && party) return <AgencyView key={partyKey(party)} party={party} />;
  if (!cycleAvailable) {
    return <div className="hcm-empty"><p>Certifications have not been set up for {mock} yet.</p></div>;
  }
  return <StaffView />;
}

function HcmCertificationsPage() {
  return (
    <HcmShell title="Certifications" subtitle="The signed certification forms, the reported issues and the final signature of the cycle.">
      <Certifications />
    </HcmShell>
  );
}

export default withAuthenticator(HcmCertificationsPage);
