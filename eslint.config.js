import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.wrangler/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.serviceworker },
  },
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.serviceworker },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
