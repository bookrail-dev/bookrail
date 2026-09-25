/**
 * Contrast, computed from the tokens rather than eyeballed.
 *
 * The palette of the prototype has two values that do not clear 4.5:1 for text (`#8a8a8a` on
 * the paper ground is 3.3:1, and the `#7a7a7a` comment on the code surface is 4.48:1). Both
 * were darkened, and this file is why they cannot drift back: the pairs below are read out of
 * `tokens.css`, so a change to a token changes the assertion, not the other way round.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteRoot } from './helpers.js';

const css = await readFile(join(siteRoot, 'src', 'styles', 'tokens.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8});`, 'i').exec(css);
  if (match?.[1] === undefined) throw new Error(`--${name} is not a literal colour in tokens.css`);
  return match[1];
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** Every pair of tokens the site actually paints text with, and where. */
const TEXT_PAIRS: [string, string, string][] = [
  ['ink', 'bg', 'body text on the page ground'],
  ['ink', 'card', 'body text on a surface'],
  ['ink-2', 'bg', 'secondary text'],
  ['ink-2', 'card', 'secondary text on a surface'],
  ['ink-3', 'bg', 'muted text: footer, step numbers, grid caption'],
  ['ink-3', 'card', 'muted text on a surface: hour labels, pane heads'],
  ['accent', 'bg', 'the kicker and every accent label'],
  ['accent', 'card', 'the refused request, on white'],
  ['accent', 'accent-soft', 'a hold, on its tint'],
  ['card', 'ink', 'a booking rectangle, and the primary button'],
  ['code-ink', 'code-bg', 'code'],
  ['code-comment', 'code-bg', 'a comment in code'],
  ['code-keyword', 'code-bg', 'a keyword'],
  ['code-number', 'code-bg', 'a number'],
  ['code-string', 'code-bg', 'a string'],
  ['accent', 'card', 'the Recommended badge of the Pro card, on white'],
  ['accent', 'bg', 'the plan picker of the comparison table on a phone, when a plan is chosen'],
  ['ink-3', 'card', 'the labels of the dashboard and the grey second line of a card'],
  ['ink-3', 'bg', 'the grey second line of a cell of the comparison table'],
  ['ink-2', 'bg', 'the key label of a framed key row, on the paper inside the frame'],
  // The homepage of 25 September 2026.
  ['accent', 'bg', 'the second line of the homepage h1'],
  ['ink-3', 'bg', 'the grey second line of a two line section title, an unselected tab'],
  ['ink-3', 'card', 'the grey sentences of a feature card, of a template card, and a window foot'],
  ['accent', 'accent-soft', 'an occupied code chip of the explain table, and the 201 status'],
  ['code-comment', 'code-bg', 'an unselected code tab'],
  ['code-ink', 'code-bg', 'the selected code tab, and the link to the docs under the code'],
];

describe('token contrast', () => {
  it.each(TEXT_PAIRS)('%s on %s clears 4.5:1 (%s)', (foreground, background) => {
    const ratio = contrast(token(foreground), token(background));
    expect(ratio, `${foreground} on ${background} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('keeps the hairlines out of the text roles: they never clear 4.5:1 and never carry text', () => {
    expect(contrast(token('line'), token('bg'))).toBeLessThan(4.5);
    expect(contrast(token('line-2'), token('bg'))).toBeLessThan(4.5);
    expect(contrast(token('ink-faint'), token('bg'))).toBeLessThan(4.5);
  });

  it('paints no text with a hairline token', async () => {
    const site = await readFile(join(siteRoot, 'src', 'styles', 'site.css'), 'utf8');
    for (const declaration of site.matchAll(/(?<!-)\bcolor:\s*var\((--[a-z0-9-]+)\)/g)) {
      expect(['--line', '--line-2', '--ink-faint']).not.toContain(declaration[1]);
    }
  });

  it('has one accent, and it is the cobalt of the decision', () => {
    expect(token('accent')).toBe('#2857f0');
    const site = css + '\n';
    const colours = [...site.matchAll(/#[0-9a-f]{6}/gi)].map((match) => match[0].toLowerCase());
    const saturated = colours.filter((colour) => {
      const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(colour.slice(at + 1, at + 3), 16));
      return Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0) > 40;
    });
    // Cobalt, and the two syntax colours of the dark code surface. Nothing else is saturated:
    // the tint `--accent-soft` and every grey fall below the threshold by construction.
    expect([...new Set(saturated)].sort()).toEqual(['#2857f0', '#9ab4ff', '#ffd479']);
  });
});
