import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const PLATFORM_FILE = /\.(?:web|ios|android|native)\.[jt]sx?$/;
const WEB_FILE = /\.web\.tsx?$/;

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.[jt]sx?$/.test(file))
    .map((file) => join(dir, file));
}

function specifiers(file: string): string[] {
  const text = readFileSync(join(root, file), 'utf8');
  return [...text.matchAll(/\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

const files = [...sources('app'), ...sources('src')];

test('the scan sees the app and its imports', () => {
  expect(files).toContain(join('app', '_layout.tsx'));
  expect(specifiers(join('src', 'auth', 'GoogleButton.web.tsx'))).toContain('./GoogleButton');
});

test('no route file under app/ has a platform extension', () => {
  expect(sources('app').filter((file) => PLATFORM_FILE.test(file))).toEqual([]);
});

test('only .web files import a module by its explicit .web name', () => {
  const leaks = files
    .filter((file) => !WEB_FILE.test(file))
    .flatMap((file) => specifiers(file).filter((spec) => spec.endsWith('.web')).map((spec) => `${file}: ${spec}`));
  expect(leaks).toEqual([]);
});

test('the native Home imports nothing from src/marketing', () => {
  const home = join('src', 'marketing', 'Home.tsx');
  const local = specifiers(home)
    .filter((spec) => spec.startsWith('.'))
    .filter((spec) => join('src', 'marketing', spec).startsWith(join('src', 'marketing')));
  expect(local).toEqual([]);
});
