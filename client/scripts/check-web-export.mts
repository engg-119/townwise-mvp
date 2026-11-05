import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.expo-export';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((match) => !/\bsrc\s*=/.test(match[1] ?? ''));
if (inline.length > 0) {
  console.error(`${dir}/index.html has ${String(inline.length)} inline <script> tag(s); the CSP in MODULE.md forbids them.`);
  process.exit(1);
}
console.log(`${dir}/index.html: no inline scripts`);
