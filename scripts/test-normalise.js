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
test('repeated raw service wording remains a data-quality finding after mapping', () => {
    const { entities, anomalies } = N.buildEntities([{
        id: 1,
        lei: LEI_A,
        name: 'Ripple Payments Europe S.A.',
        memberState: 'LU',
        authority: 'CSSF',
        services: ['exchange funds', 'exchange crypto', 'transfer'],
        serviceCodeRaw: 'd. exchange of crypto-assets for other crypto-assets | d. exchange of crypto-assets for other crypto-assets',
        websites: []
    }]);
    assert.deepStrictEqual(entities[0].authorisations[0].services, ['exchange funds', 'exchange crypto', 'transfer']);
    assert.strictEqual(entities[0].authorisations[0].serviceCodeRaw.includes('| d.'), true);
    const finding = anomalies.find(a => a.type === N.ANOMALY_TYPES.REPEATED_SERVICE_CODE);
    assert.ok(finding, 'raw duplicate was not reported');
    assert.deepStrictEqual(finding.values, ['exchange crypto']);
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

console.log('\nnon-Latin names');
test('a wholly non-Latin name does not collapse to an empty key', () => {
    // The old normaliser stripped everything outside [a-z0-9], so two unrelated
    // Cyrillic-named firms in one country both keyed on '' and merged into a
    // single entity. Reconciliation still passed, so nothing reported it.
    const a = N.normaliseName('Банка');
    const b = N.normaliseName('Финанс');
    assert.notStrictEqual(a, '', 'Cyrillic name normalised to empty string');
    assert.notStrictEqual(b, '', 'Cyrillic name normalised to empty string');
    assert.notStrictEqual(a, b, 'two different Cyrillic names collided');
    assert.notStrictEqual(N.nameCountryKey('Банка', 'Bulgaria'),
        N.nameCountryKey('Финанс', 'Bulgaria'), 'distinct firms share an entity key');
});
test('two Cyrillic-named firms resolve to two entities, not one', () => {
    const { entities } = N.buildEntities([
        { id: 1, name: 'Банка', memberState: 'Bulgaria', authority: 'FSC', services: [], websites: [] },
        { id: 2, name: 'Финанс', memberState: 'Bulgaria', authority: 'FSC', services: [], websites: [] }
    ]);
    assert.strictEqual(entities.length, 2, `expected 2 entities, got ${entities.length}`);
});
test('a Cyrillic look-alike matches its Latin spelling', () => {
    // "Belayer OOD" is in the register spelled with Cyrillic O (U+041E).
    assert.strictEqual(N.normaliseName('Belayer ООD'), N.normaliseName('Belayer OOD'));
});
test('accented Latin still folds to plain ASCII', () => {
    assert.strictEqual(N.normaliseName('Société Générale'), 'societe generale');
});

console.log('\nLEI check digits');
test('a correct LEI passes mod-97', () => {
    assert.strictEqual(N.leiChecksumValid('5493007WZ7IFULIL8G21'), true);
});
test('a tampered digit fails mod-97', () => {
    assert.strictEqual(N.leiChecksumValid('5493007WZ7IFULIL8G22'), false);
});
test('a badly shaped value is not reported as a checksum failure', () => {
    // Wrong shape is a different problem, already handled by isValidLei.
    assert.strictEqual(N.leiChecksumValid('not-an-lei'), true);
    assert.strictEqual(N.leiChecksumValid(''), true);
});
test('a failing checksum is reported but still used as the entity key', () => {
    const { entities, anomalies } = N.buildEntities([
        { id: 1, name: 'Example AG', lei: '5493007WZ7IFULIL8G22', memberState: 'Germany',
          authority: 'BaFin', services: [], websites: [] }
    ]);
    const flagged = anomalies.filter(a => a.type === N.ANOMALY_TYPES.LEI_CHECKSUM_FAILED);
    assert.strictEqual(flagged.length, 1, 'checksum failure not reported');
    assert.strictEqual(entities[0].entityKey, '5493007WZ7IFULIL8G22',
        're-keying on a suspect LEI would break existing slugs and citations');
});

console.log('\ntraceability of findings');
test('every anomaly carries the source row it came from', () => {
    // Deliberately shaped to emit EVERY anomaly type at once. An earlier
    // version of this test used a single record, which can never produce a
    // multi_authorisation finding, so it passed while three anomalies in the
    // live data still had no sourceRow at all.
    const { anomalies } = N.buildEntities([
        { id: 1, name: 'A Ltd', lei: '5493007WZ7IFULIL8G22', memberState: 'Ireland',
          authority: 'CBI', services: ['custody', 'custody'],
          websites: ['75012 Paris', 'www.a.com', 'ttps://b.com'] },
        // same LEI, second authorisation -> multi_authorisation
        { id: 2, name: 'A Ltd (branch)', lei: '5493007WZ7IFULIL8G22', memberState: 'Ireland',
          authority: 'CBI', services: ['custody'], websites: [] },
        { id: 3, name: 'B Ltd', memberState: 'Malta', authority: 'MFSA',
          services: ['custody'], websites: ['https://b.example'] },
        // byte-identical to row 3 -> exact_duplicate
        { id: 4, name: 'B Ltd', memberState: 'Malta', authority: 'MFSA',
          services: ['custody'], websites: ['https://b.example'] }
    ]);

    const seen = new Set(anomalies.map(a => a.type));
    Object.values(N.ANOMALY_TYPES).forEach(type => {
        assert.ok(seen.has(type), `fixture did not emit ${type}, so it is untested here`);
    });

    const untraceable = anomalies.filter(a => a.sourceRow == null);
    assert.strictEqual(untraceable.length, 0,
        `findings with no sourceRow: ${untraceable.map(a => a.type).join(', ')}`);
});
test('a multi-row finding lists every row it spans', () => {
    const { anomalies } = N.buildEntities([
        { id: 1, name: 'A Ltd', lei: '6B2PBRV1FCJDMR45RZ53', memberState: 'Ireland',
          authority: 'CBI', services: [], websites: [] },
        { id: 2, name: 'A Ltd', lei: '6B2PBRV1FCJDMR45RZ53', memberState: 'Ireland',
          authority: 'CBI', services: [], websites: [] }
    ]);
    const multi = anomalies.find(a => a.type === N.ANOMALY_TYPES.MULTI_AUTHORISATION);
    assert.ok(multi, 'expected a multi_authorisation finding');
    assert.deepStrictEqual(multi.sourceRows, [1, 2]);
    assert.strictEqual(multi.sourceRow, 1);
});
test('a repaired website keeps both forms on the authorisation record', () => {
    // Previously the corrected URL replaced the original on the record, and the
    // original survived only inside a free-text anomaly detail.
    const { entities } = N.buildEntities([
        { id: 1, name: 'KBC Bank NV', lei: '6B2PBRV1FCJDMR45RZ53', memberState: 'Belgium',
          authority: 'NBB', services: [], websites: ['www.kbc.com'] }
    ]);
    const auth = entities[0].authorisations[0];
    assert.deepStrictEqual(auth.websites, ['https://www.kbc.com']);
    assert.deepStrictEqual(auth.websiteRepairs, [
        { raw: 'www.kbc.com', url: 'https://www.kbc.com' }
    ]);
});

console.log('\nfirstSeen survives a rename');
test('an entity renamed in the register keeps its original first-seen date', () => {
    const snapshots = [
        { date: '2025-11-20', casps: [
            { name: 'Old Name Ltd', memberState: 'Ireland', lei: '6B2PBRV1FCJDMR45RZ53' } ] },
        { date: '2026-08-01', casps: [
            { name: 'New Name Ltd', memberState: 'Ireland', lei: '6B2PBRV1FCJDMR45RZ53' } ] }
    ];
    const { entities } = N.buildEntities([
        { id: 1, name: 'New Name Ltd', lei: '6B2PBRV1FCJDMR45RZ53', memberState: 'Ireland',
          authority: 'CBI', services: [], websites: [] }
    ], { snapshots });
    assert.strictEqual(entities[0].firstSeen, '2025-11-20',
        'a rename reset firstSeen, making a long-tracked firm look new');
});
test('snapshots with no LEI still match on name and country', () => {
    const snapshots = [
        { date: '2025-11-20', casps: [{ name: 'Legacy Ltd', memberState: 'Ireland' }] }
    ];
    const { entities } = N.buildEntities([
        { id: 1, name: 'Legacy Ltd', lei: '6B2PBRV1FCJDMR45RZ53', memberState: 'Ireland',
          authority: 'CBI', services: [], websites: [] }
    ], { snapshots });
    assert.strictEqual(entities[0].firstSeen, '2025-11-20');
});

console.log('\ndata-quality page covers every anomaly type');

function groupedTypes() {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'assets', 'js', 'data-quality.js'), 'utf8');
    // GROUPS entries only. UNCATEGORISED declares types: [] and is the sink, so
    // a type "covered" by it is precisely the bug this guards against.
    const block = source.slice(
        source.indexOf('const GROUPS = ['), source.indexOf('const UNCATEGORISED'));
    const found = [];
    for (const arr of block.match(/types: \[[^\]]*\]/g) || []) {
        for (const t of arr.match(/'[a-z_]+'/g) || []) found.push(t.replace(/'/g, ''));
    }
    return { found, source };
}

test('every anomaly type is mapped to a group on data-quality.html', () => {
    // Without this, adding a type to normalise.js and forgetting the page would
    // publish the new finding under whatever the fallback happens to be. That
    // fallback used to be "Observations, not defects", whose copy states that
    // nothing is wrong with the records beneath it, so a genuine new defect
    // would have been announced to readers as harmless.
    const { found } = groupedTypes();
    const mapped = new Set(found);
    const missing = Object.values(N.ANOMALY_TYPES).filter(t => !mapped.has(t));
    assert.strictEqual(missing.length, 0,
        `not grouped on data-quality.html: ${missing.join(', ')} ` +
        '(add each to a GROUPS entry and give it a TYPE_LABELS label)');
});

test('every anomaly type has a human-readable label', () => {
    const { source } = groupedTypes();
    const labels = source.slice(
        source.indexOf('const TYPE_LABELS = {'), source.indexOf('const GROUPS = ['));
    const unlabelled = Object.values(N.ANOMALY_TYPES).filter(t => !labels.includes(t + ':'));
    assert.strictEqual(unlabelled.length, 0,
        `no label, so the badge would show the raw code: ${unlabelled.join(', ')}`);
});

test('no anomaly type is claimed by two groups at once', () => {
    const { found } = groupedTypes();
    assert.strictEqual(new Set(found).size, found.length,
        `a type appears in more than one group: ${found.join(', ')}`);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
