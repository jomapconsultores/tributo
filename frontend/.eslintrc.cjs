module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  overrides: [
    {
      files: ['vite.config.js', '*.cjs'],
      env: { node: true },
    },
  ],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // Este proyecto no usa PropTypes: la validación genera cientos de
    // falsos positivos sin aportar seguridad real.
    'react/prop-types': 'off',
    // Apóstrofes/comillas en texto JSX: cosmético, no es un bug.
    'react/no-unescaped-entities': 'off',
    // Variables sin usar: útil verlas, pero no deben tumbar el CI.
    'no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
}
