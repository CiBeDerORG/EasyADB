// V4-01: the legacy browser IIFE scripts are explicitly grandfathered.
const legacyScripts = [
  'web/display-lab.js',
  'web/m2-group.js',
  'web/m2-metrics.js',
  'web/m2-multi.js',
  'web/m2-touch.js',
  'web/m2-traffic.js',
  'web/m2-webrtc.js',
];

const qualityRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  'no-var': 'error',
  'no-shadow': 'error',
  'no-redeclare': 'error',
  eqeqeq: ['error', 'always'],
};

export default [
  { ignores: legacyScripts },
  {
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        WebSocket: 'readonly',
        RTCPeerConnection: 'readonly',
        MediaStream: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      ...qualityRules,
      camelcase: ['error', { properties: 'never', ignoreDestructuring: true }],
      'no-implicit-globals': 'error',
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: qualityRules,
  },
  {
    files: ['tests/v4_frontend_standards.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { require: 'readonly', __dirname: 'readonly', console: 'readonly' },
    },
    rules: qualityRules,
  },
];
