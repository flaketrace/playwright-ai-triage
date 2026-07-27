import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Globbed, not root-anchored: a bare 'dist/' ignores only the top-level one, so
  // a nested checkout's built bundles get linted and fail `npm run gate`. Covers
  // generated output only — a nested copy's own src/ is still linted.
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
