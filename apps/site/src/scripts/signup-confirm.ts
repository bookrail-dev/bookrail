/**
 * Where the link of the sign up message lands: the token out of the fragment, one call to the
 * API, and the two keys shown once.
 *
 * A file of this site and not an inline script: the page shows a live key, and it is served with
 * a `Content-Security-Policy` that refuses inline scripts. The title of the page follows what
 * happened, so a person who looks at the top of the page knows where they stand.
 */
const root = document.getElementById('signup-confirm');
const title = document.getElementById('confirm-title');
const status = document.getElementById('confirm-status');
const panel = document.getElementById('confirm-key');
const secretEl = document.getElementById('confirm-secret');
const liveEl = document.getElementById('confirm-live-secret');
const commandEl = document.getElementById('confirm-command');
const help = document.getElementById('confirm-help');

function show(heading: string, text: string, withHelp = true): void {
  if (title !== null) title.textContent = heading;
  document.title = `${heading}, Bookrail`;
  if (status !== null) status.textContent = text;
  if (help !== null && withHelp) help.hidden = false;
}

interface ConfirmBody {
  status?: string;
  delivered_to?: string;
  secret_key?: string;
  live_secret_key?: string;
  error?: { code?: string; message?: string; fix?: string };
}

async function confirm(apiUrl: string, token: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/signups/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    show('This link did not work', 'The API could not be reached. Try the link again in a minute.');
    return;
  }
  const body = (await response.json().catch(() => ({}))) as ConfirmBody;
  if (response.status === 200 && body.status === 'email_taken') {
    show(
      'This address already has an account',
      'Nothing was created. Its keys are managed in the dashboard.',
    );
    return;
  }
  if (response.status === 200 && body.delivered_to === 'cli') {
    show(
      'Your terminal has the keys',
      'Your terminal has the keys. You can close this page.',
      false,
    );
    return;
  }
  if (response.status === 200 && body.secret_key !== undefined) {
    show('Your keys', 'Done. Your account and your project exist.', false);
    if (secretEl !== null) secretEl.textContent = body.secret_key;
    if (liveEl !== null) liveEl.textContent = body.live_secret_key ?? '';
    if (commandEl !== null) {
      commandEl.textContent = `npx bookrail login --token ${body.secret_key}${
        body.live_secret_key === undefined
          ? ''
          : `\nnpx bookrail login --live --token ${body.live_secret_key}`
      }`;
    }
    if (panel !== null) panel.hidden = false;
    return;
  }
  const error = body.error ?? {};
  if (error.code === 'signup_expired') {
    show('This link has expired', 'A link works for one hour: start again at /signup.');
    return;
  }
  if (error.code === 'signup_already_confirmed') {
    show('This link has been used', 'Keys are shown once. New keys are made in the dashboard.');
    return;
  }
  show(
    'This link did not work',
    `${error.message ?? 'That did not work.'}${error.fix === undefined ? '' : ` ${error.fix}`}`,
  );
}

if (root !== null) {
  const apiUrl = root.dataset.apiUrl ?? 'https://api.bookrail.dev';
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (token === null || token === '') {
    show(
      'This link did not work',
      'This page needs the link from the confirmation message. Start again at /signup.',
    );
  } else {
    void confirm(apiUrl, token);
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    button.addEventListener('click', () => {
      const source = document.getElementById(button.dataset.copy ?? '');
      const value = source?.textContent ?? '';
      if (value === '' || navigator.clipboard === undefined) return;
      void navigator.clipboard.writeText(value).then(() => {
        const label = button.querySelector('span');
        if (label !== null) label.textContent = 'Copied';
      });
    });
  }
}

// A module, so that its names are its own and not globals of the page.
export {};
