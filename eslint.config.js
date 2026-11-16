// Flat config. Server, scripts and tests are CommonJS on Node; public/ is plain browser scripts (no bundler).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'public/app.css', 'public/vendor/**', 'backups/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, SwaggerUIBundle: 'readonly', marked: 'readonly', DOMPurify: 'readonly', DocModel: 'writable' } },
    rules: { 'no-var': 'off', 'prefer-const': 'off' },
  },
];
