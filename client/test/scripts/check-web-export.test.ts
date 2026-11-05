import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(__dirname, '../..');

function run(html: string): { status: number | null; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'expo-export-'));
  writeFileSync(join(dir, 'index.html'), html);
  const result = spawnSync(process.execPath, ['scripts/check-web-export.mts', dir], { cwd: root, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test('fails on an inline script', () => {
  const result = run('<script>alert(1)</script>');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('inline <script>');
});

test('passes on src-only scripts', () => {
  const result = run('<script src="/a.js" defer></script>');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('no inline scripts');
});
