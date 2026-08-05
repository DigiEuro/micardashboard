#!/usr/bin/env node
/* Rebuilds crawlable HTML and sitemap artifacts from the committed JSON data. */
const fs = require('fs');
const path = require('path');
const { generateEntityPages } = require('./generate-entity-pages');
const { writeSitemap, generateAllSnapshots } = require('../update-data');

const ROOT = path.join(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'snapshot.json'), 'utf8'));
const lastmod = String(snapshot.lastUpdated || snapshot.caspsSnapshotDate || snapshot.emtSnapshotDate || '').slice(0, 10);

generateEntityPages();
writeSitemap(lastmod);
generateAllSnapshots();
console.log('Static entity pages, register snapshots and sitemap refreshed.');
