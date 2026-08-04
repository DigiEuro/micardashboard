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
});

const flowdesk = fs.readFileSync(path.join(ROOT, 'entities', 'flowdesk-europe-sas.html'), 'utf8');
expect(flowdesk.includes('Same legal entity, multiple register names'), 'Flowdesk data note missing');
expect(flowdesk.includes('APLO SAS'), 'Flowdesk alias missing');
expect(flowdesk.includes('984500AB011S3AEF6706'), 'Flowdesk LEI missing');
expect(flowdesk.includes('MiCAR-authorised legal entities in France'), 'Flowdesk context missing');
expect(!flowdesk.includes('View in official record'), 'LEI should not require leaving the page');

const coinbase = fs.readFileSync(path.join(ROOT, 'entities', 'coinbase-luxembourg-s-a.html'), 'utf8');
expect(coinbase.includes('CSSF — Luxembourg'), 'Coinbase authority context missing');
expect(coinbase.includes('🇱🇺'), 'Coinbase authority flag missing');
expect(coinbase.includes('984500F14CA4571AAC11'), 'Coinbase LEI missing');

console.log('Entity pages OK: ' + entities.length + ' generated profiles checked.');
