#!/usr/bin/env node
/*
 * Generates a crawlable, permanent page for every normalised CASP entity.
 *
 * Source register rows remain in data/casps.json. data/entities.json resolves
 * those authorisation records into legal entities, so aliases that share an
 * LEI can have one public profile without hiding any source row.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_DIR = path.join(ROOT, 'entities');
const { SERVICE_LABELS } = require('./services');
const SITE_URL = 'https://micatracker.digital-euro-association.de';
const ESMA_SOURCE = 'https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica#InterimMiCARegister';
const MEMBERSHIP_URL = 'https://digital-euro-association.de/institutional-membership-form';
const CONTACT_EMAIL = 'info@digital-euro-association.de';

const COUNTRY_FLAGS = {
  Austria: '🇦🇹', Belgium: '🇧🇪', Bulgaria: '🇧🇬', Croatia: '🇭🇷', Cyprus: '🇨🇾',
  Czechia: '🇨🇿', 'Czech Republic': '🇨🇿', Denmark: '🇩🇰', Estonia: '🇪🇪', Finland: '🇫🇮',
  France: '🇫🇷', Germany: '🇩🇪', Greece: '🇬🇷', Hungary: '🇭🇺', Iceland: '🇮🇸',
  Ireland: '🇮🇪', Italy: '🇮🇹', Latvia: '🇱🇻', Liechtenstein: '🇱🇮', Lithuania: '🇱🇹',
  Luxembourg: '🇱🇺', Malta: '🇲🇹', Netherlands: '🇳🇱', Norway: '🇳🇴', Poland: '🇵🇱',
  Portugal: '🇵🇹', Romania: '🇷🇴', Slovakia: '🇸🇰', Slovenia: '🇸🇮', Spain: '🇪🇸',
  Sweden: '🇸🇪'
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function safeHttpUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function formatDate(value) {
  if (!value) return 'Not available';
  const parsed = new Date(String(value).length === 10 ? value + 'T00:00:00Z' : value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
}

function jsonForHtml(value) {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function entityLookup(entities) {
  const bySourceId = new Map();
  const byLei = new Map();
  entities.forEach(function (entity) {
    if (entity.lei) byLei.set(entity.lei, entity.slug);
    (entity.authorisations || []).forEach(function (record) {
      if (record.sourceId != null) bySourceId.set(String(record.sourceId), entity.slug);
    });
  });
  return { bySourceId, byLei };
}

function contextFor(entity, entities) {
  const countryEntities = entities.filter(function (candidate) {
    return candidate.country === entity.country;
  });
  const authority = (entity.authorities || [])[0] || '';
  const rows = [
    {
      label: 'MiCAR-authorised legal entities in ' + entity.country,
      count: countryEntities.length,
      query: { country: entity.country }
    },
    {
      label: 'Supervised by ' + (authority || 'the competent authority'),
      count: countryEntities.filter(function (candidate) {
        return (candidate.authorities || []).indexOf(authority) !== -1;
      }).length,
      query: { country: entity.country, q: authority }
    }
  ];

  ['custody', 'exchange funds', 'exchange crypto', 'execution'].filter(function (service) {
    return (entity.services || []).indexOf(service) !== -1;
  }).forEach(function (service) {
    rows.push({
      label: 'Authorised for ' + (SERVICE_LABELS[service] || service).toLowerCase(),
      count: countryEntities.filter(function (candidate) {
        return (candidate.services || []).indexOf(service) !== -1;
      }).length,
      query: { country: entity.country, service }
    });
  });
  return rows;
}

function queryHref(query) {
  const params = new URLSearchParams();
  Object.keys(query).forEach(function (key) {
    if (query[key]) params.set(key, query[key]);
  });
  return '../casp-tracker.html?' + params.toString();
}

function changeHistory(entity, changelog, snapshot) {
  const events = [];
  const names = [entity.name].concat(entity.alsoKnownAs || []);
  const countrySuffix = ' (' + entity.country + ')';

  if (snapshot.caspsSnapshotDate) {
    events.push({ date: snapshot.caspsSnapshotDate, label: 'Current ESMA snapshot', current: true });
  }

  changelog.forEach(function (entry) {
    const added = entry && entry.changes && entry.changes.casps && entry.changes.casps.added;
    if (!Array.isArray(added)) return;
    names.forEach(function (name) {
      if (added.indexOf(name + countrySuffix) !== -1) {
        events.push({ date: entry.date, label: name + ' first observed' });
      }
    });
  });

  if (entity.firstSeen) {
    events.push({ date: entity.firstSeen, label: entity.name + ' first observed' });
  }

  const seen = new Set();
  return events
    .filter(function (event) {
      const key = event.date + '::' + event.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
    .slice(0, 4);
}

function dataNote(entity, anomalies) {
  const matches = anomalies.filter(function (item) { return item.entityKey === entity.entityKey; });
  if (!matches.length) return '';

  const multi = matches.find(function (item) { return item.type === 'multi_authorisation'; });
  let heading = 'Source data quality note';
  let detail = matches.map(function (item) { return item.detail; }).filter(Boolean).join(' ');
  if (multi) {
    heading = 'Same legal entity, multiple register names';
    const names = [entity.name].concat(entity.alsoKnownAs || []);
    detail = 'ESMA lists LEI ' + entity.lei + ' under ' + names.join(' and ') + '. We combine these as one entity, not duplicates.';
  }

  return `
          <section class="entity-note" aria-labelledby="data-note-title">
            <div class="entity-note-icon" aria-hidden="true"><i class="fas fa-circle-info"></i></div>
            <div>
              <p class="entity-eyebrow">Data note</p>
              <h2 id="data-note-title">${esc(heading)}</h2>
              <p>${esc(detail)}</p>
              <div class="entity-note-meta">Data quality note <span aria-hidden="true">•</span> Based on the public register <span aria-hidden="true">•</span> <a href="../data-quality.html">Methodology</a></div>
            </div>
          </section>`;
}

function serviceBadges(entity) {
  return (entity.services || []).map(function (service) {
    return `<span class="entity-service"><i class="fas fa-circle-check" aria-hidden="true"></i>${esc(SERVICE_LABELS[service] || service)}</span>`;
  }).join('');
}

function authorityText(entity) {
  const authorities = entity.authorities || [];
  return authorities.length ? authorities.join(', ') : 'Not provided';
}

function websites(entity, compact) {
  const valid = (entity.websites || []).map(safeHttpUrl).filter(Boolean);
  if (!valid.length) return '<span class="entity-muted">Not provided in the ESMA source</span>';
  return valid.map(function (url) {
    let label = url;
    try { label = new URL(url).hostname.replace(/^www\./, ''); } catch (error) { /* keep source */ }
    return `<a href="${esc(url)}" target="_blank" rel="noopener" class="entity-link">${esc(label)} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
  }).join(compact ? ' <span aria-hidden="true">·</span> ' : '<br>');
}

function entityLogo(entity, logos) {
  const logo = logos && logos[entity.slug];
  const src = logo && String(logo.src || '').trim();
  if (!src || !/^\.\.\/assets\/casp-logos\/[A-Za-z0-9._-]+\.(?:png|svg)$/i.test(src)) {
    return '<div class="entity-icon" aria-hidden="true"><i class="fas fa-building"></i></div>';
  }
  const alt = String(logo.alt || (entity.name + ' logo')).trim();
  const theme = logo.theme === 'dark' ? ' entity-logo-frame-dark' : '';
  return `<div class="entity-logo-frame${theme}"><img class="entity-logo-image" src="${esc(src)}" alt="${esc(alt)}" width="96" height="72" decoding="async"></div>`;
}

function entityPage(entity, data) {
  const snapshot = data.snapshot;
  const authority = authorityText(entity);
  const flag = COUNTRY_FLAGS[entity.country] || '';
  const sourceDate = formatDate(snapshot.caspsSnapshotDate);
  const checkedDate = formatDate(snapshot.lastUpdated);
  const dateModified = snapshot.lastUpdated && !isNaN(new Date(snapshot.lastUpdated).getTime())
    ? new Date(snapshot.lastUpdated).toISOString()
    : undefined;
  const canonical = SITE_URL + '/entities/' + entity.slug + '.html';
  const note = dataNote(entity, data.anomalies);
  const contextRows = contextFor(entity, data.entities);
  const history = changeHistory(entity, data.changelog, snapshot);
  const website = (entity.websites || []).map(safeHttpUrl).find(Boolean) || '';
  const metaDescription = `${entity.name} is listed as a MiCAR-authorised Crypto-Asset Service Provider in ${entity.country}, supervised by ${authority}. View services, LEI, source freshness and register context.`;
  const pageTitle = `${entity.name} | MiCA CASP | ${entity.country} | DEA Tracker`;
  const verifySubject = encodeURIComponent('Verify organisation affiliation - ' + entity.name);
  const verifyBody = encodeURIComponent('Hello DEA,\n\nI represent ' + entity.name + ' and would like to verify my organisation affiliation for the MiCAR Tracker.\n\nName:\nRole:\nWork email:\n\nEntity page: ' + canonical);
  const correctionSubject = encodeURIComponent('MiCAR Tracker correction - ' + entity.name);
  const correctionBody = encodeURIComponent('Hello DEA,\n\nI would like to suggest a correction to this MiCAR Tracker entity page.\n\nEntity: ' + entity.name + '\nPage: ' + canonical + '\nCorrection and supporting source:\n');
  const organizationId = canonical + '#organization';
  const datasetId = canonical + '#dataset';
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: entity.name,
        legalName: entity.name,
        alternateName: entity.alsoKnownAs || [],
        leiCode: entity.lei || undefined,
        url: canonical,
        sameAs: website ? [website] : undefined,
        address: { '@type': 'PostalAddress', addressCountry: entity.country },
        subjectOf: { '@id': datasetId }
      },
      {
        '@type': 'Dataset',
        '@id': datasetId,
        name: 'ESMA interim MiCA register record for ' + entity.name,
        description: metaDescription,
        url: ESMA_SOURCE,
        isBasedOn: ESMA_SOURCE,
        dateModified: dateModified,
        creator: { '@type': 'Organization', name: 'Digital Euro Association', url: 'https://digital-euro-association.de' }
      },
      {
        '@type': 'WebPage',
        '@id': canonical + '#webpage',
        url: canonical,
        name: pageTitle,
        dateModified: dateModified,
        mainEntity: { '@id': organizationId },
        breadcrumb: { '@id': canonical + '#breadcrumb' }
      },
      {
        '@type': 'BreadcrumbList',
        '@id': canonical + '#breadcrumb',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'CASP Tracker', item: SITE_URL + '/casp-tracker.html' },
          { '@type': 'ListItem', position: 2, name: entity.name, item: canonical }
        ]
      }
    ]
  };

  const historyHtml = history.length ? history.map(function (event) {
    return `<li class="entity-history-item${event.current ? ' is-current' : ''}"><span class="entity-history-dot" aria-hidden="true"></span><time datetime="${esc(event.date)}">${esc(formatDate(event.date))}</time><span>${esc(event.label)}</span></li>`;
  }).join('') : '<li class="entity-empty">No historical observations are available yet.</li>';

  const contextHtml = contextRows.map(function (row) {
    return `<a class="entity-context-row" href="${esc(queryHref(row.query))}"><span>${esc(row.label)}</span><strong>${row.count}</strong></a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cloud.umami.is; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloud.umami.is https://api-gateway.umami.dev; object-src 'none'; base-uri 'self'; form-action 'self' mailto:">
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(metaDescription)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:title" content="${esc(pageTitle)}">
  <meta property="og:description" content="${esc(metaDescription)}">
  <meta property="og:image" content="${SITE_URL}/cover.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE_URL}/cover.png">
  <link rel="icon" type="image/png" href="../favicon.png">
  <link rel="alternate" type="application/rss+xml" title="MiCAR Tracker register updates" href="../feed.xml">
  <script type="application/ld+json">${jsonForHtml(structuredData)}</script>
  <link rel="stylesheet" href="../styles/tailwind.css">
  <link rel="stylesheet" href="../styles/site.css">
  <link rel="stylesheet" href="../styles/entity.css">
  <link rel="stylesheet" href="../assets/vendor/inter/inter.css">
  <link rel="stylesheet" href="../assets/vendor/fontawesome/css/all.min.css">
  <script defer src="https://cloud.umami.is/script.js" data-website-id="dbd82f5d-689a-452f-9fff-fba85b9de507"></script>
