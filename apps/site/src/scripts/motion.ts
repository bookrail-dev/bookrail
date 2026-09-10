/**
 * The only JavaScript the homepage ships: Lenis, and the three things that move.
 *
 * Everything here is an enhancement of markup that is already correct. The grid rectangles, the
 * request and the response are in the HTML; this file hides them and puts them back, so a
 * reader without JavaScript sees the finished state and a reader who asked for less motion is
 * given the finished state immediately, with Lenis never constructed.
 */
import Lenis from 'lenis';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const nav = document.getElementById('site-nav');
const grid = document.getElementById('resource-grid');
const now = grid?.querySelector<HTMLElement>('[data-now]') ?? null;

function onScroll(scroll: number): void {
  nav?.classList.toggle('scrolled', scroll > 8);
  if (now !== null) {
    // The "now" line drifts with the scroll: the grid is time, and so is the page.
    const position = Math.min(0.14 + scroll / 4000, 0.9);
    now.style.left = `calc(96px + (100% - 96px) * ${position})`;
  }
}

if (reduced) {
  onScroll(window.scrollY);
  window.addEventListener('scroll', () => onScroll(window.scrollY), { passive: true });
} else {
  const lenis = new Lenis({ autoRaf: true, lerp: 0.09, smoothWheel: true });
  lenis.on('scroll', ({ scroll }: { scroll: number }) => onScroll(scroll));
  onScroll(window.scrollY);
}

/** Sections fade up once, the first time they are seen. */
const revealables = document.querySelectorAll<HTMLElement>('[data-reveal]');
if (reduced) {
  for (const element of revealables) element.classList.add('in');
} else {
  const revealer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        revealer.unobserve(entry.target);
      }
    },
    { threshold: 0.15 },
  );
  for (const element of revealables) revealer.observe(element);
}

/** The grid fills in time order, and the refusal arrives after the capacity is gone. */
const slots = [...(grid?.querySelectorAll<HTMLElement>('.slot') ?? [])].sort(
  (a, b) => Number(a.dataset.slot ?? 0) - Number(b.dataset.slot ?? 0),
);
const refusal = grid?.querySelector<HTMLElement>('[data-rejected]') ?? null;
if (reduced) {
  for (const slot of slots) slot.classList.add('in');
  refusal?.classList.add('in');
} else {
  slots.forEach((slot, index) => setTimeout(() => slot.classList.add('in'), 250 + index * 90));
  setTimeout(() => refusal?.classList.add('in'), 250 + slots.length * 90 + 400);
}

/**
 * The request is typed and the response lands line by line, once, when the section is reached.
 *
 * Each line keeps its own markup: the caret runs over the plain text and the coloured HTML is
 * restored on the last character, so no token is ever half written.
 */
const section = document.getElementById('request');
const requestLines = [...document.querySelectorAll<HTMLElement>('[data-request] .req-line')];
const responseLines = [...document.querySelectorAll<HTMLElement>('[data-response] .resp-line')];

if (section !== null && requestLines.length > 0) {
  if (reduced) {
    for (const line of responseLines) line.classList.add('in');
  } else {
    const finished = requestLines.map((line) => line.innerHTML);
    for (const line of requestLines) line.textContent = '';

    const showResponse = (): void => {
      responseLines.forEach((line, index) =>
        setTimeout(() => line.classList.add('in'), 40 * index),
      );
    };

    const typeLine = (index: number): void => {
      const line = requestLines[index];
      if (line === undefined) {
        setTimeout(showResponse, 350);
        return;
      }
      const html = finished[index] ?? '';
      const text = html.replace(/<[^>]+>/g, '');
      let cursor = 0;
      const tick = (): void => {
        cursor += 2;
        if (cursor >= text.length) {
          line.innerHTML = html;
          setTimeout(() => typeLine(index + 1), 60);
          return;
        }
        line.innerHTML = `${text
          .slice(0, cursor)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')}<span class="cursor"></span>`;
        setTimeout(tick, 12);
      };
      tick();
    };

    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          watcher.disconnect();
          typeLine(0);
        }
      },
      { threshold: 0.3 },
    );
    watcher.observe(section);
  }
} else {
  for (const line of responseLines) line.classList.add('in');
}
