#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const entitiesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'entities.json'), 'utf8'));
const entities = entitiesData.entities || [];
const anomalyData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'anomalies.json'), 'utf8'));
const anomalies = anomalyData.anomalies || [];
const { formatLegalName } = require('../assets/js/legal-name');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function whiteOnlySvg(src) {
  if (!/\.svg$/i.test(String(src || ''))) return false;
  const file = path.join(ROOT, String(src).replace(/^\.\.\//, ''));
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const paints = [];
  const attributePattern = /\b(?:fill|stroke|stop-color|color)\s*=\s*(["'])(.*?)\1/gi;
  const stylePattern = /\b(?:fill|stroke|stop-color|color)\s*:\s*([^;}]+)/gi;
  let match;
  while ((match = attributePattern.exec(text))) paints.push(match[2]);
  while ((match = stylePattern.exec(text))) paints.push(match[1]);
  const visiblePaints = paints.map(function (paint) {
    return String(paint).replace(/\s+/g, '').toLowerCase();
  }).filter(function (paint) {
    return paint && paint !== 'none' && paint !== 'transparent' && paint !== 'currentcolor'
      && paint !== 'inherit' && !/^url\(/.test(paint);
  });
  return visiblePaints.length > 0 && visiblePaints.every(function (paint) {
    return paint === 'white' || paint === '#fff' || paint === '#ffff'
      || paint === '#ffffff' || paint === '#ffffffff'
      || paint === 'rgb(255,255,255)' || paint === 'rgb(100%,100%,100%)'
      || paint === 'rgba(255,255,255,1)' || paint === 'rgba(100%,100%,100%,1)'
      || paint === 'hsl(0,0%,100%)' || paint === 'hsla(0,0%,100%,1)';
  });
}

expect(entities.length > 250, 'expected resolved CASP entities');

entities.forEach(function (entity) {
  const file = path.join(ROOT, 'entities', entity.slug + '.html');
  expect(fs.existsSync(file), 'missing entity page: ' + entity.slug);
  const html = fs.readFileSync(file, 'utf8');
  const displayName = formatLegalName(entity.name);
  // Extensionless: the .html URL 308-redirects, so it must never be canonical.
  expect(html.includes('<link rel="canonical" href="https://micatracker.digital-euro-association.de/entities/' + entity.slug + '">'), 'bad canonical: ' + entity.slug);
  expect(html.includes(esc(entity.name)), 'entity name missing: ' + entity.slug);
  expect((html.match(/<h1\b/g) || []).length === 1 && html.includes('<h1 id="entity-name">'), 'entity page must have one entity H1: ' + entity.slug);
  expect(html.includes('<h1 id="entity-name">' + esc(displayName) + '</h1>'), 'entity display name missing from H1: ' + entity.slug);
  expect(html.includes('<dt><i class="fas fa-file" aria-hidden="true"></i>Legal name</dt><dd>' + esc(entity.name) + '</dd>'), 'source legal name missing: ' + entity.slug);
  expect(html.includes('<title>' + esc(displayName) + ' | MiCA CASP | ' + esc(entity.country) + ' | DEA Tracker</title>'), 'entity title missing country context: ' + entity.slug);
  expect(html.includes('"@type": "BreadcrumbList"'), 'breadcrumb structured data missing: ' + entity.slug);
  expect(html.includes('"@type": "WebPage"'), 'WebPage structured data missing: ' + entity.slug);
  expect(html.includes('"dateModified"'), 'structured-data freshness missing: ' + entity.slug);
  expect(html.includes('data-umami-event="entity-verify-affiliation"'), 'verification event missing: ' + entity.slug);
  expect(html.includes('data-umami-event="entity-suggest-correction"'), 'correction event missing: ' + entity.slug);
  expect(html.includes('View official ESMA source'), 'official source missing: ' + entity.slug);
  expect(html.includes('Membership is not regulatory endorsement.'), 'membership disclaimer missing: ' + entity.slug);
  expect(!html.includes('—'), 'entity page contains an em dash: ' + entity.slug);
});

// Validate aliases and data-quality notes against the current register snapshot.
// A fixed company-specific expectation can become stale when ESMA updates its records.
entities.filter(function (entity) {
  return Array.isArray(entity.alsoKnownAs) && entity.alsoKnownAs.length > 0;
}).forEach(function (entity) {
  const html = fs.readFileSync(path.join(ROOT, 'entities', entity.slug + '.html'), 'utf8');
  entity.alsoKnownAs.forEach(function (alias) {
    expect(html.includes(esc(alias)), 'entity alias missing: ' + entity.slug + ' (' + alias + ')');
  });
});

anomalies.filter(function (item) {
  return item.type === 'multi_authorisation';
}).forEach(function (anomaly) {
  const entity = entities.find(function (candidate) { return candidate.entityKey === anomaly.entityKey; });
  expect(entity, 'multi-authorisation anomaly has no resolved entity: ' + anomaly.entityKey);
  const html = fs.readFileSync(path.join(ROOT, 'entities', entity.slug + '.html'), 'utf8');
  expect(html.includes('Same legal entity, multiple register names'), 'multi-authorisation data note missing: ' + entity.slug);
});
 
const logos = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'casp-logos.json'), 'utf8'));
const entitySlugs = new Set(entities.map(function (entity) { return entity.slug; }));
Object.keys(logos).forEach(function (slug) {
  const logo = logos[slug];
  expect(entitySlugs.has(slug), 'logo manifest entry has no current entity: ' + slug);
  expect(!/(?:^|[^a-z0-9])(?:linkedin|facebook|instagram|twitter|youtube|tiktok|telegram|discord|icons?8)(?:[^a-z0-9]|$)/i.test(logo.sourceUrl || ''), 'social-media asset used as entity logo: ' + slug);
  expect(!/(?:^|\/)(?:logo[-_]?x|x[-_]?logo)\.(?:svg|png|webp)(?:$|[?#])/i.test(logo.sourceUrl || ''), 'social-media X asset used as entity logo: ' + slug);
  expect(!/\/(?:partners?|sponsors?|widgets?|tokens?|coins?|currencies?)(?:\/|[?#])/i.test(logo.sourceUrl || ''), 'non-brand asset used as entity logo: ' + slug);
  expect(/^\.\.\/assets\/casp-logos\/[A-Za-z0-9._-]+\.(?:png|svg|jpe?g|webp|avif|ico|gif)$/i.test(logo.src), 'unsafe logo asset path: ' + slug);
  expect(fs.existsSync(path.join(ROOT, logo.src.replace(/^\.\.\//, ''))), 'missing logo asset: ' + slug);
  const html = fs.readFileSync(path.join(ROOT, 'entities', slug + '.html'), 'utf8');
  expect(html.includes('class="entity-logo-image"'), 'logo missing from entity page: ' + slug);
  expect(html.includes('alt="' + esc(logo.alt) + '"'), 'logo alt text missing: ' + slug);
  if (logo.theme === 'dark') expect(html.includes('entity-logo-frame-dark'), 'dark logo theme missing: ' + slug);
  if (whiteOnlySvg(logo.src)) expect(logo.theme === 'dark', 'white-only SVG logo must declare dark theme: ' + slug);
});

const coinbase = fs.readFileSync(path.join(ROOT, 'entities', 'coinbase-luxembourg-s-a.html'), 'utf8');
expect(coinbase.includes('CSSF - Luxembourg'), 'Coinbase authority context missing');
expect(coinbase.includes('🇱🇺'), 'Coinbase authority flag missing');
expect(coinbase.includes('984500F14CA4571AAC11'), 'Coinbase LEI missing');
expect(!coinbase.includes('—'), 'Coinbase entity page contains an em dash');

console.log('Entity pages OK: ' + entities.length + ' generated profiles checked.');
