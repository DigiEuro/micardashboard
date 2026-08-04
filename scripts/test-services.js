#!/usr/bin/env node
/* Tests for the versioned ESMA service-text mapper. */
const assert = require('assert');
const { deriveServiceCodes } = require('./services');

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

console.log('\nRaw MiCAR service mapping');

test('maps the complete ESMA service set in source order', () => {
    const raw = [
        'a. providing custody and administration of crypto-assets on behalf of clients',
        'b. operation of a trading platform for crypto-assets',
        'c. exchange of crypto-assets for funds',
        'd. exchange of crypto-assets for other crypto-assets',
        'e. execution of orders for crypto-assets on behalf of clients',
        'f. placing of crypto-assets',
        'g. reception and transmission of orders for crypto-assets on behalf of clients',
        'h. providing advice on crypto-assets',
        'i. providing portfolio management on crypto-assets',
        'j. providing transfer services for crypto-assets on behalf of clients'
    ].join(' | ');

    assert.deepStrictEqual(deriveServiceCodes(raw), [
        'custody', 'trading platform', 'exchange funds', 'exchange crypto',
        'execution', 'placing', 'RTO', 'advice', 'portfolio mgmt', 'transfer'
    ]);
});

test('handles malformed separators and truncated exchange wording', () => {
    const raw = 'a. providing custody and administration of crypto-assets on behalf of clients.'
        + 'I c. exchange of crypto-assets for other |'
        + 'e. execution of orders for crypto-assets on behalf of clients.j. providing transfer services';
    assert.deepStrictEqual(deriveServiceCodes(raw), [
        'custody', 'exchange crypto', 'execution', 'transfer'
    ]);
});

test('does not duplicate a service mentioned more than once', () => {
    assert.deepStrictEqual(
        deriveServiceCodes('c. exchange of crypto-assets for funds | c. exchange of crypto-assets for funds'),
        ['exchange funds']
    );
});

test('returns no code for an empty source value', () => {
    assert.deepStrictEqual(deriveServiceCodes(''), []);
    assert.deepStrictEqual(deriveServiceCodes(null), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
