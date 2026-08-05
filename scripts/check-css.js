#!/usr/bin/env node
/*
 * Rebuild Tailwind into a temporary file and compare it with the committed
 * stylesheet. This is deliberately Node-based so the same check works on
 * Windows development machines and Ubuntu CI runners.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const committed = path.join(ROOT, 'styles', 'tailwind.css');
const temp = path.join(os.tmpdir(), 'micardashboard-tailwind-' + process.pid + '.css');
const tailwindCli = path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

function fail(message) {
  console.error('::error::' + message);
  process.exitCode = 1;
}

try {
  if (!fs.existsSync(committed)) throw new Error('missing styles/tailwind.css');
  if (!fs.existsSync(tailwindCli)) throw new Error('Tailwind CLI is not installed; run npm ci');

  const result = spawnSync(process.execPath, [tailwindCli, '-i', './src/tailwind.css', '-o', temp], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Tailwind build failed');

  const expected = fs.readFileSync(committed);
  const actual = fs.readFileSync(temp);
  if (!expected.equals(actual)) {
    fail("styles/tailwind.css is out of date. Run 'npm run build:css' and commit the result.");
  } else {
    console.log('Tailwind CSS is up to date.');
  }
} catch (error) {
  fail(error && error.message ? error.message : String(error));
} finally {
  try { fs.unlinkSync(temp); } catch (_) { /* no temporary file to remove */ }
}
