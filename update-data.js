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

const SHEET_CONFIG = {
    snapshot: { label: 'Snapshot dates', range: 'snapshot!A1:B3' },
    emt: { label: 'EMTs register', range: 'Jurisdiction!A1:K50', requireNumericId: true },
    casps: { label: 'CASPs register', range: 'CASPs!A1:F150' },
    nonCompliant: { label: 'Non-compliant register', range: 'Non Compliant!A1:E150' }
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function csvToArray(str, delimiter = ',') {
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

    return result.filter(row => row['#'] && row['#'] !== '' && row['#'] !== 'nan' && !isNaN(parseInt(row['#'])));
}

function csvToArrayGeneric(str) {
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

    return result;
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

    if (requireNumericId) {
        return rows.filter(row => row['#'] && row['#'] !== '' && row['#'] !== 'nan' && !isNaN(parseInt(row['#'])));
    }

    return rows;
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
    const rows = csvToArray(csvText);
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
    const rows = csvToArrayGeneric(csvText);
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
    const rows = csvToArrayGeneric(csvText);
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

function convertToJsData(csvData) {
    const data = [];

    console.log('📋 CSV Headers:', Object.keys(csvData[0] || {}));
    console.log('📊 Processing', csvData.length, 'rows');

    csvData.forEach((row, index) => {
        console.log(`Row ${index + 1}:`, {
            id: row['#'],
            issuer: row['Issuer (HQ)'],
            tokens: row['Tokens'],
            euro: row['Euro'],
            usd: row['USD']
        });

        if (row['#'] && row['Issuer (HQ)'] && row['Issuer (HQ)'] !== 'nan') {
            const item = {
                id: parseInt(row['#']) || index + 1,
                issuer: row['Issuer (HQ)'] || '',
                state: row['Home State'] || '',
                authority: row['Competent Authority'] || '',
                tokens: row['Authorised EMT(s)'] || '',
                count: parseNumber(row['Tokens']),
                euro: parseNumber(row['Euro']),
                usd: parseNumber(row['USD']),
                czk: parseNumber(row['CZK']),
                gbp: parseNumber(row['GBP']),
                chf: parseNumber(row['CHF'])
            };
            data.push(item);
            console.log('✅ Added:', item.issuer, 'with', item.count, 'tokens');
        }
    });

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

        console.log('🚨 Non-compliant entity added:', {
            entity,
            country: memberState,
            authority,
            websites,
            isNew
        });
    });

    return entries;
}

