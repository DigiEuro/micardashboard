#!/usr/bin/env node
/*
 * test-normalise.js: tests for entity resolution and normalisation.
 *
 * The load-bearing assertion is reconciliation: every source row must survive
 * into entities.json. A normalisation step that silently drops a row would be
 * worse than no normalisation at all.
 */
const assert = require('assert');
const N = require('./normalise');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed += 1;
    } catch (error) {
        console.log(`  ❌ ${name}\n     ${error.message}`);
        failed += 1;
    }
}

const LEI_A = '5493007WZ7IFULIL8G21';
const LEI_B = '529900032TYR45XIEW79';

console.log('\nwebsite normalisation');
test('valid https passes through untouched', () => {
    const r = N.normaliseWebsite('https://www.bitpanda.com');
    assert.strictEqual(r.url, 'https://www.bitpanda.com');
    assert.strictEqual(r.issue, null);
});
test('bare domain gets a scheme and is flagged', () => {
    const r = N.normaliseWebsite('www.kbc.com');
    assert.strictEqual(r.url, 'https://www.kbc.com');
    assert.strictEqual(r.issue, N.ANOMALY_TYPES.MALFORMED_URL);
});
test('truncated scheme is repaired as an encoding artefact', () => {
    const r = N.normaliseWebsite('ttps://minos.global');
    assert.strictEqual(r.url, 'https://minos.global');
    assert.strictEqual(r.issue, N.ANOMALY_TYPES.ENCODING_ARTEFACT);
});
test('mistyped scheme separator is repaired (https.// -> https://)', () => {
    const r = N.normaliseWebsite('https.//coinbase.com');
    assert.strictEqual(r.url, 'https://coinbase.com');
    assert.strictEqual(r.issue, N.ANOMALY_TYPES.ENCODING_ARTEFACT);
});
test('postal address is not a URL and is preserved raw', () => {
    const r = N.normaliseWebsite('75012 Paris');
    assert.strictEqual(r.url, '');
    assert.strictEqual(r.raw, '75012 Paris');
    assert.strictEqual(r.issue, N.ANOMALY_TYPES.NON_URL_IN_WEBSITE_FIELD);
});
test('prose fragment is not a URL', () => {
    const r = N.normaliseWebsite('N26 – Die erste Onlinebank');
    assert.strictEqual(r.url, '');
    assert.strictEqual(r.issue, N.ANOMALY_TYPES.NON_URL_IN_WEBSITE_FIELD);
});
test('raw value is always preserved', () => {
    ['75012 Paris', 'www.x.com', 'ttps://y.com', 'https://z.com'].forEach(v => {
        assert.strictEqual(N.normaliseWebsite(v).raw, v);
    });
});

console.log('\nentity keys');
test('valid LEI is used as the key', () => {
    const { key, keySource } = N.entityKeyFor({ lei: LEI_A, name: 'X', memberState: 'Austria' });
    assert.strictEqual(key, LEI_A);
    assert.strictEqual(keySource, 'lei');
});
test('missing LEI falls back to a name+country hash', () => {
    const { key, keySource } = N.entityKeyFor({ name: 'Ramp Swaps', memberState: 'Ireland' });
    assert.ok(key.startsWith('nc:'));
    assert.strictEqual(keySource, 'name-country');
});
test('malformed LEI is rejected, not used as a key', () => {
    const { keySource } = N.entityKeyFor({ lei: 'GARBAGE', name: 'X', memberState: 'Malta' });
    assert.strictEqual(keySource, 'name-country');
});
test('name+country key is stable across formatting differences', () => {
    assert.strictEqual(
        N.nameCountryKey('  Société   Générale ', 'France'),
        N.nameCountryKey('Societe Generale', 'france')
    );
});
test('same name in different countries yields different keys', () => {
    assert.notStrictEqual(N.nameCountryKey('Acme Ltd', 'Malta'), N.nameCountryKey('Acme Ltd', 'Ireland'));
});

