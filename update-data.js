const fs = require('fs');
const path = require('path');
const { csvUrl, dateUrl, nonCompliantUrl, caspsUrl } = require('./config');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1RfeiT68rH65izevXw_Upqdn0lXz-IGI83Zn3q0SBEbE';

const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const EMT_DATA_FILE = path.join(DATA_DIR, 'emts.json');
const CASPS_DATA_FILE = path.join(DATA_DIR, 'casps.json');
const NON_COMPLIANT_DATA_FILE = path.join(DATA_DIR, 'non-compliant.json');
const CHANGELOG_FILE = path.join(DATA_DIR, 'changelog.json');
const FEED_FILE = path.join(__dirname, 'feed.xml');
const SITEMAP_FILE = path.join(__dirname, 'sitemap.xml');

// Static, crawlable pages served by GitHub Pages. Entity pages are generated
// separately; keep this list in sync when adding intent pages.
const SITEMAP_PAGES = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/casp-tracker.html', priority: '0.9', changefreq: 'weekly' },
    { loc: '/emt-tracker.html', priority: '0.9', changefreq: 'weekly' },
    { loc: '/non-compliant-casps.html', priority: '0.9', changefreq: 'weekly' },
    { loc: '/about.html', priority: '0.5', changefreq: 'monthly' }
];

const SITE_URL = 'https://micatracker.digital-euro-association.de';
const CHANGELOG_MAX_ENTRIES = 50;
const FEED_MAX_ITEMS = 20;

// Ranges are open-ended on purpose: fixed row caps (e.g. A1:F150) silently
// truncate once the register outgrows them - CASPs already exceed 150 rows.
const SHEET_CONFIG = {
    snapshot: { label: 'Snapshot dates', range: 'snapshot!A1:B3' },
    emt: { label: 'EMTs register', range: 'Jurisdiction!A:Z', requireNumericId: true },
    casps: { label: 'CASPs register', range: 'CASPs!A:F' },
    nonCompliant: { label: 'Non-compliant register', range: "'Non Compliant'!A:E" }
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function hasNumericId(row) {
    return Boolean(row['#']) && row['#'] !== 'nan' && !isNaN(parseInt(row['#']));
}

function csvToArray(str, { requireNumericId = false } = {}) {
    const lines = str.split('\n');
    const headers = parseCSVLine(lines[0]);
    const result = [];

    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
            const values = parseCSVLine(lines[i]);
            const obj = {};
            headers.forEach((header, index) => {
                obj[header.trim()] = values[index] ? values[index].trim() : '';
            });
            result.push(obj);
        }
    }

    return requireNumericId ? result.filter(hasNumericId) : result;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    result.push(current);
    return result;
}

function parseNumber(value) {
    if (!value || value === 'nan' || value === '') return 0;
    const num = parseInt(value);
    return isNaN(num) ? 0 : num;
}

function ensureDataDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function readJsonFile(filePath, defaultValue = null) {
    try {
        if (!fs.existsSync(filePath)) {
            return defaultValue;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`⚠️ Could not read ${filePath}: ${error.message}`);
        return defaultValue;
    }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.warn(`⚠️ Failed to write ${filePath}: ${error.message}`);
    }
}

function getStoredSnapshot() {
    return readJsonFile(SNAPSHOT_FILE, null);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function buildApiErrorMessage(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try {
            const payload = await response.json();
            if (payload && payload.error) {
                const status = payload.error.status ? `${payload.error.status} ` : '';
                return `HTTP ${response.status} ${status}- ${payload.error.message}`;
            }
            return `HTTP ${response.status} - ${JSON.stringify(payload)}`;
        } catch (error) {
            return `HTTP ${response.status} - Failed to parse JSON error: ${error.message}`;
        }
    }

    const text = await response.text();
    return `HTTP ${response.status} ${response.statusText || ''} - ${text.substring(0, 200)}`;
}

async function fetchWithRetry(url, options = {}, label = 'request', maxAttempts = 3) {
    let attempt = 1;
    let delayMs = 500;

    while (attempt <= maxAttempts) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                return response;
            }

            const errorMessage = await buildApiErrorMessage(response);
            if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
                throw new Error(errorMessage);
            }

            console.warn(`⚠️ ${label} failed with ${errorMessage}. Retrying in ${delayMs}ms...`);
        } catch (error) {
            if (attempt === maxAttempts) {
                throw error;
            }
            console.warn(`⚠️ ${label} request error: ${error.message}. Retrying in ${delayMs}ms...`);
        }

        await delay(delayMs);
        delayMs *= 2;
        attempt += 1;
    }

    throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

