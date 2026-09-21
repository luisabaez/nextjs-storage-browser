'use client';

// Certifications moved into the HCM portal.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function CertificationsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/hcm/certifications'); }, [router]);
  return null;
}