console.log('\nentity resolution');
test('two records sharing an LEI resolve to ONE entity with two authorisations', () => {
    const { entities } = N.buildEntities([
        { id: 1, lei: LEI_B, name: 'EUWAX AG', memberState: 'Germany', authority: 'BaFin', services: ['custody'], websites: [] },
        { id: 2, lei: LEI_B, name: 'EUWAX AG', memberState: 'Germany', authority: 'BaFin', services: ['transfer'], websites: [] }
    ]);
    assert.strictEqual(entities.length, 1);
    assert.strictEqual(entities[0].authorisations.length, 2);
    assert.deepStrictEqual(entities[0].services, ['custody', 'transfer']);
});
test('different NAMES sharing an LEI resolve to one entity and record alsoKnownAs', () => {
    const { entities, anomalies } = N.buildEntities([
        { id: 1, lei: LEI_A, name: 'FLOWDESK EUROPE SAS', memberState: 'France', authority: 'AMF', services: [], websites: [] },
        { id: 2, lei: LEI_A, name: 'APLO SAS', memberState: 'France', authority: 'AMF', services: [], websites: [] }
    ]);
    assert.strictEqual(entities.length, 1);
    assert.deepStrictEqual(entities[0].alsoKnownAs, ['APLO SAS']);
    assert.ok(anomalies.some(a => a.type === N.ANOMALY_TYPES.MULTI_AUTHORISATION));
});
test('repeated service codes are reported but the raw order is preserved', () => {
    const { entities, anomalies } = N.buildEntities([
        { id: 1, lei: LEI_A, name: 'X', memberState: 'DE', authority: 'BaFin', services: ['execution', 'execution', 'placing'], websites: [] }
    ]);
    assert.deepStrictEqual(entities[0].authorisations[0].services, ['execution', 'placing']);
    assert.deepStrictEqual(entities[0].authorisations[0].servicesRaw, ['execution', 'execution', 'placing']);
    assert.ok(anomalies.some(a => a.type === N.ANOMALY_TYPES.REPEATED_SERVICE_CODE));
});
test('slugs are unique even for identically named entities', () => {
    const { entities } = N.buildEntities([
        { id: 1, name: 'Acme Ltd', memberState: 'Malta', authority: 'MFSA', services: [], websites: [] },
        { id: 2, name: 'Acme Ltd', memberState: 'Ireland', authority: 'CBI', services: [], websites: [] }
    ]);
    const slugs = entities.map(e => e.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length, 'slugs collided: ' + slugs.join(', '));
});

console.log('\nHARD RULE: nothing is deleted');
test('every source row survives as an authorisation record', () => {
    const rows = [
        { id: 1, lei: LEI_A, name: 'A', memberState: 'DE', authority: 'BaFin', services: [], websites: ['https://a.com'] },
        { id: 2, lei: LEI_A, name: 'A', memberState: 'DE', authority: 'BaFin', services: [], websites: ['https://a.com'] },
        { id: 3, name: 'B', memberState: 'IE', authority: 'CBI', services: [], websites: ['75012 Paris'] },
        { id: 4, lei: 'BAD', name: 'C', memberState: 'MT', authority: 'MFSA', services: [], websites: [] }
    ];
    const { entities } = N.buildEntities(rows);
    const total = entities.reduce((n, e) => n + e.authorisations.length, 0);
    assert.strictEqual(total, rows.length, `expected ${rows.length} authorisations, got ${total}`);
});
test('unusable website values are preserved in websitesRaw, never discarded', () => {
    const { entities } = N.buildEntities([
        { id: 1, name: 'X', memberState: 'FR', authority: 'AMF', services: [], websites: ['75012 Paris', 'www.x.com'] }
    ]);
    const auth = entities[0].authorisations[0];
    assert.deepStrictEqual(auth.websitesRaw, ['75012 Paris']);
    assert.deepStrictEqual(auth.websites, ['https://www.x.com']);
});
test('exact duplicate rows are both retained and flagged', () => {
    const row = { lei: LEI_A, name: 'A', memberState: 'DE', authority: 'BaFin', services: ['custody'], websites: [] };
    const { entities, anomalies } = N.buildEntities([{ ...row, id: 1 }, { ...row, id: 2 }]);
    assert.strictEqual(entities[0].authorisations.length, 2);
    assert.ok(anomalies.some(a => a.type === N.ANOMALY_TYPES.EXACT_DUPLICATE));
});

console.log('\nreconciliation against the live register');
test('live CASP register reconciles exactly', () => {
    const casps = require('../data/casps.json');
    const { entities } = N.buildEntities(casps);
    const total = entities.reduce((n, e) => n + e.authorisations.length, 0);
    assert.strictEqual(total, casps.length,
        `source rows ${casps.length} != authorisation records ${total}`);
    const keys = entities.map(e => e.entityKey);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate entity keys');
    const slugs = entities.map(e => e.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length, 'duplicate slugs');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
