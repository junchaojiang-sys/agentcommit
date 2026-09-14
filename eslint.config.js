import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Exported evidence includes copied configs; exclude those generated bundles.
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'docs/deliveries/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed parameters mark intentionally unused stub
      // arguments (e.g. adapter placeholders awaiting Phase 3).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
