/**
 * The blog: the collection, and the one question every part of the site asks about it.
 *
 * The section exists only when there is something in it. An index with no articles is a
 * promise the site is not keeping, and a link to it in the header is the same promise made
 * twice, so the header link, the footer link, the index, the article pages and the feed are
 * all built from `published()` and all disappear together when it is empty.
 */
import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** One entry of a navigation list, the shape `src/data/site.ts` already uses. */
export interface SiteLink {
  href: string;
  label: string;
}

export const BLOG_PATH = '/blog/';
export const FEED_PATH = '/blog/feed.xml';
export const BLOG_TITLE = 'Blog';
export const FEED_TITLE = 'Bookrail blog';
export const BLOG_DESCRIPTION =
  'How the booking engine is built: availability, concurrency, time zones, policies, and the edge cases behind them.';

const BLOG_LINK: SiteLink = { href: BLOG_PATH, label: BLOG_TITLE };

/**
 * Whether there is any article file at all, answered by the bundler while it builds rather than
 * by a read of the collection.
 *
 * `getCollection` writes a line about an empty collection every time it is called, and empty is
 * the normal state of this section: without this guard the loudest thing in the output of a
 * build that publishes nothing is a warning about it, once per page that draws a header. The
 * glob is resolved at build time and lists file names only, so it answers the same question one
 * step earlier and reads nothing.
 */
const HAS_ARTICLES = Object.keys(import.meta.glob('../content/blog/*.md')).length > 0;

/**
 * The published articles, newest first.
 *
 * A draft is filtered here rather than in each page, so there is one place where an unpublished
 * article can leak from and it is this line.
 */
export async function published(): Promise<Post[]> {
  if (!HAS_ARTICLES) return [];
  const posts = await getCollection('blog', (post: Post) => !post.data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function postPath(post: Post): string {
  return `${BLOG_PATH}${post.id}/`;
}

/** The instant a feed and a `<time>` element need: UTC, to the second. */
export function isoDate(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** "14 September 2026". Absolute, spelled out, never a relative or an abbreviated date. */
export function readableDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * `links` with the blog in it, or `links` untouched while the blog is empty.
 *
 * `before` names the link the blog goes in front of, so the entry lands among the reading
 * links of the footer rather than after the address and the legal pages. Without it the blog
 * goes last, which is where the header wants it.
 */
export async function withBlog(links: readonly SiteLink[], before?: string): Promise<SiteLink[]> {
  const out = [...links];
  if ((await published()).length === 0) return out;
  const at = before === undefined ? -1 : out.findIndex((link) => link.href === before);
  out.splice(at === -1 ? out.length : at, 0, BLOG_LINK);
  return out;
}
