'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// The Data Cleanse Log is part of the HCM portal now; old links land there.
export default function DataCleanseLogRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/hcm/cleanse-log');
  }, [router]);
  return null;
}
