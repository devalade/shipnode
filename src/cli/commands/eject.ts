import { writeFile, pathExists, mkdir } from 'fs-extra';
import { resolve } from 'path';
import { ui } from '../ui.js';

const ECOSYSTEM_CONFIG = `// ShipNode PM2 Ecosystem — customize and commit this file
// Placeholders auto-replaced on deploy: {{APP_NAME}} {{BACKEND_PORT}} {{REMOTE_PATH}}
module.exports = {
  apps: [{
    name: '{{APP_NAME}}',
    script: 'index.js',
    instances: 1,
    exec_mode: 'cluster',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: '{{BACKEND_PORT}}',
    },
  }],
};
`;

const CADDYFILE_BACKEND = `# ShipNode Caddy — backend reverse proxy template
# Placeholder auto-replaced: {{DOMAIN}} {{BACKEND_PORT}}
{{DOMAIN}} {
  reverse_proxy localhost:{{BACKEND_PORT}}
  encode gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
  }
}
`;

const CADDYFILE_FRONTEND = `# ShipNode Caddy — frontend static files template
# Placeholder auto-replaced: {{DOMAIN}} {{REMOTE_PATH}}
{{DOMAIN}} {
  root * {{REMOTE_PATH}}/current
  file_server
  encode gzip
  try_files {path} /index.html
}
`;

export async function cmdEject(cwd: string, target: 'pm2' | 'caddy' | 'all'): Promise<void> {
  const templatesDir = resolve(cwd, '.shipnode', 'templates');
  await mkdir(templatesDir, { recursive: true });

  const ejected: string[] = [];
  const skipped: string[] = [];

  async function writeTemplate(filename: string, content: string): Promise<void> {
    const filePath = resolve(templatesDir, filename);
    if (await pathExists(filePath)) {
      ui.warn(`Skipping ${filename} — file already exists`);
      skipped.push(filename);
    } else {
      await writeFile(filePath, content, 'utf8');
      ejected.push(filename);
    }
  }

  if (target === 'pm2' || target === 'all') {
    await writeTemplate('ecosystem.config.cjs', ECOSYSTEM_CONFIG);
  }

  if (target === 'caddy' || target === 'all') {
    await writeTemplate('Caddyfile.backend', CADDYFILE_BACKEND);
    await writeTemplate('Caddyfile.frontend', CADDYFILE_FRONTEND);
  }

  if (ejected.length > 0) {
    ui.success(`Ejected templates to .shipnode/templates/:`);
    for (const f of ejected) {
      ui.info(`  ${f}`);
    }
  }

  if (skipped.length > 0) {
    ui.info(`Skipped (already exist): ${skipped.join(', ')}`);
  }
}
