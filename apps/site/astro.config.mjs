import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { siteAssets } from './scripts/integration.mjs';

/**
 * A static site, and nothing else: no adapter, no server island, no third party at runtime.
 *
 * `site` is `https://bookrail.dev`, the domain the founder bought on 7 September 2026, and
 * `SITE_URL` overrides it for a preview deployment. Internal links stay root relative; only the
 * canonical, the social tags and the two `llms` files carry the origin.
 */
const ORIGIN = process.env.SITE_URL ?? 'https://bookrail.dev';

/**
 * The build cache, which is also where a content collection keeps what it has read. A build
 * that adds a file, reads it and takes it away again would leave the entry behind in the cache
 * of the working copy, and the next build would publish a page for a file that is not there.
 * `test/blog.test.ts` is that build, so it gives itself a cache of its own and throws it away
 * with everything else it made. Unset, which is every other build, means the default.
 */
const CACHE_DIR = process.env.SITE_CACHE_DIR;

export default defineConfig({
  site: ORIGIN,
  output: 'static',
  ...(CACHE_DIR === undefined ? {} : { cacheDir: CACHE_DIR }),
  // Starlight turns Astro's link prefetch on. The homepage performance budget allows Lenis
  // and the two animated components and nothing else, so it goes back off for the whole site.
  prefetch: false,
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  // No raster asset is processed, so the sharp pipeline is dead weight and a build dependency
  // that needs a native build step.
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: 'Bookrail',
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      description:
        'Booking infrastructure for developers: availability, resources, holds, bookings, policies and webhooks behind one API.',
      logo: { src: './src/assets/brand/bookrail-mark.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      head: [
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
        },
        { tag: 'meta', attrs: { property: 'og:image', content: `${ORIGIN}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      customCss: [
        './src/styles/tokens.css',
        './src/styles/fonts.css',
        './src/styles/starlight.css',
        './src/styles/figures.css',
      ],
      components: {
        // The documentation carries the same links as the marketing header.
        SocialIcons: './src/components/DocsHeaderLinks.astro',
        // Dark mode is not designed yet. Until it is there is one palette, and a
        // control that switches between a theme and itself is a lie about the product.
        ThemeSelect: './src/components/NoThemeSelect.astro',
        // Privacy and the legal notice belong on every page, the API reference included.
        Footer: './src/components/DocsFooter.astro',
      },
      pagination: true,
      credits: false,
      lastUpdated: false,
      expressiveCode: {
        themes: ['github-dark'],
        // Starlight would otherwise repaint the code block with its own (light) surface, and
        // the code surface of this system is #0f0f0f on every page.
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '0',
          borderColor: '#222222',
          codeBackground: '#0f0f0f',
          frames: { shadowColor: 'transparent' },
        },
      },
      plugins: [
        starlightOpenAPI([
          {
            base: 'docs/api/reference',
            label: 'API reference',
            // The specification of `packages/api`, read where it lives. Never a copy.
            schema: '../../packages/api/openapi/openapi.json',
          },
        ]),
      ],
      sidebar: [
        { label: 'Documentation', link: '/docs/' },
        {
          label: 'Start',
          items: [
            { label: 'Quickstart', link: '/docs/quickstart/' },
            { label: 'Concepts', link: '/docs/concepts/' },
            { label: 'Entity reference', link: '/docs/entities/' },
            { label: 'Configuration', link: '/docs/configuration/' },
            { label: 'The edge cases of booking', link: '/docs/edge-cases/' },
          ],
        },
        {
          label: 'API and SDK',
          items: [
            { label: 'The short form', link: '/docs/api/' },
            ...openAPISidebarGroups,
            { label: 'SDK for TypeScript', link: '/docs/sdk/' },
            { label: 'Errors', link: '/docs/errors/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Time zones', link: '/docs/guides/time-zones/' },
            { label: 'Webhooks', link: '/docs/guides/webhooks/' },
            { label: 'Idempotency', link: '/docs/guides/idempotency/' },
            { label: 'Policies', link: '/docs/guides/policies/' },
            { label: 'Coding agents', link: '/docs/guides/agents/' },
          ],
        },
        {
          label: 'CLI, MCP and agents',
          items: [
            { label: 'For AI agents', link: '/docs/for-ai-agents/' },
            { label: 'CLI basics', link: '/docs/cli-basics/' },
            { label: 'CLI reference', link: '/docs/cli/' },
            { label: 'MCP reference', link: '/docs/mcp/' },
            { label: 'Rules an agent can rely on', link: '/docs/agents/' },
          ],
        },
        { label: 'Open source', link: '/docs/open-source/' },
        {
          label: 'The company',
          items: [
            { label: 'Privacy', link: '/privacy' },
            { label: 'Legal notice', link: '/legal' },
          ],
        },
      ],
    }),
    siteAssets(),
  ],
});