</head>
<body class="entity-page-body">
  <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-white focus:text-blue-900 focus:font-semibold focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg">Skip to main content</a>
  <header class="header-sticky shadow-2xl">
    <div class="max-w-7xl mx-auto px-6 py-6">
      <div class="flex items-center justify-between flex-wrap header-content">
        <div class="flex items-center space-x-6 mb-4 md:mb-0">
          <a href="../index.html" class="inline-flex items-center" aria-label="Return to the dashboard"><img src="../DEA%20logo%20white.svg" alt="DEA Logo" class="logo-container"></a>
          <div class="text-[1.8rem] md:text-[2.2rem] font-bold text-white mb-0 leading-tight" aria-label="MiCAR Tracker"><span class="text-sky-100">MiCAR</span> <span class="text-sky-50">Tracker</span></div>
        </div>
        <div class="flex items-center gap-3 header-actions">
          <nav class="hidden md:flex items-center nav-buttons" aria-label="Main navigation">
            <a href="../index.html" class="tab-button tab-inactive px-5 py-3 rounded-xl font-semibold inline-flex items-center justify-center"><i class="fas fa-chart-pie mr-2" aria-hidden="true"></i>Overview</a>
            <a href="../emt-tracker.html" class="tab-button tab-inactive px-5 py-3 rounded-xl font-semibold inline-flex items-center justify-center"><i class="fas fa-table mr-2" aria-hidden="true"></i>EMTs</a>
            <a href="../casp-tracker.html" class="tab-button tab-active px-5 py-3 rounded-xl font-semibold inline-flex items-center justify-center"><i class="fas fa-building-columns mr-2" aria-hidden="true"></i>CASPs</a>
            <a href="../non-compliant-casps.html" class="tab-button tab-inactive px-5 py-3 rounded-xl font-semibold inline-flex items-center justify-center"><i class="fas fa-exclamation-triangle mr-2" aria-hidden="true"></i>Non-Compliant</a>
            <a href="../about.html" class="tab-button tab-inactive px-5 py-3 rounded-xl font-semibold inline-flex items-center justify-center"><i class="fas fa-circle-info mr-2" aria-hidden="true"></i>About</a>
          </nav>
          <div class="md:hidden flex items-center hamburger-only"><button id="mobile-menu-button" type="button" class="hamburger-button text-white hover:text-sky-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white" aria-controls="mobile-menu" aria-expanded="false" aria-label="Open main menu"><i id="hamburger-icon" class="fas fa-bars" aria-hidden="true"></i><i id="close-icon" class="fas fa-xmark hidden" aria-hidden="true"></i></button></div>
        </div>
      </div>
    </div>
  </header>

  <div id="mobile-menu-overlay" class="mobile-menu-overlay fixed inset-0 hidden" aria-hidden="true"></div>
  <div id="mobile-menu" class="mobile-menu-container hidden"><div class="mobile-menu-panel p-4"><nav class="flex flex-col mobile-menu-list" aria-label="Mobile navigation">
    <a href="../index.html" class="mobile-menu-link mobile-menu-item text-base font-medium"><span class="mobile-menu-icon" aria-hidden="true"><i class="fas fa-chart-pie"></i></span><span class="mobile-menu-text">Overview</span></a>
    <a href="../emt-tracker.html" class="mobile-menu-link mobile-menu-item text-base font-medium"><span class="mobile-menu-icon" aria-hidden="true"><i class="fas fa-table"></i></span><span class="mobile-menu-text">EMTs</span></a>
    <a href="../casp-tracker.html" class="mobile-menu-link mobile-menu-item text-base font-medium"><span class="mobile-menu-icon" aria-hidden="true"><i class="fas fa-building-columns"></i></span><span class="mobile-menu-text">CASPs</span></a>
    <a href="../non-compliant-casps.html" class="mobile-menu-link mobile-menu-item text-base font-medium"><span class="mobile-menu-icon" aria-hidden="true"><i class="fas fa-exclamation-triangle"></i></span><span class="mobile-menu-text">Non-Compliant</span></a>
    <a href="../about.html" class="mobile-menu-link mobile-menu-item text-base font-medium"><span class="mobile-menu-icon" aria-hidden="true"><i class="fas fa-circle-info"></i></span><span class="mobile-menu-text">About</span></a>
  </nav></div></div>

  <main id="main" class="entity-page-shell">
    <nav class="entity-breadcrumb" aria-label="Breadcrumb"><a href="../casp-tracker.html">CASP Tracker</a><span aria-hidden="true">/</span><span aria-current="page">${esc(entity.name)}</span></nav>

    <section class="entity-hero" aria-labelledby="entity-name">
      <div class="entity-hero-main">
        ${entityLogo(entity, data.logos)}
        <div>
          <h1 id="entity-name">${esc(entity.name)}</h1>
          <p class="entity-type">CASP <span aria-hidden="true">•</span> ${esc(entity.country)}</p>
          <div class="entity-meta-line">
            <span class="entity-status"><i class="fas fa-circle-check" aria-hidden="true"></i>Authorised under MiCAR</span>
            <span>Competent authority: <strong>${esc(authority)} - ${esc(entity.country)}</strong> <span class="entity-flag" aria-hidden="true">${flag}</span></span>
            <span>Register snapshot: <strong>${esc(sourceDate)}</strong></span>
            <span>Last checked: <strong>${esc(checkedDate)}</strong></span>
          </div>
          <div class="entity-submeta">
            <span><i class="fas fa-globe" aria-hidden="true"></i> Website: ${websites(entity, true)}</span>
            <span><i class="fas fa-fingerprint" aria-hidden="true"></i> LEI: ${entity.lei ? `<code>${esc(entity.lei)}</code><button class="entity-copy" type="button" data-copy="${esc(entity.lei)}" aria-label="Copy LEI ${esc(entity.lei)}"><i class="fas fa-copy" aria-hidden="true"></i></button>` : '<span class="entity-muted">Not provided in the ESMA source</span>'}</span>
            <span class="entity-copy-status" aria-live="polite"></span>
          </div>
        </div>
      </div>
      <a class="entity-primary-action" href="${ESMA_SOURCE}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>View official ESMA source</a>
    </section>

    <div class="entity-layout">
      <div class="entity-main-column">
        <section class="entity-panel entity-record" aria-labelledby="record-title">
          <h2 id="record-title">Regulatory record</h2>
          <dl class="entity-facts">
            <div><dt><i class="fas fa-file" aria-hidden="true"></i>Legal name</dt><dd>${esc(entity.name)}</dd></div>
            <div><dt><i class="fas fa-location-dot" aria-hidden="true"></i>Country</dt><dd><span class="entity-flag" aria-hidden="true">${flag}</span> ${esc(entity.country)}</dd></div>
            <div><dt><i class="fas fa-landmark" aria-hidden="true"></i>Competent authority</dt><dd>${esc(authority)} - ${esc(entity.country)} <span class="entity-flag" aria-hidden="true">${flag}</span></dd></div>
            <div><dt><i class="fas fa-globe" aria-hidden="true"></i>Website</dt><dd>${websites(entity)}</dd></div>
          </dl>
          <div class="entity-permissions"><h3><i class="fas fa-shield-halved" aria-hidden="true"></i>Service permissions</h3><p>Authorised to provide the following services under MiCAR:</p><div class="entity-services">${serviceBadges(entity) || '<span class="entity-muted">Not specified in the source data</span>'}</div></div>
        </section>
