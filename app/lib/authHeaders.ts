'use client';

import { fetchAuthSession } from 'aws-amplify/auth';

/**
 * The signed-in user's Cognito access token as a request header. The Lambdas
 * check it with Cognito and act as that user, whatever the request says.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = (await fetchAuthSession()).tokens?.accessToken?.toString();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
