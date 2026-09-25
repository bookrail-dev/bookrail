/**
 * «Copy as Markdown»: fetches the markdown twin of the page from this site and puts it on the
 * clipboard. The button is hidden in the HTML and shown here, so a reader without JavaScript
 * sees only the link to the twin, which works everywhere.
 */
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-markdown]')) {
  const source = button.dataset.copyMarkdown;
  if (source === undefined || navigator.clipboard === undefined) continue;
  button.hidden = false;
  const label = button.textContent?.trim() ?? 'Copy as Markdown';
  button.addEventListener('click', () => {
    void fetch(source)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('missing'))))
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => {
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = label;
        }, 2000);
      })
      .catch(() => {
        button.textContent = 'Could not copy: open pricing.md';
      });
  });
}
