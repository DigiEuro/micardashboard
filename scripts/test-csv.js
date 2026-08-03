#!/usr/bin/env node
/*
 * test-csv.js — tests for the CSV reader that feeds every register.
 *
 * These exist because the previous reader split the export on '\n' before
 * parsing it. The ESMA register legitimately puts newlines inside quoted
 * cells, so records were torn in half: the tail became a row of its own,
 * every field after the break shifted one column left, and a Maltese address
 * fragment was published as a CASP named "Hardrocks Business Park". The same
 * shift blanked 18 websites and dropped Paysafe's LEI.
 *
 * The load-bearing assertion is the row count: a register export must yield
 * exactly as many records as it has logical rows, no matter where the
 * newlines fall.
 */
const assert = require('assert');
const { csvToArray, parseCsvGrid, extractLei, convertToCaspsData } = require('../update-data');

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

console.log('\nCSV grid parsing');
test('plain rows split on commas', () => {
    assert.deepStrictEqual(parseCsvGrid('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});
test('a comma inside a quoted field does not split it', () => {
    assert.deepStrictEqual(parseCsvGrid('a,"b,c",d'), [['a', 'b,c', 'd']]);
});
test('a newline inside a quoted field does not end the record', () => {
    const grid = parseCsvGrid('a,"line1\nline2",c\nx,y,z');
    assert.strictEqual(grid.length, 2, `expected 2 records, got ${grid.length}`);
    assert.deepStrictEqual(grid[0], ['a', 'line1\nline2', 'c']);
    assert.deepStrictEqual(grid[1], ['x', 'y', 'z']);
});
test('a doubled quote is one literal quote', () => {
    assert.deepStrictEqual(parseCsvGrid('"SIA ""Paybis Europe"""'), [['SIA "Paybis Europe"']]);
});
test('a leading doubled quote survives', () => {
    assert.deepStrictEqual(parseCsvGrid('"""Trek Technologies"" SIA"'), [['"Trek Technologies" SIA']]);
});
test('CRLF line endings do not leak into values', () => {
    assert.deepStrictEqual(parseCsvGrid('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
});
test('a trailing newline does not produce an empty record', () => {
    assert.deepStrictEqual(parseCsvGrid('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

console.log('\ncsvToArray');
test('a UTF-8 BOM is stripped from the first header', () => {
    const rows = csvToArray('﻿ae_lei,ae_lei_name\nX,Y');
    assert.deepStrictEqual(Object.keys(rows[0]), ['ae_lei', 'ae_lei_name']);
});
test('a multi-line cell yields one row, not two', () => {
    const csv = 'ae_lei_name,ae_lei,ae_website\n'
        + 'Paysafe,213800QBQVHWRBHJTA89,"www.skrill.com\nwww.neteller.com"\n'
        + 'Other,529900032TYR45XIEW79,https://example.com';
    const rows = csvToArray(csv);
    assert.strictEqual(rows.length, 2, `expected 2 rows, got ${rows.length}`);
    assert.strictEqual(rows[0].ae_lei, '213800QBQVHWRBHJTA89');
    assert.strictEqual(rows[1].ae_lei_name, 'Other');
});
test('blank lines are skipped without shifting later rows', () => {
    const rows = csvToArray('a,b\n1,2\n\n3,4');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].a, '3');
});

console.log('\nLEI extraction');
test('the LEI comes from ae_lei', () => {
    assert.strictEqual(extractLei({ ae_lei: '213800QBQVHWRBHJTA89' }), '213800QBQVHWRBHJTA89');
});
test('ae_lei_name never stands in for the code', () => {
    assert.strictEqual(extractLei({ ae_lei_name: 'Paysafe', ae_lei: '' }), '');
});
test('ae_lei_cou_code never stands in for the code', () => {
    // 'IE' is a country, not an LEI. Returning it made the data-quality
    // report claim a malformed LEI where the cell was simply empty.
    assert.strictEqual(extractLei({ ae_lei: '', ae_lei_cou_code: 'IE' }), '');
});
test('a country code does not win even when it is listed first', () => {
    assert.strictEqual(
        extractLei({ ae_lei_cou_code: 'IE', ae_lei: '213800QBQVHWRBHJTA89' }),
        '213800QBQVHWRBHJTA89'
    );
});

console.log('\nend to end: a register whose cells contain newlines');
test('a torn record does not invent a phantom CASP', () => {
    // The second record's address spans three lines, exactly as the Maltese
    // rows do in the real export.
    const csv = 'ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_address,ae_website,ac_serviceCode\n'
        + 'MFSA,MT,Real Entity Ltd,529900032TYR45XIEW79,MT,"Hardrocks Business Park\nLevel 2\nThe \'Fort\'",https://real.example,a. custody\n'
        + 'CBI,IE,Second Entity Ltd,213800QBQVHWRBHJTA89,IE,Dublin,https://second.example,c. exchange';
    const entries = convertToCaspsData(csvToArray(csv));
    assert.strictEqual(entries.length, 2, `expected 2 CASPs, got ${entries.length}`);
    assert.deepStrictEqual(entries.map(e => e.name), ['Real Entity Ltd', 'Second Entity Ltd']);
    assert.ok(!entries.some(e => /Hardrocks/.test(e.name)), 'address fragment leaked in as a CASP');
    // The shift used to blank the website of every torn record.
    assert.deepStrictEqual(entries[0].websites, ['https://real.example']);
    assert.strictEqual(entries[0].lei, '529900032TYR45XIEW79');
    assert.strictEqual(entries[1].lei, '213800QBQVHWRBHJTA89');
});
test('the live sheet schema keeps the LEI that sits after the website column', () => {
    // This is the exact shape that lost Paysafe's LEI in production. In the
    // sheet, ae_lei comes AFTER ae_website, and Paysafe is the one row whose
    // website cell holds two URLs on separate lines. Splitting on '\n' ended
    // the record inside that cell, so everything up to ae_website survived
    // (name, authority, member state, services all looked right) while ae_lei
    // sat on the orphaned second line and was never read.
    const header = 'Authority,ae_competentAuthority,ae_homeMemberState,ae_lei_name,'
        + 'ac_serviceCode,ae_website,ae_lei,esma_status';
    const csv = header + '\n'
        + 'CBI,CBI,Ireland,Paysafe Payment Solutions Limited.,custody | transfer,'
        + '"www.skrill.com\nwww.neteller.com",213800QBQVHWRBHJTA89,\n'
        + 'CBI,CBI,Ireland,CoinJar Europe Limited,custody,https://www.coinjar.com,98450066Q3A1G1A4T786,';
    const entries = convertToCaspsData(csvToArray(csv));
    assert.strictEqual(entries.length, 2, `expected 2 CASPs, got ${entries.length}`);
    assert.strictEqual(entries[0].lei, '213800QBQVHWRBHJTA89', 'Paysafe lost its LEI again');
    assert.deepStrictEqual(entries[0].websites, ['www.skrill.com', 'www.neteller.com']);
    // The row after the torn one must not be swallowed or shifted.
    assert.strictEqual(entries[1].name, 'CoinJar Europe Limited');
    assert.strictEqual(entries[1].lei, '98450066Q3A1G1A4T786');
});
test('a trailing space does not invalidate an otherwise good LEI', () => {
    // K33 MARKETS carries '6367008S3JL8VVP6T689 ' in the sheet.
    const csv = 'ae_lei_name,ae_lei\nK33 MARKETS as,6367008S3JL8VVP6T689 ';
    const [entry] = convertToCaspsData(csvToArray(csv));
    assert.strictEqual(entry.lei, '6367008S3JL8VVP6T689');
});
test('a multi-line website cell becomes separate websites', () => {
    const csv = 'ae_lei_name,ae_lei,ae_website\n'
        + 'Paysafe,213800QBQVHWRBHJTA89,"www.skrill.com\nwww.neteller.com"';
    const [entry] = convertToCaspsData(csvToArray(csv));
    assert.deepStrictEqual(entry.websites, ['www.skrill.com', 'www.neteller.com']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
