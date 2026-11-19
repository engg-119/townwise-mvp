import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

// src/portal/README.md is where CLAUDE.md sends a contributor for which file each page owns, so every source file it
// names in code (`DataList.tsx`, `shell/PortalGate.tsx`, `(client)/locations/[locationId]/data/index.tsx`) is a file
// of the client: a file that was deleted or renamed fails here until the README follows it. A bare suffix (`.web.tsx`)
// names no file and is not read.

const root = join(__dirname, '../..');

const files = ['app', 'src', 'test', 'scripts'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => `/${join(dir, file).split(sep).join('/')}`));

const named = [...new Set(
  [...readFileSync(join(root, 'src/portal/README.md'), 'utf8').matchAll(/`([^`\s.][^`\s]*\.tsx?)`/g)].map((match) => match[1] ?? ''),
)];

test('the scan sees the README’s names and the client’s files', () => {
  expect(named).toContain('shell/PortalGate.tsx');
  expect(files).toContain('/src/portal/shell/PortalGate.tsx');
});

test('every source file the portal README names exists', () => {
  // A name is a path's tail: the README writes some from client/, some from a page's folder or the route folder.
  const missing = named.filter((name) => !files.some((file) => file.endsWith(`/${name.replace(/^client\//, '')}`)));
  expect(missing).toEqual([]);
});
