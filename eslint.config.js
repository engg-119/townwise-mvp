import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const expoEnvMessage =
  'Only static process.env.EXPO_PUBLIC_* reads: Metro inlines nothing else, and every value ships in the bundle.';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/.vitest/**', '**/.expo/**', '**/.expo-export/**', '**/dist/**', '**/.venv/**',
      'tooling/test/fixtures/**', '.worktrees/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { 'import-x': importX },
    rules: {
      // Phantom dependencies (D1): every import, type-only included, is declared in the closest
      // package.json; src/ may not import devDependencies.
      'import-x/no-extraneous-dependencies': ['error', {
        includeTypes: true,
        devDependencies: ['**/test/**', '**/*.config.{js,ts}', 'tooling/**'],
      }],
      // No reaching into another module's folder by relative path; go through @ckeith26/<name>.
      'import-x/no-relative-packages': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Library code is configured by the app; it never configures itself.
    files: ['api/kit/*/src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', { object: 'process', property: 'env',
        message: 'Library code never reads process.env. Export an env schema instead (2.6).' }],
      'no-console': 'error',
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true]", message: expoEnvMessage },
        { selector: "MemberExpression[object.object.name='process'][object.property.name='env'][computed=false][property.name!=/^EXPO_PUBLIC_/]", message: expoEnvMessage },
        { selector: "MemberExpression[object.name='process'][property.name='env']:not(MemberExpression > MemberExpression.object)", message: expoEnvMessage },
        { selector: "VariableDeclarator[init.name='process']", message: expoEnvMessage },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
