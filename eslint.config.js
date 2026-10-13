'use strict';

// Линтер (задача 6.8 / I-06 плана). Правила нарочно минимальные: ловим
// реальные дефекты (неопределённые переменные, неиспользуемое), а не стиль —
// стилистические договорённости живут в самом коде.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', '.vps/**', 'scripts/**', '**/public/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // catch (err) с неиспользованной ошибкой — устоявшийся стиль кодовой базы.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
