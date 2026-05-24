// @ts-check
import { defineConfig } from 'astro/config';

const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';

// https://astro.build/config
export default defineConfig({
  site: isGitHubPages ? 'https://devalade.github.io' : 'https://shipnode.dev',
  base: isGitHubPages ? '/shipnode' : '/',
});