${note}
        <section class="entity-panel entity-history" aria-labelledby="history-title">
          <h2 id="history-title"><i class="fas fa-clock-rotate-left" aria-hidden="true"></i>Change history</h2>
          <ol>${historyHtml}</ol>
        </section>
      </div>

      <aside class="entity-side-column" aria-label="Source, organisation and context information">
        <section class="entity-panel entity-source" aria-labelledby="source-title"><h2 id="source-title">Source and freshness</h2><dl>
          <div><dt>Official source</dt><dd><a href="${ESMA_SOURCE}" target="_blank" rel="noopener" class="entity-link">ESMA MiCA register <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a></dd></div>
          <div><dt>Register snapshot</dt><dd>${esc(sourceDate)}</dd></div>
          <div><dt>Last checked</dt><dd>${esc(checkedDate)}</dd></div>
        </dl><p class="entity-source-note"><i class="fas fa-circle-info" aria-hidden="true"></i>This page reflects public register information as recorded by ESMA on the snapshot date shown above.</p></section>

        <section class="entity-panel entity-represent" aria-labelledby="represent-title"><h2 id="represent-title">Represent this organisation?</h2><p>Verify a work email to receive profile alerts and manage company-provided information. Regulatory data cannot be edited here.</p><a class="entity-secondary-action" href="mailto:${CONTACT_EMAIL}?subject=${verifySubject}&amp;body=${verifyBody}"><i class="fas fa-envelope" aria-hidden="true"></i>Verify organisation affiliation</a><a class="entity-correction" href="mailto:${CONTACT_EMAIL}?subject=${correctionSubject}&amp;body=${correctionBody}"><i class="fas fa-pen" aria-hidden="true"></i>Suggest a correction</a><small>Corrections are free.</small></section>

        <section class="entity-panel entity-context" aria-labelledby="context-title"><h2 id="context-title">In context · ${esc(entity.country)}</h2><div class="entity-context-list">${contextHtml}</div><p>Based on ${data.entities.length} resolved legal entities in the ESMA snapshot of ${esc(sourceDate)}.</p></section>

        <section class="entity-panel entity-company" aria-labelledby="company-title"><h2 id="company-title">Company-provided information</h2><div class="entity-company-empty"><i class="fas fa-user" aria-hidden="true"></i><p>This organisation has not published company-provided information.</p></div><a href="${MEMBERSHIP_URL}" target="_blank" rel="noopener" class="entity-link">Learn about DEA institutional membership <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a></section>
      </aside>
    </div>
  </main>

  <footer class="entity-footer"><p>The information on this page is provided for general information purposes only. Verify formal authorisation status against the official register.</p><p>Membership is not regulatory endorsement.</p></footer>
  <script src="../assets/js/mobile-menu.js"></script>
  <script src="../assets/js/entity-page.js"></script>
</body>
</html>
`;
}

function generateEntityPages() {
  const entitiesFile = readJson('entities.json', { entities: [] });
  const entities = Array.isArray(entitiesFile.entities) ? entitiesFile.entities : [];
  if (!entities.length) throw new Error('No resolved entities found in data/entities.json');

  const data = {
    entities,
    casps: readJson('casps.json', []),
    logos: readJson('casp-logos.json', {}),
    anomalies: (readJson('anomalies.json', { anomalies: [] }).anomalies || []),
    changelog: readJson('changelog.json', []),
    snapshot: readJson('snapshot.json', {})
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  entities.forEach(function (entity) {
    fs.writeFileSync(path.join(OUTPUT_DIR, entity.slug + '.html'), entityPage(entity, data));
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, '.generated'), 'Generated by scripts/generate-entity-pages.js\n');
  console.log('🏢 Generated ' + entities.length + ' entity pages in ' + path.relative(ROOT, OUTPUT_DIR));
  return { entities, lookup: entityLookup(entities) };
}

if (require.main === module) {
  generateEntityPages();
}

module.exports = { generateEntityPages, entityPage, contextFor, changeHistory, entityLookup };
