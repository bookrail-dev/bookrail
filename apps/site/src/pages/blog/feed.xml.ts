/**
 * The feed, written by hand.
 *
 * Atom rather than RSS because it dates its entries in one unambiguous way and requires an
 * identifier per entry, and by hand because a feed of this shape is thirty lines of XML: a
 * dependency for it would be a dependency to audit, update and ship for no line of code that
 * anybody here would not write.
 *
 * The entry carries the description, not the article. A summary is what a reader chooses from,
 * the site is where the article is read, and a feed that carries the whole text is a second
 * copy of every page to keep in step with the first.
 */
import type { APIRoute } from 'astro';
import {
  BLOG_DESCRIPTION,
  BLOG_PATH,
  FEED_PATH,
  FEED_TITLE,
  isoDate,
  postPath,
  published,
} from '../../data/blog';
import { ORIGIN } from '../../data/site';

/** The five characters XML reserves. A title with an ampersand in it must not break the feed. */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export const GET: APIRoute = async ({ site }) => {
  const posts = await published();
  // No article, no feed: the same rule the index and the header links follow.
  if (posts.length === 0) return new Response(null, { status: 404 });

  const origin = (site?.origin ?? ORIGIN).replace(/\/$/, '');
  const url = (path: string): string => `${origin}${path}`;
  const updated = posts[0]?.data.date ?? new Date(0);

  const entries = posts.map((post) =>
    [
      '  <entry>',
      `    <title>${escape(post.data.title)}</title>`,
      `    <id>${url(postPath(post))}</id>`,
      `    <link rel="alternate" type="text/html" href="${url(postPath(post))}"/>`,
      `    <published>${isoDate(post.data.date)}</published>`,
      `    <updated>${isoDate(post.data.date)}</updated>`,
      `    <author><name>${escape(post.data.author)}</name></author>`,
      `    <summary type="text">${escape(post.data.description)}</summary>`,
      '  </entry>',
    ].join('\n'),
  );

  const feed = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escape(FEED_TITLE)}</title>`,
    `  <subtitle>${escape(BLOG_DESCRIPTION)}</subtitle>`,
    `  <id>${url(BLOG_PATH)}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${url(FEED_PATH)}"/>`,
    `  <link rel="alternate" type="text/html" href="${url(BLOG_PATH)}"/>`,
    `  <updated>${isoDate(updated)}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');

  return new Response(feed, {
    headers: { 'content-type': 'application/atom+xml; charset=utf-8' },
  });
};