async function fetchSheetValues(rangeKey) {
    if (!GOOGLE_API_KEY || !GOOGLE_SHEET_ID) {
        return null;
    }

    const config = SHEET_CONFIG[rangeKey];
    if (!config) {
        console.warn(`⚠️ Unknown sheet range key: ${rangeKey}`);
        return null;
    }

    const encodedRange = encodeURIComponent(config.range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodedRange}?key=${GOOGLE_API_KEY}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

    const response = await fetchWithRetry(url, {}, config.label);
    const payload = await response.json();
    return payload && payload.values ? payload.values : [];
}

function valuesToObjectArray(values, { requireNumericId = false } = {}) {
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }

    const headers = (values[0] || []).map(header => (header === undefined || header === null ? '' : String(header)).trim());
    const rows = [];

    for (let i = 1; i < values.length; i++) {
        const rowValues = values[i] || [];
        if (rowValues.every(cell => cell === undefined || cell === null || String(cell).trim() === '')) {
            continue;
        }

        const rowObject = {};
        headers.forEach((header, index) => {
            if (!header) {
                return;
            }
            const cellValue = rowValues[index];
            rowObject[header] = cellValue === undefined || cellValue === null ? '' : String(cellValue).trim();
        });
        rows.push(rowObject);
    }

    return requireNumericId ? rows.filter(hasNumericId) : rows;
}

function valuesToDateMap(values) {
    if (!Array.isArray(values)) {
        return {};
    }

    const map = {};
    values.forEach((row, index) => {
        if (!Array.isArray(row)) {
            return;
        }
        const key = row[0] !== undefined && row[0] !== null ? String(row[0]).trim() : `row_${index}`;
        const value = row[1] !== undefined && row[1] !== null ? String(row[1]).trim() : '';
        if (key) {
            map[key] = value;
        }
    });
    return map;
}

function hasSnapshotChanged(previousSnapshot, currentSnapshot) {
    if (!previousSnapshot) {
        return true;
    }

    const prevEmt = previousSnapshot.emtSnapshotDate || '';
    const prevCasps = previousSnapshot.caspsSnapshotDate || '';
    const currEmt = currentSnapshot.emtSnapshotDate || '';
    const currCasps = currentSnapshot.caspsSnapshotDate || '';

    return prevEmt !== currEmt || prevCasps !== currCasps;
}

async function fetchSnapshotDates() {
    if (GOOGLE_API_KEY) {
        try {
            const values = await fetchSheetValues('snapshot');
            if (values && values.length) {
                const dateMap = valuesToDateMap(values);
                console.log('📅 Snapshot dates fetched via Sheets API');
                return { dateMap, source: 'api' };
            }
        } catch (error) {
            console.warn(`⚠️ Snapshot API fetch failed: ${error.message}`);
        }
    }

    const dateCsv = await fetchCsv(dateUrl, 'snapshot date feed');
    ensureCsvResponseValid(dateCsv, 'snapshot date feed');
    const dateMap = extractDatesFromCsv(dateCsv);
    console.log('📅 Snapshot dates fetched via CSV export');
    return { dateMap, source: 'csv' };
}

async function fetchEmtEntries() {
    if (GOOGLE_API_KEY) {
        try {
            const values = await fetchSheetValues('emt');
            const rows = valuesToObjectArray(values, { requireNumericId: true });
            if (rows.length) {
                console.log(`📗 EMT rows fetched via Sheets API: ${rows.length}`);
                return { entries: convertToJsData(rows), source: 'api' };
            }
            console.warn('⚠️ EMT API response did not include any rows.');
        } catch (error) {
            console.warn(`⚠️ EMT API fetch failed: ${error.message}`);
        }
    }

    const csvText = await fetchCsv(csvUrl, 'issuer feed');
    ensureCsvResponseValid(csvText, 'issuer feed');
    const rows = csvToArray(csvText, { requireNumericId: true });
    return { entries: convertToJsData(rows), source: 'csv' };
}

