'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'web');
const legacyScripts = new Set([
  'display-lab.js',
  'm2-group.js',
  'm2-metrics.js',
  'm2-multi.js',
  'm2-touch.js',
  'm2-traffic.js',
  'm2-webrtc.js',
]);
const allowedRoots = new Set(['app', 'core', 'features', 'shared', 'assets']);
const kebabCase = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.(?:js|css)$/;
const prettierIgnore = fs.readFileSync(path.join(root, '.prettierignore'), 'utf8');
const eslintConfig = fs.readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|css)$/.test(entry.name)) continue;
    const relative = path.relative(webRoot, absolute).split(path.sep).join('/');
    const parts = relative.split('/');
    if (parts.length === 1 && legacyScripts.has(entry.name)) continue;
    assert(parts.length > 1, `new web asset must live in a feature directory: ${relative}`);
    assert(allowedRoots.has(parts[0]), `unknown frontend directory: ${relative}`);
    assert(kebabCase.test(entry.name), `non-kebab-case frontend file: ${relative}`);
    assert(!/^m[0-9]+-/.test(entry.name), `historical version in filename: ${relative}`);
    if (entry.name.endsWith('.js')) {
      const source = fs.readFileSync(absolute, 'utf8');
      assert(
        !/\b(?:window|globalThis)\.EasyADB\w*\s*=/.test(source),
        `new module must not publish window globals: ${relative}`,
      );
    }
  }
}

assert.deepEqual(
  fs
    .readdirSync(webRoot)
    .filter((name) => name.endsWith('.js'))
    .sort(),
  [...legacyScripts].sort(),
  'root-level legacy script allowlist changed; move new scripts into named modules',
);
for (const name of legacyScripts) {
  assert(prettierIgnore.includes(`web/${name}\n`), `missing explicit format exception: ${name}`);
  assert(eslintConfig.includes(`'web/${name}'`), `missing explicit lint exception: ${name}`);
}
assert(prettierIgnore.includes('web/index.html\n'));
assert(!prettierIgnore.includes('web/**'));
visit(webRoot);

assert.equal(packageInfo.private, true);
assert.equal(packageInfo.devDependencies.eslint, '10.13.0');
assert.equal(packageInfo.devDependencies.prettier, '3.9.10');
assert.deepEqual(packageLock.packages[''].devDependencies, packageInfo.devDependencies);
for (const script of ['lint', 'format:check', 'test:architecture']) {
  assert(packageInfo.scripts[script], `missing frontend check: ${script}`);
}
assert(workflow.includes('refactor/v4-frontend-standards'));
assert(workflow.includes('npm ci --ignore-scripts --no-audit --no-fund'));
assert(workflow.includes('npm run lint'));
assert(workflow.includes('npm run format:check'));
assert(workflow.includes('node tests/v4_frontend_standards.cjs'));
assert(workflow.includes('run: python -m pytest -q'), 'must retain complete V2 Python suite');

const standards = fs.readFileSync(path.join(root, 'docs/V4-FRONTEND-STANDARDS.md'), 'utf8');
for (const rule of [
  'LiveSessionController',
  'requestStopSession',
  'dispose',
  'sessionId',
  'kebab-case',
  'PascalCase',
  'camelCase',
  'UPPER_SNAKE_CASE',
  'DIRTY',
]) {
  assert(standards.includes(rule), `missing architecture convention: ${rule}`);
}
console.log('V4-01 frontend naming and CI boundary gate passed');
