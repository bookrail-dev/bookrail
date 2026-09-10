import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  /**
   * The articles. One markdown file per article in `src/content/blog/`, the file name is the
   * slug, and the front matter is the whole of the metadata: no tags, no categories, no cover
   * image, no author profile. `date` is absolute and `author` is a name, never an address.
   *
   * `draft: true` keeps an article out of the build entirely: no page, no listing, no feed
   * entry, no line in `llms.txt`. It is the only state between "not written" and "published".
   */
  blog: defineCollection({
    loader: glob({ pattern: '*.md', base: './src/content/blog' }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      author: z.string(),
      draft: z.boolean().default(false),
    }),
  }),
};
