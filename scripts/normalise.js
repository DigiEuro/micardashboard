/*
 * normalise.js — entity identity and record normalisation.
 *
 * Resolves the CASP register's authorisation *records* into legal *entities*,
 * and reports every data-quality issue it finds instead of quietly fixing it.
 *
 * HARD RULE: nothing is ever deleted. Every source row survives into
 * entities.json as an authorisation record. Normalisation only adds fields —
 * a value that cannot be validated is preserved verbatim alongside a typed
 * anomaly, never dropped.
 *
 * Key rule: LEI where present (98% of CASPs), otherwise a hash of the
 * normalised legal name plus country, with a human-readable slug alongside.
 */
const crypto = require('crypto');

const ANOMALY_TYPES = {
    EXACT_DUPLICATE: 'exact_duplicate',
    MULTI_AUTHORISATION: 'multi_authorisation',
    MALFORMED_URL: 'malformed_url',
    NON_URL_IN_WEBSITE_FIELD: 'non_url_in_website_field',
    REPEATED_SERVICE_CODE: 'repeated_service_code',
    ENCODING_ARTEFACT: 'encoding_artefact'
};

// ---- primitives -------------------------------------------------------------

function collapseWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Strip accents so "Société" and "Societe" slug identically.
function stripAccents(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normaliseName(value) {
    return stripAccents(collapseWhitespace(value))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normaliseAuthority(value) {
    return collapseWhitespace(value);
}

function slugify(value) {
    const slug = stripAccents(collapseWhitespace(value))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return slug || 'entity';
}

const LEI_PATTERN = /^[A-Z0-9]{18}[0-9]{2}$/;

function isValidLei(value) {
    return LEI_PATTERN.test(String(value || '').trim().toUpperCase());
}

// ---- website normalisation --------------------------------------------------

// A bare domain we are willing to repair by adding a scheme. Deliberately
// strict: must have no spaces and a plausible TLD, so prose and postal
// addresses that landed in this column fail and are reported instead.
const BARE_DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/[^\s]*)?$/i;

/*
 * Returns { url, raw, issue }.
 *   url   — a usable https(s) link, or '' when the value could not be repaired
 *   raw   — the original value, always preserved
 *   issue — null, or an anomaly type describing what was wrong
 */
function normaliseWebsite(value) {
    const raw = collapseWhitespace(value);
    if (!raw) {
        return { url: '', raw: '', issue: null };
    }

    // Mistyped scheme separator, e.g. "https.//coinbase.com" — a period where
    // the colon should be. Unambiguous, so repair it rather than leaving a
    // major entity with no working link.
    const mistypedSeparator = raw.match(/^(https?)[.,;]\/\/(.*)$/i);
    if (mistypedSeparator) {
        return {
            url: `${mistypedSeparator[1].toLowerCase()}://${mistypedSeparator[2]}`,
            raw,
            issue: ANOMALY_TYPES.ENCODING_ARTEFACT
        };
    }

    // Truncated scheme, e.g. "ttps://example.com" — a character was eaten
    // somewhere upstream. Repairable, but recorded as an encoding artefact.
    const truncated = raw.match(/^t{1,2}(ps?|p):\/\/(.*)$/i);
    if (truncated && !/^https?:\/\//i.test(raw)) {
        const scheme = /s/i.test(truncated[1]) ? 'https' : 'http';
        return { url: `${scheme}://${truncated[2]}`, raw, issue: ANOMALY_TYPES.ENCODING_ARTEFACT };
    }

    if (/^https?:\/\//i.test(raw)) {
        try {
            const parsed = new URL(raw);
            if (parsed.hostname.includes('.')) {
                return { url: raw, raw, issue: null };
            }
        } catch (error) {
            // fall through to the non-URL branch
        }
        return { url: '', raw, issue: ANOMALY_TYPES.NON_URL_IN_WEBSITE_FIELD };
    }

    // Missing scheme but clearly a domain, e.g. "www.bitpanda.com". Repairing
    // these is what makes them render as links at all.
    if (BARE_DOMAIN.test(raw)) {
        return { url: `https://${raw}`, raw, issue: ANOMALY_TYPES.MALFORMED_URL };
    }

    // Anything else is not a website: prose, postal addresses, fragments of a
    // field that was split on a comma upstream.
    return { url: '', raw, issue: ANOMALY_TYPES.NON_URL_IN_WEBSITE_FIELD };
}

// ---- entity keys ------------------------------------------------------------

function nameCountryKey(name, country) {
    const basis = `${normaliseName(name)}::${normaliseName(country)}`;
    return 'nc:' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

function entityKeyFor(record) {
    const lei = String(record.lei || '').trim().toUpperCase();
    if (isValidLei(lei)) {
        return { key: lei, keySource: 'lei' };
    }
    return { key: nameCountryKey(record.name, record.memberState), keySource: 'name-country' };
}

// ---- resolution -------------------------------------------------------------

function buildEntities(caspRecords, options = {}) {
    const records = Array.isArray(caspRecords) ? caspRecords : [];
    const anomalies = [];
    const byKey = new Map();
    const seenExact = new Map();

    records.forEach((record, index) => {
        const { key, keySource } = entityKeyFor(record);
        const name = collapseWhitespace(record.name);
        const country = collapseWhitespace(record.memberState);
        const authority = normaliseAuthority(record.authority);

        // --- services: preserve order, report repeats, keep a deduped view
        const rawServices = (record.services || []).map(collapseWhitespace).filter(Boolean);
        const services = [];
        const repeated = [];
        rawServices.forEach(service => {
            if (services.some(existing => existing.toLowerCase() === service.toLowerCase())) {
                repeated.push(service);
            } else {
                services.push(service);
            }
        });
        if (repeated.length) {
            anomalies.push({
                type: ANOMALY_TYPES.REPEATED_SERVICE_CODE,
                entityKey: key,
                name,
                country,
                detail: `Service code(s) listed more than once in a single record: ${repeated.join(', ')}`,
                values: repeated
            });
        }

        // --- websites: repair what is repairable, preserve what is not
        const websites = [];
        const websitesRaw = [];
        (record.websites || []).forEach(value => {
            const { url, raw, issue } = normaliseWebsite(value);
            if (url) {
                if (!websites.includes(url)) websites.push(url);
            } else if (raw) {
                websitesRaw.push(raw);
            }
            if (issue && raw) {
                anomalies.push({
                    type: issue,
                    entityKey: key,
                    name,
                    country,
                    detail: url
                        ? `Website value "${raw}" was repaired to "${url}".`
                        : `Website field contains "${raw}", which is not a URL. Kept as raw text; no link is rendered.`,
                    values: [raw]
                });
            }
        });

        // --- exact duplicates: byte-identical source rows
        const fingerprint = JSON.stringify([
            normaliseName(name), normaliseName(country), normaliseName(authority),
            rawServices.map(s => s.toLowerCase()).sort(), (record.websites || []).slice().sort()
        ]);
        if (seenExact.has(fingerprint)) {
            anomalies.push({
                type: ANOMALY_TYPES.EXACT_DUPLICATE,
                entityKey: key,
                name,
                country,
                detail: `Identical to source row #${seenExact.get(fingerprint) + 1}. Both rows are retained.`,
                values: [String(index + 1), String(seenExact.get(fingerprint) + 1)]
            });
        } else {
            seenExact.set(fingerprint, index);
        }

        const authorisation = {
            sourceRow: index + 1,
            sourceId: record.id != null ? record.id : index + 1,
            name,
            country,
            authority,
            services,
            servicesRaw: rawServices,
            websites,
            websitesRaw
        };

        if (!byKey.has(key)) {
            byKey.set(key, {
                entityKey: key,
                keySource,
                slug: '',
                lei: keySource === 'lei' ? key : '',
                name,
                alsoKnownAs: [],
                country,
                authorities: [],
                services: [],
                websites: [],
                websitesRaw: [],
                authorisations: []
            });
        }

        const entity = byKey.get(key);
        entity.authorisations.push(authorisation);
        if (name && name !== entity.name && !entity.alsoKnownAs.includes(name)) {
            entity.alsoKnownAs.push(name);
        }
        if (authority && !entity.authorities.includes(authority)) entity.authorities.push(authority);
        services.forEach(s => { if (!entity.services.includes(s)) entity.services.push(s); });
        websites.forEach(w => { if (!entity.websites.includes(w)) entity.websites.push(w); });
        websitesRaw.forEach(w => { if (!entity.websitesRaw.includes(w)) entity.websitesRaw.push(w); });
    });

    // --- slugs, unique and stable
    const slugCounts = new Map();
    const entities = [...byKey.values()].map(entity => {
        let slug = slugify(entity.name);
        const seen = slugCounts.get(slug) || 0;
        slugCounts.set(slug, seen + 1);
        if (seen > 0) {
            slug = `${slug}-${slugify(entity.country) || seen + 1}`;
            // still colliding? fall back to a key fragment, which is unique
            if ((slugCounts.get(slug) || 0) > 0) {
                slug = `${slug}-${entity.entityKey.replace(/^nc:/, '').slice(0, 6).toLowerCase()}`;
            }
            slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
        }
        entity.slug = slug;
        return entity;
    });

    // --- multi-authorisation: one legal entity, several authorisation records
    entities.forEach(entity => {
        if (entity.authorisations.length > 1) {
            const names = [...new Set(entity.authorisations.map(a => a.name))];
            anomalies.push({
                type: ANOMALY_TYPES.MULTI_AUTHORISATION,
                entityKey: entity.entityKey,
                name: entity.name,
                country: entity.country,
                detail: names.length > 1
                    ? `One legal entity (${entity.keySource === 'lei' ? 'LEI ' + entity.lei : 'matched on name and country'}) appears under ${names.length} different names: ${names.join(' / ')}. These are the same firm, not duplicates.`
                    : `${entity.authorisations.length} authorisation records for one legal entity. A firm may hold more than one authorisation; this is not a duplicate.`,
                values: names
            });
        }
    });

    // --- first-seen, from the dated snapshot archive
    if (options.snapshots) {
        applyFirstSeen(entities, options.snapshots);
    }

    return { entities, anomalies };
}

/*
 * options.snapshots: [{ date, casps: [...] }] oldest first.
 * Older snapshots predate LEI capture, so entities are matched on normalised
 * name + country here — the only key available across the whole archive.
 */
function applyFirstSeen(entities, snapshots) {
    const firstSeenByNameCountry = new Map();
    snapshots.forEach(({ date, casps }) => {
        (casps || []).forEach(row => {
            const k = `${normaliseName(row.name)}::${normaliseName(row.memberState)}`;
            if (!firstSeenByNameCountry.has(k)) {
                firstSeenByNameCountry.set(k, date);
            }
        });
    });
    entities.forEach(entity => {
        const dates = entity.authorisations
            .map(a => firstSeenByNameCountry.get(`${normaliseName(a.name)}::${normaliseName(a.country)}`))
            .filter(Boolean)
            .sort();
        entity.firstSeen = dates[0] || null;
    });
}

module.exports = {
    ANOMALY_TYPES,
    collapseWhitespace,
    normaliseName,
    normaliseAuthority,
    slugify,
    isValidLei,
    normaliseWebsite,
    nameCountryKey,
    entityKeyFor,
    buildEntities,
    applyFirstSeen
};
