// Creates .dev.vars with a random SESSION_SECRET the first time you run dev.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `SESSION_SECRET=${randomBytes(32).toString('base64url')}\n`);
  console.log('Created .dev.vars with a random SESSION_SECRET');
}
// wrangler dev wants the assets directory to exist before the first build.
mkdirSync('dist', { recursive: true });
