import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

// .npmrc's min-release-age=7 forbids installing a release in its first week, while expo-doctor's version check asks
// for the newest SDK patch on the day it ships. A gate that a policy forbids satisfying can't be a gate: verify skips
// only that check, and `deps:check` still reports the drift for the weekly bump.
test('doctor skips only the dependency version check, and verify still runs doctor', () => {
  expect(scripts.doctor).toBe('EXPO_DOCTOR_SKIP_DEPENDENCY_VERSION_CHECK=1 expo-doctor');
  expect(scripts.verify).toContain('npm run doctor');
});

test('deps:check reports SDK version drift without gating', () => {
  expect(scripts['deps:check']).toBe('expo install --check');
  expect(scripts.verify).not.toContain('deps:check');
});
