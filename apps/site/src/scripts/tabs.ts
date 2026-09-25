/**
 * The tabs of the homepage: the product demo and the code samples.
 *
 * The markup is already a tablist (`role="tablist"`, `role="tab"`, `role="tabpanel"`, each tab
 * `aria-controls` its panel), and every tab is a link to its panel. Without JavaScript that is
 * what it stays: the panels are one under the other and a tab jumps to its own. This file makes
 * it behave like tabs: one panel shown, the others `hidden`, a roving `tabindex` so the tablist
 * is one stop of the keyboard, and the arrows, Home and End moving between tabs. A tab that
 * names a title (`data-tab-title`) writes it into the element the tablist points at, which is
 * how «Use Bookrail with» follows the tab.
 */

function activate(
  tabs: HTMLElement[],
  index: number,
  focus: boolean,
  titleTarget: HTMLElement | null,
): void {
  tabs.forEach((tab, at) => {
    const selected = at === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel !== null) panel.hidden = !selected;
  });
  const chosen = tabs[index];
  if (chosen === undefined) return;
  if (focus) chosen.focus();
  const title = chosen.dataset.tabTitle;
  if (titleTarget !== null && title !== undefined) titleTarget.textContent = title;
}

export function initTabs(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
    const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
    if (tabs.length === 0) continue;
    const titleId = root.dataset.tabsTitle;
    const titleTarget = titleId === undefined ? null : document.getElementById(titleId);
    root.dataset.tabsReady = '';
    const start = Math.max(
      0,
      tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
    );
    activate(tabs, start, false, titleTarget);

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        activate(tabs, index, false, titleTarget);
      });
      tab.addEventListener('keydown', (event) => {
        const last = tabs.length - 1;
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index - 1 + tabs.length) % tabs.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? last
                  : event.key === ' '
                    ? index
                    : null;
        if (next === null) return;
        event.preventDefault();
        activate(tabs, next, true, titleTarget);
      });
    });
  }
}
