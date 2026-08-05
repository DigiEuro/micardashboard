#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const entitiesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'entities.json'), 'utf8'));
const entities = entitiesData.entities || [];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

expect(entities.length > 250, 'expected resolved CASP entities');

entities.forEach(function (entity) {
  const file = path.join(ROOT, 'entities', entity.slug + '.html');
  expect(fs.existsSync(file), 'missing entity page: ' + entity.slug);
  const html = fs.readFileSync(file, 'utf8');
  expect(html.includes('<link rel="canonical" href="https://micatracker.digital-euro-association.de/entities/' + entity.slug + '.html">'), 'bad canonical: ' + entity.slug);
  expect(html.includes(esc(entity.name)), 'entity name missing: ' + entity.slug);
  expect(html.includes('View official ESMA source'), 'official source missing: ' + entity.slug);
  expect(html.includes('Membership is not regulatory endorsement.'), 'membership disclaimer missing: ' + entity.slug);
  expect(!html.includes('—'), 'entity page contains an em dash: ' + entity.slug);
});

const flowdesk = fs.readFileSync(path.join(ROOT, 'entities', 'flowdesk-europe-sas.html'), 'utf8');
expect(flowdesk.includes('Same legal entity, multiple register names'), 'Flowdesk data note missing');
expect(flowdesk.includes('APLO SAS'), 'Flowdesk alias missing');
expect(flowdesk.includes('984500AB011S3AEF6706'), 'Flowdesk LEI missing');
expect(flowdesk.includes('MiCAR-authorised legal entities in France'), 'Flowdesk context missing');
expect(!flowdesk.includes('View in official record'), 'LEI should not require leaving the page');
expect(!flowdesk.includes('—'), 'entity page contains an em dash');

const logos = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'casp-logos.json'), 'utf8'));
Object.keys(logos).forEach(function (slug) {
  const logo = logos[slug];
  expect(/^\.\.\/assets\/casp-logos\/[A-Za-z0-9._-]+\.(?:png|svg)$/i.test(logo.src), 'unsafe logo asset path: ' + slug);
  expect(fs.existsSync(path.join(ROOT, logo.src.replace(/^\.\.\//, ''))), 'missing logo asset: ' + slug);
  const html = fs.readFileSync(path.join(ROOT, 'entities', slug + '.html'), 'utf8');
  expect(html.includes('class="entity-logo-image"'), 'logo missing from entity page: ' + slug);
  expect(html.includes('alt="' + esc(logo.alt) + '"'), 'logo alt text missing: ' + slug);
  if (logo.theme === 'dark') expect(html.includes('entity-logo-frame-dark'), 'dark logo theme missing: ' + slug);
});

const coinbase = fs.readFileSync(path.join(ROOT, 'entities', 'coinbase-luxembourg-s-a.html'), 'utf8');
expect(coinbase.includes('CSSF - Luxembourg'), 'Coinbase authority context missing');
expect(coinbase.includes('🇱🇺'), 'Coinbase authority flag missing');
expect(coinbase.includes('984500F14CA4571AAC11'), 'Coinbase LEI missing');
expect(!coinbase.includes('—'), 'Coinbase entity page contains an em dash');

console.log('Entity pages OK: ' + entities.length + ' generated profiles checked.');