async function fetchNonCompliantEntries() {
    if (GOOGLE_API_KEY) {
        try {
            const values = await fetchSheetValues('nonCompliant');
            const rows = valuesToObjectArray(values);
            if (rows.length) {
                console.log(`🚨 Non-compliant rows fetched via Sheets API: ${rows.length}`);
                return { entries: convertToNonCompliantData(rows), source: 'api' };
            }
            console.warn('⚠️ Non-compliant API response was empty.');
        } catch (error) {
            console.warn(`⚠️ Non-compliant API fetch failed: ${error.message}`);
        }
    }

    const csvText = await fetchCsv(nonCompliantUrl, 'non-compliant feed');
    ensureCsvResponseValid(csvText, 'non-compliant feed');
    const rows = csvToArray(csvText);
    return { entries: convertToNonCompliantData(rows), source: 'csv' };
}

async function fetchCaspsEntries() {
    if (GOOGLE_API_KEY) {
        try {
            const values = await fetchSheetValues('casps');
            const rows = valuesToObjectArray(values);
            if (rows.length) {
                console.log(`🏛️ CASPs rows fetched via Sheets API: ${rows.length}`);
                return { entries: convertToCaspsData(rows), source: 'api' };
            }
            console.warn('⚠️ CASPs API response was empty.');
        } catch (error) {
            console.warn(`⚠️ CASPs API fetch failed: ${error.message}`);
        }
    }

    const csvText = await fetchCsv(caspsUrl, 'CASPs feed');
    ensureCsvResponseValid(csvText, 'CASPs feed');
    const rows = csvToArray(csvText);
    return { entries: convertToCaspsData(rows), source: 'csv' };
}