function updateHtmlFile(newData, emtLastUpdated, nonCompliantEntries, caspsEntries, caspsLastUpdated) {
    const htmlFile = 'index.html';

    if (!fs.existsSync(htmlFile)) {
        console.error('❌ HTML file not found:', htmlFile);
        return;
    }

    let htmlContent = fs.readFileSync(htmlFile, 'utf8');

    // Find the data array in the JavaScript section - try multiple patterns
    let dataStart = htmlContent.indexOf('const data = [');
    let dataEnd = htmlContent.indexOf('];', dataStart) + 2;
    let dataPattern = 'const data = ';

    if (dataStart === -1) {
        dataStart = htmlContent.indexOf('data = [');
        dataEnd = htmlContent.indexOf('];', dataStart) + 2;
        dataPattern = 'data = ';
    }

    if (dataStart === -1) {
        dataStart = htmlContent.indexOf('let data = [');
        dataEnd = htmlContent.indexOf('];', dataStart) + 2;
        dataPattern = 'let data = ';
    }

    if (dataStart === -1 || dataEnd === -1) {
        console.error('❌ Could not find data array in HTML file');
        console.log('🔍 Searching for data patterns...');

        // Show what patterns exist
        const patterns = ['const data', 'let data', 'var data', 'data ='];
        patterns.forEach(pattern => {
            const index = htmlContent.indexOf(pattern);
            if (index !== -1) {
                console.log(`Found "${pattern}" at position ${index}`);
                console.log('Context:', htmlContent.substring(index, index + 100));
            }
        });
        return;
    }

    // Replace the data array
    const newDataString = `${dataPattern}${JSON.stringify(newData, null, 4)};`;
    const updatedHtml = htmlContent.substring(0, dataStart) + newDataString + htmlContent.substring(dataEnd);

    const nonCompliantStart = updatedHtml.indexOf('const nonCompliantData = [');
    let finalHtml = updatedHtml;

    if (nonCompliantStart !== -1) {
        const nonCompliantEnd = updatedHtml.indexOf('];', nonCompliantStart) + 2;
        const nonCompliantString = `const nonCompliantData = ${JSON.stringify(nonCompliantEntries || [], null, 4)};`;
        finalHtml = updatedHtml.substring(0, nonCompliantStart) + nonCompliantString + updatedHtml.substring(nonCompliantEnd);
    } else {
        console.error('❌ Could not find nonCompliantData array in HTML file');
    }

    const caspsStart = finalHtml.indexOf('const caspsData = [');
    if (caspsStart !== -1) {
        const caspsEnd = finalHtml.indexOf('];', caspsStart) + 2;
        const caspsString = `const caspsData = ${JSON.stringify(caspsEntries || [], null, 4)};`;
        finalHtml = finalHtml.substring(0, caspsStart) + caspsString + finalHtml.substring(caspsEnd);
    } else {
        console.error('❌ Could not find caspsData array in HTML file');
    }

    const { longDate: emtLongDate } = formatDate(emtLastUpdated);
    const { longDate: caspsLongDate } = formatDate(caspsLastUpdated);
    
    const dashClass = '[\\uFFFD–-]'; // optional helper; inline if you prefer
    const updatedHtmlWithDate = finalHtml
    .replace(new RegExp(`Source:\\s*<a[^>]*>ESMA EMT Register<\\/a>\\s*${dashClass}\\s*Data as of [^<]+`),
        `Source: <a href="https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica#InterimMiCARegister" target="_blank" rel="noopener" class="text-blue-300 underline hover:text-blue-200">ESMA EMT Register</a> - Data as of ${emtLongDate}`)
    .replace(new RegExp(`Source:\\s*<a[^>]*>ESMA CASPs Register<\\/a>\\s*${dashClass}\\s*Data as of [^<]+`),
        `Source: <a href="https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica#InterimMiCARegister" target="_blank" rel="noopener" class="text-blue-300 underline hover:text-blue-200">ESMA CASPs Register</a> - Data as of ${caspsLongDate}`);

    fs.writeFileSync(htmlFile, updatedHtmlWithDate);
    console.log('✅ Dashboard updated successfully!');
    console.log(`📊 Updated with ${newData.length} issuers`);

    // Log summary statistics
    const totalTokens = newData.reduce((sum, item) => sum + item.count, 0);
    const euroTokens = newData.reduce((sum, item) => sum + item.euro, 0);
    const usdTokens = newData.reduce((sum, item) => sum + item.usd, 0);
    const gbpTokens = newData.reduce((sum, item) => sum + item.gbp, 0);
    const czkTokens = newData.reduce((sum, item) => sum + item.czk, 0);
    const chfTokens = newData.reduce((sum, item) => sum + item.chf, 0);

    console.log('📈 Summary Statistics:');
    console.log(`   Total Issuers: ${newData.length}`);
    console.log(`   Total Tokens: ${totalTokens}`);
    console.log(`   EUR Tokens: ${euroTokens}`);
    console.log(`   USD Tokens: ${usdTokens}`);
    console.log(`   GBP Tokens: ${gbpTokens}`);
    console.log(`   CZK Tokens: ${czkTokens}`);
    console.log(`   CHF Tokens: ${chfTokens}`);
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
            const [emtResult, nonCompliantResult, caspsResult] = await Promise.all([
                fetchEmtEntries(),
                fetchNonCompliantEntries(),
                fetchCaspsEntries()
            ]);

            jsData = emtResult.entries;
            nonCompliantEntries = nonCompliantResult.entries;
            caspsEntries = caspsResult.entries;
            dataSource = 'remote';

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

        updateHtmlFile(jsData, emtSheetDate, nonCompliantEntries || [], caspsEntries || [], caspsSheetDate);
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
