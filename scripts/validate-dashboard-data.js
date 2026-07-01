const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.html');
const standardFields = new Set(['id', 'issuer', 'state', 'authority', 'tokens', 'count']);

function fail(message, details = []) {
  console.error(`❌ ${message}`);
  details.forEach(detail => console.error(`   - ${detail}`));
  process.exitCode = 1;
}

function extractDashboardData(html) {
  const start = html.indexOf('const data = [');
  const end = html.indexOf('const caspsData = [', start);

  if (start === -1 || end === -1) {
    throw new Error('Could not locate the EMT data block in index.html.');
  }

  const block = html.slice(start, end);
  const match = block.match(/const data = (\[[\s\S]*?\]);\s*$/);

  if (!match) {
    throw new Error('Could not parse the EMT data array from index.html.');
  }

  return JSON.parse(match[1]);
}

function extractCurrencyInfoCodes(html) {
  const currencyInfoMatch = html.match(/const currencyInfo = \{([\s\S]*?)\n    \};/);

  if (!currencyInfoMatch) {
    return new Set();
  }

  const codes = new Set();
  const codePattern = /'([A-Z]{3})'\s*:/g;
  let match;

  while ((match = codePattern.exec(currencyInfoMatch[1])) !== null) {
    codes.add(match[1]);
  }

  return codes;
}

function getCurrencyFields(items) {
  const fields = new Set();

  items.forEach(item => {
    Object.keys(item || {}).forEach(key => {
      if (!standardFields.has(key)) {
        fields.add(key);
      }
    });
  });

  return Array.from(fields).sort();
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function validateItems(items, knownCurrencyCodes) {
  const errors = [];
  const currencyFields = getCurrencyFields(items);
  const totals = Object.fromEntries(currencyFields.map(currency => [currency, 0]));
  const metadataWarnings = [];
  let totalTokens = 0;

  items.forEach(item => {
    const count = toNumber(item.count);
    const currencyTotal = currencyFields.reduce((sum, currency) => {
      const value = toNumber(item[currency]);
      totals[currency] += value;
      return sum + value;
    }, 0);

    totalTokens += count;

    if (count !== currencyTotal) {
      errors.push(`${item.issuer || `row ${item.id}`}: count is ${count}, but currency total is ${currencyTotal}`);
    }
  });

  currencyFields.forEach(currency => {
    const currencyCode = currency.toUpperCase();
    if (!knownCurrencyCodes.has(currencyCode) && totals[currency] > 0) {
      metadataWarnings.push(`${currencyCode} has token data but no currencyInfo metadata in index.html`);
    }
  });

  return { currencyFields, errors, metadataWarnings, totalTokens, totals };
}

try {
  const html = fs.readFileSync(indexPath, 'utf8');
  const items = extractDashboardData(html);
  const knownCurrencyCodes = extractCurrencyInfoCodes(html);

  if (!Array.isArray(items) || items.length === 0) {
    fail('No EMT data entries found in index.html.');
  } else {
    const { currencyFields, errors, metadataWarnings, totalTokens, totals } = validateItems(items, knownCurrencyCodes);

    if (currencyFields.length === 0) {
      fail('No currency fields found in EMT dashboard data.');
    }

    if (errors.length > 0) {
      fail('EMT token counts do not match per-currency totals.', errors);
    }

    metadataWarnings.forEach(warning => console.warn(`⚠️ ${warning}`));

    if (process.exitCode !== 1) {
      const visibleTotals = Object.entries(totals)
        .filter(([, value]) => value > 0)
        .map(([currency, value]) => `${currency.toUpperCase()}=${value}`)
        .join(', ');

      console.log(`✅ Validated ${items.length} EMT rows.`);
      console.log(`✅ Total tokens: ${totalTokens}`);
      console.log(`✅ Currency totals: ${visibleTotals}`);
    }
  }
} catch (error) {
  fail(error.message);
}