async function fetchCsv(url, label = 'CSV export') {
    console.log('🌐 Fetching:', url);
    const res = await fetchWithRetry(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/csv,text/plain,*/*',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
    }, label);
    return res.text();
}

function extractDatesFromCsv(csv) {
    const lines = csv.trim().split('\n');
    const dateMap = {};

    lines.forEach((line, index) => {
        if (!line.trim()) {
            return;
        }

        const values = parseCSVLine(line);
        const key = values[0] ? values[0].trim() : `row_${index}`;
        const value = values[1] ? values[1].trim() : '';

        if (key) {
            dateMap[key] = value;
        }
    });

    return dateMap;
}

function formatDate(dateStr) {
    if (!dateStr) {
        const today = new Date();
        const longDate = today.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        return {
            longDate,
            shortDate: longDate
        };
    }

    const parts = dateStr.split(/[\/\-]/);
    let day, month, year;
    if (parts[0].length === 4) {
        [year, month, day] = parts; // Format: YYYY-MM-DD
    } else {
        [day, month, year] = parts; // Format: DD-MM-YYYY or DD/MM/YYYY
    }

    const dateObj = new Date(`${year}-${month}-${day}`);
    const longDate = dateObj.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
    return {
        longDate,
        shortDate: longDate
    };
}

const EMT_STANDARD_HEADERS = new Set([
    '#',
    'Issuer (HQ)',
    'Home State',
    'Competent Authority',
    'Authorised EMT(s)',
    'Tokens'
]);

const CURRENCY_HEADER_KEY_ALIASES = {
    euro: 'eur'
};

function currencyHeaderToKey(header) {
    const normalizedHeader = header.trim().toLowerCase();
    return CURRENCY_HEADER_KEY_ALIASES[normalizedHeader] || normalizedHeader;
}

function getEmtCurrencyHeaders(rows) {
    const headers = new Set();

    rows.forEach(row => {
        Object.keys(row || {}).forEach(header => {
            if (header && !EMT_STANDARD_HEADERS.has(header)) {
                headers.add(header);
            }
        });
    });

    return Array.from(headers);
}

function convertToJsData(csvData) {
    const data = [];
    const currencyHeaders = getEmtCurrencyHeaders(csvData);

    console.log('📋 CSV Headers:', Object.keys(csvData[0] || {}));
    console.log('💱 Currency Headers:', currencyHeaders);
    console.log('📊 Processing', csvData.length, 'rows');

    csvData.forEach((row, index) => {
        if (row['#'] && row['Issuer (HQ)'] && row['Issuer (HQ)'] !== 'nan') {
            const item = {
                id: parseInt(row['#']) || index + 1,
                issuer: row['Issuer (HQ)'] || '',
                state: row['Home State'] || '',
                authority: row['Competent Authority'] || '',
                tokens: row['Authorised EMT(s)'] || '',
                count: parseNumber(row['Tokens'])
            };

            currencyHeaders.forEach(header => {
                item[currencyHeaderToKey(header)] = parseNumber(row[header]);
            });

            data.push(item);
        }
    });

    console.log(`📗 Converted ${data.length} EMT issuer rows`);

    return data;
}

function parseMultiValueField(value) {
    if (!value) {
        return [];
    }

    return value
        .split(/\||,|;|\s{2,}/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

function convertToCaspsData(csvData) {
    return csvData
        .filter(row => (row['ae_lei_name'] || '').trim())
        .map((row, index) => ({
            id: index + 1,
            name: row['ae_lei_name'] ? row['ae_lei_name'].trim() : '',
            authority: row['ae_competentAuthority'] ? row['ae_competentAuthority'].trim() : '',
            memberState: row['ae_homeMemberState'] ? row['ae_homeMemberState'].trim() : '',
            services: parseMultiValueField(row['ac_serviceCode']),
            websites: parseMultiValueField(row['ae_website'])
        }));
}

const memberStateMap = {
    'AT': 'Austria',
    'BE': 'Belgium',
    'BG': 'Bulgaria',
    'HR': 'Croatia',
    'CY': 'Cyprus',
    'CZ': 'Czech Republic',
    'DK': 'Denmark',
    'EE': 'Estonia',
    'FI': 'Finland',
    'FR': 'France',
    'DE': 'Germany',
    'GR': 'Greece',
    'HU': 'Hungary',
    'IE': 'Ireland',
    'IT': 'Italy',
    'LV': 'Latvia',
    'LT': 'Lithuania',
    'LU': 'Luxembourg',
    'MT': 'Malta',
    'NL': 'Netherlands',
    'PL': 'Poland',
    'PT': 'Portugal',
    'RO': 'Romania',
    'SK': 'Slovakia',
    'SI': 'Slovenia',
    'ES': 'Spain',
    'SE': 'Sweden',
    'IS': 'Iceland',
    'LI': 'Liechtenstein',
    'NO': 'Norway',
    'UK': 'United Kingdom'
};

function mapMemberState(code) {
    if (!code) return '';
    const trimmed = code.trim();
    return memberStateMap[trimmed.toUpperCase()] || trimmed;
}

function getCurrencyFieldsFromItems(items) {
    const standardFields = new Set(['id', 'issuer', 'state', 'authority', 'tokens', 'count']);
    const fields = new Set();

    items.forEach(item => {
        Object.keys(item || {}).forEach(key => {
            if (!standardFields.has(key)) {
                fields.add(key);
            }
        });
    });

    return Array.from(fields);
}

function calculateCurrencyTotals(items, currencyFields) {
    return Object.fromEntries(currencyFields.map(currency => [
        currency,
        items.reduce((sum, item) => sum + (item[currency] || 0), 0)
    ]));
}

function convertToNonCompliantData(csvData) {
    const entries = [];
    const entryIndexByKey = new Map();

    csvData.forEach((row, index) => {
        const entity = row['Commercial Name'] || '';
        const authority = row['Competent Authority'] || '';
        const memberState = mapMemberState(row['Member State'] || '');
        const websites = (row['ae_website'] || '')
            .split('|')
            .map(site => site.trim())
            .filter(site => site.length > 0);
        const isNew = (row['Column 1'] || '').toLowerCase() === 'new';

        if (!entity) {
            return;
        }

        const dedupeKey = `${entity}::${memberState}::${websites.join('|')}`;
        if (entryIndexByKey.has(dedupeKey)) {
            const existingIndex = entryIndexByKey.get(dedupeKey);
            const existingEntry = entries[existingIndex];
            if (isNew && !existingEntry.isNew) {
                existingEntry.isNew = true;
                console.log('🔄 Updated existing non-compliant entry to NEW status:', entity);
            }
            return;
        }

        entryIndexByKey.set(dedupeKey, entries.length);

        entries.push({
            id: entries.length + 1,
            entity,
            country: memberState,
            authority,
            websites,
            isNew
        });
    });

    console.log(`🚨 Converted ${entries.length} non-compliant entities`);
    return entries;
}

function warnOnShrunkenDataset(label, filePath, newEntries) {
    const previous = readJsonFile(filePath, null);
    if (!Array.isArray(previous) || previous.length === 0 || !Array.isArray(newEntries)) {
        return;
    }
    if (newEntries.length < previous.length * 0.7) {
        console.warn(`⚠️ ${label} shrank from ${previous.length} to ${newEntries.length} rows - check the source sheet before trusting this update.`);
    }
}

function diffRegister(previous, current, keyFn, nameFn) {
    if (!Array.isArray(previous) || !Array.isArray(current)) {
        return null;
    }

    const prevByKey = new Map(previous.map(item => [keyFn(item), item]));
    const currByKey = new Map(current.map(item => [keyFn(item), item]));

    const added = [...currByKey.entries()]
        .filter(([key]) => !prevByKey.has(key))
        .map(([, item]) => nameFn(item));
    const removed = [...prevByKey.entries()]
        .filter(([key]) => !currByKey.has(key))
        .map(([, item]) => nameFn(item));

    return { added, removed };
}

function xmlEscape(value) {
    return String(value ?? '').replace(/[<>&'"]/g, ch => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;'
    }[ch]));
}

const CHANGELOG_REGISTER_LABELS = {
    emt: 'EMT issuers',
    casps: 'CASPs',
    nonCompliant: 'Non-compliant entities'
};

function describeChanges(changes) {
    const lines = [];
    for (const [register, change] of Object.entries(changes)) {
        const label = CHANGELOG_REGISTER_LABELS[register] || register;
        if (change.added.length) {
            lines.push(`${label} added: ${change.added.join(', ')}`);
        }
        if (change.removed.length) {
            lines.push(`${label} removed: ${change.removed.join(', ')}`);
        }
    }
    return lines;
}

function writeFeed(changelog) {
    const items = changelog.slice(0, FEED_MAX_ITEMS).map(entry => {
        const description = describeChanges(entry.changes || {}).join('\n');
        return [
            '    <item>',
            `      <title>MiCAR register update - ${xmlEscape(entry.date)}</title>`,
            `      <link>${SITE_URL}/</link>`,
            `      <guid isPermaLink="false">${xmlEscape(entry.timestamp || entry.date)}</guid>`,
            `      <pubDate>${new Date(entry.timestamp || entry.date).toUTCString()}</pubDate>`,
            `      <description>${xmlEscape(description)}</description>`,
            '    </item>'
        ].join('\n');
    });

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        '  <channel>',
        '    <title>DEA MiCAR Tracker - register updates</title>',
        `    <link>${SITE_URL}/</link>`,
        '    <description>Additions and removals in the EMT, CASP, and non-compliant registers tracked by the DEA MiCAR Tracker.</description>',
        `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
        ...items,
        '  </channel>',
        '</rss>',
        ''
    ].join('\n');

    fs.writeFileSync(FEED_FILE, xml);
}

function writeSitemap(lastmodDate) {
    // lastmodDate: a YYYY-MM-DD string; fall back to today if unavailable
    const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(lastmodDate || '')
        ? lastmodDate
        : new Date().toISOString().slice(0, 10);

    const urls = SITEMAP_PAGES.map(page => [
        '  <url>',
        `    <loc>${SITE_URL}${page.loc}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${page.changefreq}</changefreq>`,
        `    <priority>${page.priority}</priority>`,
        '  </url>'
    ].join('\n'));

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls,
        '</urlset>',
        ''
    ].join('\n');

    fs.writeFileSync(SITEMAP_FILE, xml);
    console.log(`🗺️  Sitemap written with ${SITEMAP_PAGES.length} pages (lastmod ${lastmod})`);
}

function updateChangelog(previousDatasets, newDatasets) {
    const changes = {};

    const diffs = {
        emt: diffRegister(
            previousDatasets.emts, newDatasets.emts,
            item => (item.issuer || '').toLowerCase(),
            item => item.issuer
        ),
        casps: diffRegister(
            previousDatasets.casps, newDatasets.casps,
            item => `${item.name || ''}::${item.memberState || ''}`.toLowerCase(),
            item => `${item.name} (${item.memberState || 'unknown'})`
        ),
        nonCompliant: diffRegister(
            previousDatasets.nonCompliant, newDatasets.nonCompliant,
            item => `${item.entity || ''}::${item.country || ''}`.toLowerCase(),
            item => `${item.entity} (${item.country || 'unknown'})`
        )
    };

    for (const [register, diff] of Object.entries(diffs)) {
        if (diff && (diff.added.length || diff.removed.length)) {
            changes[register] = diff;
        }
    }

    const changelog = readJsonFile(CHANGELOG_FILE, []);
    const entries = Array.isArray(changelog) ? changelog : [];

    if (Object.keys(changes).length > 0) {
        const now = new Date();
        entries.unshift({
            date: now.toISOString().slice(0, 10),
            timestamp: now.toISOString(),
            changes
        });
        describeChanges(changes).forEach(line => console.log(`📝 ${line}`));
    } else {
        console.log('📝 No register additions or removals detected.');
    }

    const capped = entries.slice(0, CHANGELOG_MAX_ENTRIES);
    writeJsonFile(CHANGELOG_FILE, capped);
    writeFeed(capped);
}

// The page loads register data from data/*.json at runtime; index.html only
// carries the human-readable "Data as of" footer dates, patched here.
function updateFooterDates(emtLastUpdated, caspsLastUpdated) {
    const htmlFile = 'index.html';

    if (!fs.existsSync(htmlFile)) {
        console.error('❌ HTML file not found:', htmlFile);
        process.exit(1);
    }

    const htmlContent = fs.readFileSync(htmlFile, 'utf8');
    const { longDate: emtLongDate } = formatDate(emtLastUpdated);
    const { longDate: caspsLongDate } = formatDate(caspsLastUpdated);

    const dashClass = '[\\uFFFD–-]';
    const replacements = [
        {
            label: 'EMT footer date',
            pattern: new RegExp(`Source:\\s*<a[^>]*>ESMA EMT Register<\\/a>\\s*${dashClass}\\s*Data as of [^<]+`),
            value: `Source: <a href="https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica#InterimMiCARegister" target="_blank" rel="noopener" class="text-blue-300 underline hover:text-blue-200">ESMA EMT Register</a> - Data as of ${emtLongDate}`
        },
        {
            label: 'CASPs footer date',
            pattern: new RegExp(`Source:\\s*<a[^>]*>ESMA CASPs Register<\\/a>\\s*${dashClass}\\s*Data as of [^<]+`),
            value: `Source: <a href="https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica#InterimMiCARegister" target="_blank" rel="noopener" class="text-blue-300 underline hover:text-blue-200">ESMA CASPs Register</a> - Data as of ${caspsLongDate}`
        }
    ];

    let updatedHtml = htmlContent;
    for (const { label, pattern, value } of replacements) {
        if (!pattern.test(updatedHtml)) {
            console.error(`❌ Could not find the ${label} marker in index.html - aborting so the page is not left inconsistent.`);
            process.exit(1);
        }
        updatedHtml = updatedHtml.replace(pattern, value);
    }

    if (updatedHtml !== htmlContent) {
        fs.writeFileSync(htmlFile, updatedHtml);
    }
    console.log(`📅 Footer dates set to EMT: ${emtLongDate}, CASPs: ${caspsLongDate}`);
}

function logSummary(newData, nonCompliantEntries, caspsEntries) {
    const totalTokens = newData.reduce((sum, item) => sum + item.count, 0);
    const currencyFields = getCurrencyFieldsFromItems(newData);
    const currencyTotals = calculateCurrencyTotals(newData, currencyFields);

    console.log('📈 Summary Statistics:');
    console.log(`   Total Issuers: ${newData.length}`);
    console.log(`   Total Tokens: ${totalTokens}`);
    Object.entries(currencyTotals).forEach(([currency, total]) => {
        console.log(`   ${currency.toUpperCase()} Tokens: ${total}`);
    });
    if (Array.isArray(caspsEntries)) {
        console.log(`   CASPs: ${caspsEntries.length}`);
    }
    if (Array.isArray(nonCompliantEntries)) {
        console.log(`   Non-compliant entities: ${nonCompliantEntries.length}`);
    }
}

// Main execution
async function main() {
    console.log('🔄 Starting data refresh sequence...');
    ensureDataDirectory();

    if (!GOOGLE_API_KEY) {
        console.log('ℹ️ GOOGLE_API_KEY not set. Defaulting to CSV export fallback.');
    }

    console.log('🌐 Data URL:', csvUrl);
    console.log('🌐 Date URL:', dateUrl);
    console.log('🌐 Non-compliant URL:', nonCompliantUrl);
    console.log('🌐 CASPs URL:', caspsUrl);

    try {
        const snapshotResult = await fetchSnapshotDates();
        const dateMap = snapshotResult.dateMap || {};
        const emtSheetDate = dateMap['snapshot_date'] || dateMap['emt_snapshot_date'] || '';
        const caspsSheetDate = dateMap['casps_snapshot_date'] || '';
        const currentSnapshot = {
            emtSnapshotDate: emtSheetDate,
            caspsSnapshotDate: caspsSheetDate
        };

        console.log(`📅 EMT sheet date: ${emtSheetDate || 'n/a'} (source: ${snapshotResult.source})`);
        console.log(`📅 CASPs sheet date: ${caspsSheetDate || 'n/a'} (source: ${snapshotResult.source})`);

        const previousSnapshot = getStoredSnapshot();
        const snapshotChanged = hasSnapshotChanged(previousSnapshot, currentSnapshot);
        console.log(snapshotChanged ? '🔁 Snapshot changed, refreshing datasets.' : '💾 Snapshot unchanged, trying cached JSON files.');

        let jsData = null;
        let nonCompliantEntries = null;
        let caspsEntries = null;
        let dataSource = 'cache';

        if (!snapshotChanged) {
            jsData = readJsonFile(EMT_DATA_FILE, null);
            nonCompliantEntries = readJsonFile(NON_COMPLIANT_DATA_FILE, null);
            caspsEntries = readJsonFile(CASPS_DATA_FILE, null);

            if (!Array.isArray(jsData) || !Array.isArray(nonCompliantEntries) || !Array.isArray(caspsEntries)) {
                console.warn('⚠️ Cached data missing or invalid; falling back to live fetch.');
                jsData = null;
                nonCompliantEntries = null;
                caspsEntries = null;
            } else {
                console.log('💾 Loaded cached datasets from data/ directory.');
            }
        }

        if (!jsData || !nonCompliantEntries || !caspsEntries) {
            const previousDatasets = {
                emts: readJsonFile(EMT_DATA_FILE, null),
                casps: readJsonFile(CASPS_DATA_FILE, null),
                nonCompliant: readJsonFile(NON_COMPLIANT_DATA_FILE, null)
            };

            const [emtResult, nonCompliantResult, caspsResult] = await Promise.all([
                fetchEmtEntries(),
                fetchNonCompliantEntries(),
                fetchCaspsEntries()
            ]);

            jsData = emtResult.entries;
            nonCompliantEntries = nonCompliantResult.entries;
            caspsEntries = caspsResult.entries;
            dataSource = 'remote';

            warnOnShrunkenDataset('EMT register', EMT_DATA_FILE, jsData);
            warnOnShrunkenDataset('Non-compliant register', NON_COMPLIANT_DATA_FILE, nonCompliantEntries);
            warnOnShrunkenDataset('CASPs register', CASPS_DATA_FILE, caspsEntries);

            updateChangelog(previousDatasets, {
                emts: jsData,
                casps: caspsEntries,
                nonCompliant: nonCompliantEntries
            });

            writeJsonFile(EMT_DATA_FILE, jsData);
            writeJsonFile(NON_COMPLIANT_DATA_FILE, nonCompliantEntries);
            writeJsonFile(CASPS_DATA_FILE, caspsEntries);
            writeJsonFile(SNAPSHOT_FILE, {
                ...currentSnapshot,
                lastUpdated: new Date().toISOString()
            });
        }

        if (!Array.isArray(jsData) || jsData.length === 0) {
            console.error('❌ No EMT data available to update dashboard.');
            process.exit(1);
        }

        updateFooterDates(emtSheetDate, caspsSheetDate);
        writeSitemap((emtSheetDate || caspsSheetDate || '').slice(0, 10));
        logSummary(jsData, nonCompliantEntries || [], caspsEntries || []);
        console.log(`📦 Data source used: ${dataSource === 'cache' ? 'cached JSON files' : 'Sheets / CSV fetch'}`);
    } catch (error) {
        console.error('❌ Error updating data:', error);
        process.exit(1);
    }
}

function ensureCsvResponseValid(csvText, label) {
    if (!csvText || /<html|<HTML|Temporary Redirect/i.test(csvText)) {
        console.error(`❌ ${label} returned unexpected HTML or empty content.`);
        console.error('📋 Raw response preview:', (csvText || '').substring(0, 500));
        process.exit(1);
    }
}

main();
