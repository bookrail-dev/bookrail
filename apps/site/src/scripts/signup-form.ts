/**
 * The sign up form: the address, the two boxes of the terms, posted to the API, and the answer
 * written back into the page.
 *
 * A file of this site and not an inline script: `/signup/` is served with a
 * `Content-Security-Policy` that refuses inline scripts, like the dashboard, because the page
 * after it shows a live key. The API it talks to is read from `data-api-url`.
 */
const form = document.getElementById('signup-form');
const email = document.getElementById('signup-email');
const account = document.getElementById('signup-account');
const submit = document.getElementById('signup-submit');
const status = document.getElementById('signup-status');
const acceptTerms = document.getElementById('signup-accept-terms');
const approveClauses = document.getElementById('signup-approve-clauses');

if (
  form instanceof HTMLFormElement &&
  email instanceof HTMLInputElement &&
  account instanceof HTMLInputElement &&
  submit instanceof HTMLButtonElement &&
  acceptTerms instanceof HTMLInputElement &&
  approveClauses instanceof HTMLInputElement &&
  status !== null
) {
  const apiUrl = form.dataset.apiUrl ?? 'https://api.bookrail.dev';

  const say = (text: string, state: string): void => {
    status.textContent = text;
    status.setAttribute('data-state', state);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = email.value.trim();
    if (address === '') {
      say('Type the address the link should go to.', 'error');
      email.focus();
      return;
    }
    // Both boxes, before anything leaves the page: the API refuses a request without them.
    if (!acceptTerms.checked || !approveClauses.checked) {
      say(
        'Tick both boxes: the keys are issued under the Terms of Service and the Data Processing Agreement, for businesses.',
        'error',
      );
      (acceptTerms.checked ? approveClauses : acceptTerms).focus();
      return;
    }
    const name = account.value.trim();
    submit.disabled = true;
    say('Sending...', 'busy');

    fetch(`${apiUrl}/v1/signups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: address,
        client: 'web',
        accept_terms: true,
        approve_clauses: true,
        ...(name === '' ? {} : { account_name: name }),
      }),
    })
      .then((response) =>
        response.json().then((body: unknown) => ({
          status: response.status,
          body: body as Record<string, unknown>,
        })),
      )
      .then((result) => {
        submit.disabled = false;
        if (result.status === 202) {
          const until = typeof result.body.expires_at === 'string' ? result.body.expires_at : '';
          say(
            `Check your inbox. We sent a link to ${address}. Open it to finish${until === '' ? '.' : `; it works until ${until}.`}`,
            'sent',
          );
          form.reset();
          return;
        }
        const error = (result.body.error ?? {}) as { message?: string; fix?: string };
        say(
          `${error.message ?? 'That did not work.'}${error.fix === undefined ? '' : ` ${error.fix}`}`,
          'error',
        );
      })
      .catch(() => {
        submit.disabled = false;
        say(
          'The API could not be reached. Try again in a minute, or write to hello@bookrail.dev.',
          'error',
        );
      });
  });
}

// A module, so that its names are its own and not globals of the page.
export {};
