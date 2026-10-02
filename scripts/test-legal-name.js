#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { formatLegalName } = require('../assets/js/legal-name');

const ROOT = path.join(__dirname, '..');

const examples = [
  ['Invity Finance s.r.o.', 'Invity Finance s.r.o.'],
  ['MP Developers s.r.o.', 'MP Developers s.r.o.'],
  ['ILAVO GROUP a.s.', 'Ilavo Group a.s.'],
  ['COINMATE a.s.', 'Coinmate a.s.'],
  ['TRIA BRIDGE LIMITED (ex Tokenomica Bridge Ltd)', 'Tria Bridge Limited (ex Tokenomica Bridge Ltd)'],
  ['COLLECT & EXCHANGE CY LTD', 'Collect & Exchange CY Ltd'],
  ['PROSEGUR CUSTODIA DE ACTIVOS DIGITALES S.L.U.', 'Prosegur Custodia de Activos Digitales S.L.U.'],
  ['CACEIS BANK', 'Caceis Bank'],
  ['CAIXABANK S.A.', 'CaixaBank S.A.'],
  ['COMPLYCRYPTO DEPOSITORY EU LIMITED', 'ComplyCrypto Depository EU Limited'],
  ['Altcoins BG EООD', 'Altcoins BG EООD'],
  ['DUE NETWORK S.L.', 'Due Network S.L.'],
  ['BASQUE PAY S.L.', 'Basque Pay S.L.'],
  ['IN KAPITAL limited liability company for trade and services', 'In Kapital limited liability company for trade and services'],
  ['COINSHARES ASSET MANAGEMENT', 'CoinShares Asset Management'],
  ['CHECKSIG S.R.L. SOCIETÀ BENEFIT', 'CheckSig S.R.L. Società Benefit'],
  ['BANQUE DELUBAC ET CIE', 'Banque Delubac et Cie'],
  ['AK JENSEN NORWAY AS', 'AK Jensen Norway AS'],
  ['bitFlyer EUROPE S.A.', 'bitFlyer Europe S.A.']
];

examples.forEach(function (example) {
  assert.strictEqual(formatLegalName(example[0]), example[1], example[0]);
});

const casps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'casps.json'), 'utf8'));
const changed = casps.filter(function (item) {
  return formatLegalName(item.name) !== item.name;
});

casps.forEach(function (item) {
  const displayName = formatLegalName(item.name);
  assert.ok(displayName, 'display name is empty: ' + item.name);
  assert.strictEqual(formatLegalName(displayName), displayName, 'formatter is not idempotent: ' + item.name);
});

assert.ok(changed.length > 0, 'current CASP data should exercise display-name normalisation');
console.log('Legal-name display formatting OK: ' + changed.length + ' of ' + casps.length + ' CASP rows normalised for presentation.');
