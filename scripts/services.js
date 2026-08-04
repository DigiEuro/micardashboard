/*
 * MiCAR service vocabulary.
 *
 * The register's service column is source text, not an application enum. Keep
 * the source-to-code mapping here so it is versioned, reviewable, and tested;
 * the bot should only copy the ESMA wording into ac_serviceCode_raw.
 */

const SERVICE_DEFINITIONS = Object.freeze([
    {
        code: 'custody',
        label: 'Custody',
        shortLabel: 'Custody',
        patterns: [
            /(?:providing\s+)?custody\s+and\s+administration\s+of\s+crypto[- ]assets\s+on\s+behalf\s+of\s+clients?/i
        ]
    },
    {
        code: 'trading platform',
        label: 'Operation of a trading platform',
        shortLabel: 'Trading platform',
        patterns: [
            /operation\s+of\s+a\s+trading\s+platform\s+for\s+crypto[- ]assets?/i
        ]
    },
    {
        code: 'exchange funds',
        label: 'Exchange for funds',
        shortLabel: 'Funds exchange',
        patterns: [
            /exchange\s+(?:of\s+)?crypto[- ]assets?\s+for\s+funds/i,
            /exchange\s+between\s+crypto\s+assets?\s+and\s+fiat\s+currency/i
        ]
    },
    {
        code: 'exchange crypto',
        label: 'Exchange for crypto-assets',
        shortLabel: 'Crypto exchange',
        patterns: [
            /exchange\s+(?:of\s+)?crypto[- ]assets?\s+for\s+(?:other\s+)?crypto[- ]assets?/i,
            /exchange\s+(?:of\s+)?crypto[- ]assets?\s+for\s+other\b/i,
            /exchange\s+for\s+crypto[- ]assets?/i,
            /exchange\s+between\s+crypto\s+assets?(?!\s+and\s+fiat)/i
        ]
    },
    {
        code: 'execution',
        label: 'Execution',
        shortLabel: 'Execution',
        patterns: [
            /execution\s+of\s+orders(?:\s+for\s+crypto[- ]assets?)?/i
        ]
    },
    {
        code: 'placing',
        label: 'Placing',
        shortLabel: 'Placing',
        patterns: [
            /placing\s+of\s+crypto[- ]assets?/i
        ]
    },
    {
        code: 'RTO',
        label: 'Reception and transmission of orders',
        shortLabel: 'RTO',
        patterns: [
            /reception\s+and\s+transmission\s+of\s+(?:client\s+)?orders?/i
        ]
    },
    {
        code: 'advice',
        label: 'Advice',
        shortLabel: 'Advice',
        patterns: [
            /providing\s+advice\s+on\s+crypto[- ]assets?/i
        ]
    },
    {
        code: 'portfolio mgmt',
        label: 'Portfolio management',
        shortLabel: 'Portfolio mgmt',
        patterns: [
            /providing\s+portfolio\s+management\s+on\s+crypto[- ]assets?/i
        ]
    },
    {
        code: 'transfer',
        label: 'Transfer services',
        shortLabel: 'Transfers',
        patterns: [
            /providing\s+transfer\s+services(?:\s+for\s+crypto[- ]assets?)?/i
        ]
    }
]);

const SERVICE_CODES = Object.freeze(SERVICE_DEFINITIONS.map(service => service.code));
const SERVICE_LABELS = Object.freeze(Object.fromEntries(
    SERVICE_DEFINITIONS.map(service => [service.code, service.label])
));
const SERVICE_SHORT_LABELS = Object.freeze(Object.fromEntries(
    SERVICE_DEFINITIONS.map(service => [service.code, service.shortLabel])
));

function normaliseServiceText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u00a0]/g, ' ')
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Derive the stable application service codes from ESMA's source wording.
 *
 * A value may contain several services, sometimes separated by pipes, slashes,
 * or malformed/missing punctuation. Matching the service wording rather than
 * relying only on the letter prefix handles both the normal export and the
 * variants already present in the register.
 */
function deriveServiceCodes(value) {
    const text = normaliseServiceText(value);
    if (!text) return [];

    const matches = [];
    SERVICE_DEFINITIONS.forEach(service => {
        let firstIndex = -1;
        service.patterns.forEach(pattern => {
            const match = pattern.exec(text);
            if (match && (firstIndex === -1 || match.index < firstIndex)) {
                firstIndex = match.index;
            }
        });
        if (firstIndex !== -1) matches.push({ code: service.code, index: firstIndex });
    });

    matches.sort((a, b) => a.index - b.index);
    return [...new Set(matches.map(match => match.code))];
}

module.exports = {
    SERVICE_CODES,
    SERVICE_DEFINITIONS,
    SERVICE_LABELS,
    SERVICE_SHORT_LABELS,
    normaliseServiceText,
    deriveServiceCodes
};
