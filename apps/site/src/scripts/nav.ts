/**
 * The header of every page that is not documentation: the «Menu» panel under 900px, and «Sign in»
 * that reads «Dashboard» when this tab already holds a dashboard session.
 *
 * The session is read from `sessionStorage` and nothing else: no call to the API on every page,
 * no cookie. Its key is written into the header by `SiteNav.astro` at build time
 * (`data-session-key`), so this file imports nothing and stays one small file. Without
 * JavaScript the link says «Sign in» and goes to the same page, and under 900px every link of
 * the header is also in the footer.
 *
 * The panel is the list of links of the header itself, shown as a full width panel: one list,
 * so a link is never in the page twice. The button says whether it is open (`aria-expanded`),
 * Escape closes it and gives the focus back to the button, and following a link closes it.
 *
 * It runs when it is imported, and imports nothing, so that it can be bundled into a page's own
 * script: the homepage imports it as `nav.ts?home` (see `index.astro`).
 */

function hasSession(key: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { token?: unknown; expires_at?: unknown };
    return (
      typeof parsed.token === 'string' &&
      typeof parsed.expires_at === 'string' &&
      Date.parse(parsed.expires_at) > Date.now()
    );
  } catch {
    return false;
  }
}

function initNav(header: HTMLElement): void {
  const key = header.dataset.sessionKey;
  if (key !== undefined && hasSession(key)) {
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-session-link]')) {
      link.textContent = 'Dashboard';
    }
  }

  const button = header.querySelector<HTMLButtonElement>('[data-menu-button]');
  const panel = header.querySelector<HTMLElement>('[data-menu-panel]');
  if (button === null || panel === null) return;
  button.hidden = false;

  const setOpen = (open: boolean, restoreFocus = false): void => {
    header.classList.toggle('menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Close' : 'Menu';
    if (!open && restoreFocus) button.focus();
  };

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    setOpen(open);
    if (open) panel.querySelector<HTMLElement>('a')?.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && header.classList.contains('menu-open')) {
      setOpen(false, true);
    }
  });
  panel.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a') !== null) setOpen(false);
  });
  // Back over 900px the panel is the row of links again, and a stale open state would leave the
  // button saying «Close» the next time the window narrows.
  window.matchMedia('(min-width: 900px)').addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
  });
}

const siteNav = document.getElementById('site-nav');
if (siteNav !== null) initNav(siteNav);
