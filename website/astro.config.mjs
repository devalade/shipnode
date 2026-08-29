// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://shipnode.dev',
  base: '/',
  integrations: [
    starlight({
      title: 'ShipNode',
      description: 'Deploy Node.js apps to a single VPS — zero-downtime, PM2, Caddy, SSH.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/devalade/shipnode' },
      ],
      customCss: ['./src/styles/docs.css'],
      components: {
        PageTitle: './src/components/docs/PageTitle.astro',
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'Quick start', slug: 'docs/quick-start' },
          ],
        },
        {
          label: 'Configuration',
          items: [
            { label: 'shipnode.config.ts', slug: 'docs/configuration' },
            { label: 'Multi-environment', slug: 'docs/environments' },
            { label: 'Workers', slug: 'docs/workers' },
          ],
        },
        {
          label: 'Commands',
          items: [{ autogenerate: { directory: 'docs/commands' } }],
        },
        {
          label: 'Recipes',
          items: [
            { label: 'Hook recipes', slug: 'docs/recipes' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'CI/CD', slug: 'docs/ci-cd' },
            { label: 'Load balancer', slug: 'docs/load-balancer' },
            { label: 'Backups', slug: 'docs/backups' },
            { label: 'Cloudflare Tunnel', slug: 'docs/cloudflare' },
            { label: 'Server hardening', slug: 'docs/hardening' },
            { label: 'Team users', slug: 'docs/users' },
          ],
        },
      ],
    }),
  ],
});
