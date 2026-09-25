/**
 * The motion of the homepage: Lenis, and the two things that move.
 *
 * Everything here is an enhancement of markup that is already correct. The grid rectangles and
 * the sections are in the HTML; this file hides them and puts them back, so a reader without
 * JavaScript sees the finished state and a reader who asked for less motion is given the
 * finished state immediately, with Lenis never constructed.
 *
 * The third move of the first homepage, the request typing itself, went with the section it
 * animated, on 25 September 2026: the booking is now a tab of the product demo, and a tab that animates
 * every time it is chosen is a tab that makes its reader wait.
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

/**
 * Sections fade up once, the first time they are seen. Only an element that is below the fold
 * when the page loads is armed (hidden, to be shown): what the reader already sees never blinks,
 * and without this script nothing is hidden at all.
 */
const revealables = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
if (!reduced) {
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
  for (const element of revealables) {
    if (element.getBoundingClientRect().top < window.innerHeight) continue;
    element.classList.add('armed');
    revealer.observe(element);
  }
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
