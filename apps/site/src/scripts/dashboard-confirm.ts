/**
 * The link of the dashboard message, turned into a session of this tab.
 *
 * The token comes out of `location.hash`, goes to the API once, and the fragment is removed from
 * the address bar before anything else happens, so a reload, a bookmark or a shared screen does
 * not carry it. The session goes into `sessionStorage` and nowhere else.
 */
import { SESSION_STORAGE_KEY } from './dashboard-session';

const root = document.getElementById('dashboard-confirm');
const status = document.getElementById('confirm-status');
const again = document.getElementById('confirm-again');

function fail(text: string): void {
  if (status !== null) status.textContent = text;
  if (again !== null) again.hidden = false;
}

async function confirm(apiUrl: string, token: string, upgrade: string | null): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/dashboard/login/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    fail('The API could not be reached. Try the link again in a minute.');
    return;
  }
  const body = (await response.json().catch(() => ({}))) as {
    session_token?: string;
    expires_at?: string;
    error?: { code?: string; message?: string };
  };
  if (response.status === 200 && body.session_token !== undefined) {
    try {
      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ token: body.session_token, expires_at: body.expires_at ?? '' }),
      );
    } catch {
      fail('This browser refused to keep the session for this tab. Allow site data and try again.');
      return;
    }
    // The plan the person was about to buy, carried by the link, opens its checkout panel.
    window.location.replace(
      upgrade === 'pro' || upgrade === 'scale' ? `/dashboard/?upgrade=${upgrade}` : '/dashboard/',
    );
    return;
  }
  const code = body.error?.code;
  if (code === 'dashboard_login_expired') {
    fail('That link has expired. A link works for 15 minutes.');
  } else if (code === 'dashboard_login_used') {
    fail('That link has already been used. A link works once.');
  } else if (code === 'dashboard_login_not_found') {
    fail('That link is not one we sent.');
  } else {
    fail(body.error?.message ?? 'That did not work.');
  }
}

if (root !== null) {
  const apiUrl = root.dataset.apiUrl ?? 'https://api.bookrail.dev';
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = fragment.get('token');
  const upgrade = fragment.get('upgrade');
  // Off the address bar first, whatever happens next.
  window.history.replaceState(null, '', window.location.pathname);
  if (token === null || token === '') fail('This page needs the link from the dashboard message.');
  else void confirm(apiUrl, token, upgrade);
}
