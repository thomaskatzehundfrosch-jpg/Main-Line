/**
 * Lichess OAuth2 PKCE authentication helper.
 * Public client — no client secret required.
 * https://lichess.org/api#tag/OAuth
 */

const LICHESS_HOST = 'https://lichess.org';
const CLIENT_ID = 'main-line';

const TOKEN_KEY = 'lichess_access_token';
const USERNAME_KEY = 'lichess_username';
const STATE_KEY = 'lichess_oauth_state';
const VERIFIER_KEY = 'lichess_oauth_verifier';

function randomBase64url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function sha256Base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Stored access token, or null if not logged in. */
export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Stored Lichess username, or null. */
export function getStoredUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

/** Remove credentials (logout). */
export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

/**
 * Start the OAuth2 PKCE flow — redirects to Lichess for authorisation.
 * Lichess will redirect back to the current page URL with ?code=...
 */
export async function startOAuthFlow(): Promise<void> {
  const state = randomBase64url(18);
  const verifier = randomBase64url(48);
  const challenge = await sha256Base64url(verifier);

  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const redirectUri = window.location.origin + window.location.pathname;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: '',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  window.location.href = `${LICHESS_HOST}/oauth?${params}`;
}

/**
 * If the current URL has ?code=..., exchange it for an access token.
 * Cleans the code/state params from the URL afterwards.
 * Returns true on success.
 */
export async function handleOAuthCallback(): Promise<boolean> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code) return false;

  const storedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);

  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  // Strip OAuth params from URL
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, '', url.toString());

  if (!verifier || returnedState !== storedState) {
    console.error('Lichess OAuth: state mismatch');
    return false;
  }

  const redirectUri = window.location.origin + window.location.pathname;

  const res = await fetch(`${LICHESS_HOST}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    console.error('Lichess token exchange failed:', res.status);
    return false;
  }

  const data = await res.json();
  localStorage.setItem(TOKEN_KEY, data.access_token);

  // Cache the username for display
  try {
    const userRes = await fetch(`${LICHESS_HOST}/api/account`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      localStorage.setItem(USERNAME_KEY, user.username);
    }
  } catch { /* non-fatal */ }

  return true;
}
