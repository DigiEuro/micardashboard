#!/usr/bin/env node
/*
 * One repository gate for both pull requests and scheduled data updates.
 * Keeping these checks in one versioned script prevents the update bot from
 * quietly bypassing a check that PRs run.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COMMANDS = {
  'test:csv': 'scripts/test-csv.js',
  'test:services': 'scripts/test-services.js',
  'test:normalise': 'scripts/test-normalise.js',
  'test:entities': 'scripts/test-entity-pages.js',
  'validate:data': 'scripts/validate-dashboard-data.js',
  'test:smoke': 'scripts/smoke.js'
};

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function parse(file) {
  try { return JSON.parse(read(file)); }
  catch (error) { throw new Error(file + ' is not valid JSON: ' + error.message); }
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('syntax check failed: ' + file);
}

function npmRun(script) {
  console.log('\n▶ ' + script);
  const entry = COMMANDS[script];
  if (!entry) throw new Error('unknown validation command: ' + script);
  const result = spawnSync(process.execPath, [path.join(ROOT, entry)], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(script + ' failed');
}

function checkStaticPages() {
  const sitemap = read('sitemap.xml');
  ['casp-tracker.html', 'emt-tracker.html', 'non-compliant-casps.html'].forEach(function (page) {
    if (!fs.existsSync(path.join(ROOT, page))) throw new Error('missing page ' + page);
    // The file on disk keeps its .html name; the published URL does not, so
    // the sitemap is checked against the extensionless form. Anchoring on
    // </loc> stops '/casp-tracker' matching '/casp-tracker-something'.
    const url = '/' + page.replace(/\.html$/, '') + '</loc>';
    if (!sitemap.includes(url)) throw new Error('sitemap missing ' + url);
    const html = read(page);
    if ((html.match(/<h1\b/g) || []).length !== 1) throw new Error(page + ' must have exactly one H1');
    const start = html.indexOf('<!-- register-snapshot:start -->');
    const end = html.indexOf('<!-- register-snapshot:end -->');
    if (start < 0 || end < start) throw new Error(page + ' is missing its register snapshot markers');
    const snapshot = html.slice(start, end);
    if (!/<table\b/.test(snapshot)) throw new Error(page + ' snapshot has no table');
    if ((snapshot.match(/<tr\b/g) || []).length < 5) throw new Error(page + ' snapshot has too few rows');
    if (page === 'non-compliant-casps.html' && /<a\b/.test(snapshot)) {
      throw new Error('non-compliant snapshot must not contain links');
    }
  });
  if (!sitemap.includes('/entities/flowdesk-europe-sas</loc>')) throw new Error('sitemap missing entity pages');
  if (!fs.existsSync(path.join(ROOT, 'micar-explained.html'))) throw new Error('missing micar explainer page');
  if (!sitemap.includes('/micar-explained</loc>')) throw new Error('sitemap missing micar explainer page');
  // The .html suffix must not reappear in published URLs: every one of them
  // would be a redirect, which is what this change exists to remove.
  if (/<loc>[^<]*\.html<\/loc>/.test(sitemap)) throw new Error('sitemap still lists .html URLs');
  const explainer = read('micar-explained.html');
  if ((explainer.match(/<h1\b/g) || []).length !== 1) throw new Error('micar explainer must have exactly one H1');
  if (!explainer.includes('MiCA is the EU rulebook for crypto-assets.')) throw new Error('micar explainer heading missing');
  if (!explainer.includes('CASPs listed') || !explainer.includes('represented countries') || !explainer.includes('Largest represented country')) {
    throw new Error('micar explainer live stats missing');
  }
  if (!explainer.includes('assets/micar-register-map.png') || !explainer.includes('Search authorised CASPs')) {
    throw new Error('micar explainer register map or primary action missing');
  }
  if (!read('index.html').includes('ESMA EMT Register</a> - Data as of ')) throw new Error('index EMT updater marker missing');
  if (!read('index.html').includes('ESMA CASPs Register</a> - Data as of ')) throw new Error('index CASP updater marker missing');
}

function checkDataFiles() {
  ['data/emts.json', 'data/casps.json', 'data/non-compliant.json'].forEach(function (file) {
    if (!Array.isArray(parse(file))) throw new Error(file + ' is not an array');
  });

  const casps = parse('data/casps.json');
  const entities = parse('data/entities.json');
  const authorisations = entities.entities.reduce(function (total, entity) {
    return total + (entity.authorisations || []).length;
  }, 0);
  if (authorisations !== casps.length) throw new Error('entities do not reconcile with CASP source rows');
  if (entities.sourceRows !== casps.length) throw new Error('entities.json sourceRows is stale');
  const slugs = entities.entities.map(function (entity) { return entity.slug; });
  const keys = entities.entities.map(function (entity) { return entity.entityKey; });
  if (new Set(slugs).size !== slugs.length) throw new Error('duplicate entity slugs');
  if (new Set(keys).size !== keys.length) throw new Error('duplicate entity keys');

  const index = parse('data/snapshots/index.json');
  if (!Array.isArray(index.snapshots) || index.snapshots.length === 0) throw new Error('snapshot index is empty');
  if (index.count !== index.snapshots.length) throw new Error('snapshot index count does not match entries');
  index.snapshots.forEach(function (snapshot) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date)) throw new Error('bad snapshot date: ' + snapshot.date);
    const dir = path.join(ROOT, 'data', 'snapshots', snapshot.date);
    if (!fs.existsSync(dir)) throw new Error('missing snapshot directory: ' + snapshot.date);
    Object.keys(snapshot.counts || {}).forEach(function (name) {
      const rows = parse(path.join('data', 'snapshots', snapshot.date, name + '.json'));
      if (!Array.isArray(rows) || rows.length !== snapshot.counts[name]) {
        throw new Error('snapshot count mismatch: ' + snapshot.date + '/' + name);
      }
    });
  });
}

try {
  console.log('Checking JavaScript syntax...');
  [
    'update-data.js', 'config.js', 'scripts/validate-dashboard-data.js',
    'assets/js/mobile-menu.js', 'assets/js/register-view.js', 'assets/js/entity-page.js',
    'scripts/generate-entity-pages.js', 'scripts/generate-explainer-page.js', 'scripts/harvest-casp-logos.js', 'scripts/refresh-static-pages.js',
    'scripts/test-entity-pages.js', 'scripts/test-csv.js', 'scripts/check-css.js',
    'scripts/ci-validate.js'
  ].forEach(nodeCheck);

  console.log('Checking static pages and data reconciliation...');
  checkStaticPages();
  checkDataFiles();

  ['test:csv', 'test:services', 'test:normalise', 'test:entities', 'validate:data', 'test:smoke']
    .forEach(npmRun);
  console.log('\nFull repository validation passed.');
} catch (error) {
  console.error('\nCI validation failed: ' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
}
