/*
 * register-view.js: renders a single MiCA register (CASPs, EMT issuers, or
 * non-compliant entities) into a mount point, with search, sorting, CSV/JSON
 * export, freshness, and (for CASPs) country/service filters.
 *
 * Used by the standalone intent pages (casp-tracker.html, emt-tracker.html,
 * non-compliant-casps.html). It is deliberately self-contained and does not
 * touch the main dashboard's inline script, so the live index.html carries no
 * risk from changes here. The country-flag map below is duplicated from
 * index.html on purpose for isolation; consolidating both onto this module is
 * tracked as future cleanup.
 *
 * Mount point: <div id="registerRoot" data-register="casps|emt|nonCompliant">
 */
(function () {
  'use strict';

  const root = document.getElementById('registerRoot');
  if (!root) return;
  const register = root.dataset.register;

  // CASP data stores stable internal service codes. Keep the table compact,
  // while the title/aria label retains the full regulatory wording.
  const SERVICE_LABELS = {
    custody: { short: 'Custody', full: 'Custody' },
    'trading platform': { short: 'Trading platform', full: 'Operation of a trading platform' },
    'exchange funds': { short: 'Funds exchange', full: 'Exchange for funds' },
    'exchange crypto': { short: 'Crypto exchange', full: 'Exchange for crypto-assets' },
    execution: { short: 'Execution', full: 'Execution' },
    placing: { short: 'Placing', full: 'Placing' },
    RTO: { short: 'RTO', full: 'Reception and transmission of orders' },
    advice: { short: 'Advice', full: 'Advice' },
    'portfolio mgmt': { short: 'Portfolio mgmt', full: 'Portfolio management' },
    transfer: { short: 'Transfers', full: 'Transfer services' }
  };

  function serviceDisplay(code) {
    return SERVICE_LABELS[code] || { short: code, full: code };
  }

  // ---- helpers ----------------------------------------------------------
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function safeHttpUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait || 150);
    };
  }

  function csvEscape(value) {
    const str = String(value == null ? '' : value);
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  function downloadCsv(filename, columns, rows) {
    if (!rows.length) return;
    const header = columns.map(function (c) { return csvEscape(c.label); }).join(',');
    const lines = rows.map(function (row) {
      return columns.map(function (c) { return csvEscape(c.value(row)); }).join(',');
    });
    const blob = new Blob(['\uFEFF' + [header].concat(lines).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function formatSnapshotDate(value) {
    if (!value) return '';
    const parts = String(value).split(/[/\-.]/);
    if (parts.length === 3) {
      let day, month, year;
      if (parts[0].length === 4) { year = parts[0]; month = parts[1]; day = parts[2]; }
      else { day = parts[0]; month = parts[1]; year = parts[2]; }
      const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (!isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      }
    }
    return String(value);
  }

  const countryFlags = {
    'Austria': '🇦🇹', 'Belgium': '🇧🇪', 'Bulgaria': '🇧🇬', 'Croatia': '🇭🇷', 'Cyprus': '🇨🇾',
    'Czech Republic': '🇨🇿', 'Czechia': '🇨🇿', 'Denmark': '🇩🇰', 'Estonia': '🇪🇪', 'Finland': '🇫🇮',
    'France': '🇫🇷', 'Germany': '🇩🇪', 'Greece': '🇬🇷', 'Hungary': '🇭🇺', 'Ireland': '🇮🇪',
    'Italy': '🇮🇹', 'Latvia': '🇱🇻', 'Lithuania': '🇱🇹', 'Luxembourg': '🇱🇺', 'Malta': '🇲🇹',
    'Netherlands': '🇳🇱', 'Poland': '🇵🇱', 'Portugal': '🇵🇹', 'Romania': '🇷🇴', 'Slovakia': '🇸🇰',
    'Slovenia': '🇸🇮', 'Spain': '🇪🇸', 'Sweden': '🇸🇪', 'Iceland': '🇮🇸', 'Liechtenstein': '🇱🇮',
    'Norway': '🇳🇴', 'United Kingdom': '🇬🇧', 'UK': '🇬🇧'
  };
  function flag(country) { return countryFlags[country] || '🏳️'; }

  const currencyInfo = {
    'EUR': { symbol: '💶', color: 'orange' }, 'USD': { symbol: '💵', color: 'coral' },
    'GBP': { symbol: '💷', color: 'purple' }, 'CZK': { symbol: '🇨🇿', color: 'blue' },
    'CHF': { symbol: '🇨🇭', color: 'red' }, 'SEK': { symbol: '🇸🇪', color: 'yellow' },
    'PLN': { symbol: '🇵🇱', color: 'red' }, 'RON': { symbol: '🇷🇴', color: 'yellow' },
    'NOK': { symbol: '🇳🇴', color: 'teal' }, 'DKK': { symbol: '🇩🇰', color: 'blue' },
    'HUF': { symbol: '🇭🇺', color: 'green' }, 'HKD': { symbol: '🇭🇰', color: 'green' }
  };
  const currencyBadgeStyles = {
    orange: 'background-color: #ffedd5; color: #c2410c;', coral: 'background-color: #ffe4e6; color: #be123c;',
    purple: 'background-color: #f3e8ff; color: #7e22ce;', blue: 'background-color: #dbeafe; color: #1d4ed8;',
    green: 'background-color: #dcfce7; color: #15803d;', red: 'background-color: #fee2e2; color: #b91c1c;',
    yellow: 'background-color: #fef9c3; color: #a16207;', teal: 'background-color: #ccfbf1; color: #0f766e;'
  };
  function currencyBadgeStyle(code) {
    const color = (currencyInfo[code] && currencyInfo[code].color) || 'green';
    return currencyBadgeStyles[color] || currencyBadgeStyles.green;
  }
  const EMT_STANDARD = { id: 1, issuer: 1, state: 1, authority: 1, tokens: 1, count: 1 };
  function currencyFields(items) {
    const set = {};
    items.forEach(function (item) {
      Object.keys(item || {}).forEach(function (k) { if (!EMT_STANDARD[k]) set[k] = 1; });
    });
    return Object.keys(set);
  }

  // ---- per-register configuration --------------------------------------
  const CONFIGS = {
    casps: {
      dataUrl: 'data/casps.json', jsonHref: 'data/casps.json', jsonName: 'micar-casps.json',
      csvName: 'micar-casps.csv', snapshotKey: 'caspsSnapshotDate', theme: 'teal',
      searchPlaceholder: 'Search CASPs, countries, services, LEI…',
      searchLabel: 'Search CASPs by name, LEI, country, authority, service, or website',
      caption: 'Crypto-Asset Service Providers registered under MiCAR',
      filters: true,
      unit: ['provider', 'providers'],
      groupOptions: [
        { key: 'country', label: 'Country', values: function (r) { return [(r.memberState || '').trim() || 'Unknown']; } }
      ],
      columns: [
        { label: '#', width: '4%' },
        { label: 'CASP', width: '24%', sort: 'name' },
        { label: 'Country', width: '16%', sort: 'memberState' },
        { label: 'Competent Authority', width: '12%', sort: 'authority' },
        { label: 'Services', width: '28%', cls: 'services-cell' },
        { label: 'Websites', width: '16%' }
      ],
      // The LEI is searchable but deliberately not a column: it is a 20-char
      // lookup key, not something a human scans, and the table is already six
      // columns wide. Paste an LEI into the search box and it resolves to the
      // CASP; the full value ships in the CSV and JSON exports.
      matches: function (item, term) {
        return (item.name || '').toLowerCase().indexOf(term) !== -1 ||
          (item.lei || '').toLowerCase().indexOf(term) !== -1 ||
          (item.memberState || '').toLowerCase().indexOf(term) !== -1 ||
          (item.authority || '').toLowerCase().indexOf(term) !== -1 ||
          (item.services || []).join(' ').toLowerCase().indexOf(term) !== -1 ||
          (item.websites || []).join(' ').toLowerCase().indexOf(term) !== -1;
      },
      row: function (item, i) {
        const title = item.entitySlug
          ? '<a class="rv-entity-link" href="entities/' + esc(item.entitySlug) + '.html">' + esc(item.name || 'N/A') + '</a>'
          : '<span class="text-gray-900 font-semibold">' + esc(item.name || 'N/A') + '</span>';
        const services = (item.services || []).map(function (s) {
          const display = serviceDisplay(s);
          return '<span class="service-badge px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium" title="' + esc(display.full) + '" aria-label="' + esc(display.full) + '">' + esc(display.short) + '</span>';
        }).join(' ');
        const sites = (item.websites && item.websites.length)
          ? item.websites.map(function (site) {
            const u = safeHttpUrl(site);
            return u
              ? '<a href="' + esc(u) + '" target="_blank" rel="noopener" class="casps-website-link block text-sm text-blue-600 underline">' + esc(site) + '</a>'
              : '<span class="casps-website-link block text-sm text-gray-600">' + esc(site) + '</span>';
          }).join('')
          : '<span class="text-xs text-gray-500">Not provided</span>';
        return '<tr class="border-b hover:bg-gradient-to-r hover:from-teal-200 hover:to-blue-200 transition-all duration-200">' +
          '<td class="p-4 text-sm font-semibold text-gray-500 rv-index" data-label="#">' + (i + 1) + '</td>' +
          '<td class="p-4 rv-title" data-label="CASP">' + title + '</td>' +
          '<td class="p-4" data-label="Country"><span class="casps-country-badge px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.memberState) + '</span> ' + esc(item.memberState || 'Unknown') + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm casps-authority-cell" data-label="Authority">' + esc(item.authority || 'N/A') + '</td>' +
          '<td class="p-4 services-cell" data-label="Services"><div class="service-badges">' + (services || '<span class="text-xs text-gray-500">Not specified</span>') + '</div></td>' +
          '<td class="p-4" data-label="Websites"><div class="space-y-1">' + sites + '</div></td></tr>';
      },
      csv: [
        { label: 'CASP', value: function (r) { return r.name; } },
        { label: 'LEI', value: function (r) { return r.lei || ''; } },
        { label: 'Country', value: function (r) { return r.memberState; } },
        { label: 'Competent Authority', value: function (r) { return r.authority; } },
        { label: 'Services', value: function (r) { return (r.services || []).join('; '); } },
        { label: 'Websites', value: function (r) { return (r.websites || []).join('; '); } }
      ]
    },

    emt: {
      dataUrl: 'data/emts.json', jsonHref: 'data/emts.json', jsonName: 'micar-emts.json',
      csvName: 'micar-emts.csv', snapshotKey: 'emtSnapshotDate', theme: 'teal',
      searchPlaceholder: 'Search issuers, countries, tokens…',
      searchLabel: 'Search EMT issuers by name, country, authority, or token',
      caption: 'Electronic Money Token issuers authorised under MiCAR',
      filters: false,
      unit: ['issuer', 'issuers'],
      groupOptions: [
        { key: 'country', label: 'Country', values: function (r) { return [(r.state || '').trim() || 'Unknown']; } },
        {
          key: 'currency',
          label: 'Backing currency',
          // An issuer may back several currencies, so it appears under each.
          multi: true,
          values: function (r) {
            const standard = { id: 1, issuer: 1, state: 1, authority: 1, tokens: 1, count: 1 };
            const found = Object.keys(r || {})
              .filter(function (k) { return !standard[k] && Number(r[k]) > 0; })
              .map(function (k) { return k.toUpperCase(); });
            return found.length ? found : ['Not specified'];
          }
        }
      ],
      columns: [
        { label: 'Issuer', width: '26%', sort: 'issuer' },
        { label: 'Country', width: '20%', sort: 'state' },
        { label: 'Authority', width: '18%', sort: 'authority' },
        { label: 'Tokens', width: '18%' },
        { label: 'Count', width: '8%', sort: 'count', align: 'center' },
        { label: 'Currencies', width: '10%', align: 'center' }
      ],
      matches: function (item, term) {
        return (item.issuer || '').toLowerCase().indexOf(term) !== -1 ||
          (item.state || '').toLowerCase().indexOf(term) !== -1 ||
          (item.authority || '').toLowerCase().indexOf(term) !== -1 ||
          (item.tokens || '').toLowerCase().indexOf(term) !== -1;
      },
      row: function (item, i, all) {
        const fields = currencyFields(all);
        const badges = fields.filter(function (c) { return item[c] > 0; }).map(function (c) {
          const code = c.toUpperCase();
          return '<span class="px-2 py-1 rounded text-xs font-semibold" style="' + currencyBadgeStyle(code) + '">' + esc(code) + '</span>';
        }).join(' ');
        const countCls = item.count > 1 ? 'bg-green-100 text-green-800' : (item.count === 1 ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600');
        return '<tr class="border-b hover:bg-gradient-to-r hover:from-teal-200 hover:to-blue-200 transition-all duration-200 ' + (i % 2 === 0 ? 'bg-gray-50' : 'bg-white') + '">' +
          '<td class="p-4 rv-title" data-label="Issuer"><div class="font-semibold text-gray-800">' + esc(item.issuer) + '</div></td>' +
          '<td class="p-4" data-label="Country"><span class="px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.state) + '</span> ' + esc(item.state) + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm" data-label="Authority">' + esc(item.authority) + '</td>' +
          '<td class="p-4" data-label="Tokens"><div class="text-sm text-gray-800 font-mono">' + esc(item.tokens || 'N/A') + '</div></td>' +
          '<td class="p-4 text-center" data-label="Count"><span class="px-3 py-1 rounded-full text-sm font-bold ' + countCls + '">' + esc(item.count) + '</span></td>' +
          '<td class="p-4 text-center" data-label="Currencies"><div class="flex justify-center space-x-1">' + badges + '</div></td></tr>';
      },
      csvColumns: function (all) {
        const base = [
          { label: 'Issuer', value: function (r) { return r.issuer; } },
          { label: 'Country', value: function (r) { return r.state; } },
          { label: 'Authority', value: function (r) { return r.authority; } },
          { label: 'Tokens', value: function (r) { return r.tokens; } },
          { label: 'Count', value: function (r) { return r.count; } }
        ];
        currencyFields(all).forEach(function (c) {
          base.push({ label: c.toUpperCase(), value: function (r) { return r[c] || 0; } });
        });
        return base;
      }
    },

    nonCompliant: {
      dataUrl: 'data/non-compliant.json', jsonHref: 'data/non-compliant.json', jsonName: 'micar-non-compliant.json',
      csvName: 'micar-non-compliant.csv', snapshotKey: 'caspsSnapshotDate', theme: 'red',
      searchPlaceholder: 'Search entities, authorities, websites…',
      searchLabel: 'Search non-compliant entities by name, country, authority, or website',
      caption: 'Entities flagged as non-compliant by European regulators',
      filters: false,
      unit: ['entity', 'entities'],
      groupOptions: [
        { key: 'country', label: 'Country', values: function (r) { return [(r.country || '').trim() || 'Unknown']; } }
      ],
      columns: [
        { label: '#', width: '5%' },
        { label: 'Entity Name', width: '25%', sort: 'entity' },
        { label: 'Country', width: '14%', sort: 'country' },
        { label: 'Regulatory Authority', width: '20%', sort: 'authority' },
        { label: 'Websites', width: '26%' },
        { label: 'Status', width: '10%', sort: 'isNew', align: 'center' }
      ],
      matches: function (item, term) {
        return (item.entity || '').toLowerCase().indexOf(term) !== -1 ||
          (item.country || '').toLowerCase().indexOf(term) !== -1 ||
          (item.authority || '').toLowerCase().indexOf(term) !== -1 ||
          (item.websites || []).some(function (w) { return w.toLowerCase().indexOf(term) !== -1; });
      },
      row: function (item, i) {
        const bg = item.isNew ? 'bg-blue-50' : (i % 2 === 0 ? 'bg-gray-50' : 'bg-white');
        // Websites of flagged entities are rendered as TEXT, never links.
        const sites = (item.websites || []).map(function (w) {
          return '<div class="text-xs text-blue-600 font-mono bg-blue-50 px-2 py-1 rounded">' + esc(w) + '</div>';
        }).join('');
        const newBadge = item.isNew ? '<span class="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold text-blue-700 bg-blue-100"><i class="fas fa-star text-blue-500 mr-1" aria-hidden="true"></i>New</span>' : '';
        return '<tr class="border-b hover:bg-gradient-to-r hover:from-red-50 hover:to-orange-50 transition-all duration-200 ' + bg + '">' +
          '<td class="p-4 text-sm font-semibold text-gray-500 rv-index" data-label="#">' + (i + 1) + '</td>' +
          '<td class="p-4 rv-title" data-label="Entity"><div class="font-semibold text-gray-800 flex items-center"><span>' + esc(item.entity) + '</span>' + newBadge + '</div></td>' +
          '<td class="p-4" data-label="Country"><span class="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.country) + '</span> ' + esc(item.country) + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm" data-label="Authority">' + esc(item.authority) + '</td>' +
          '<td class="p-4" data-label="Websites"><div class="space-y-1">' + sites + '</div></td>' +
          '<td class="p-4 text-center" data-label="Status"><span class="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-bold" title="Flagged"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i><span class="sr-only">Flagged</span></span></td></tr>';
      },
      csv: [
        { label: 'Entity', value: function (r) { return r.entity; } },
        { label: 'Country', value: function (r) { return r.country; } },
        { label: 'Regulatory Authority', value: function (r) { return r.authority; } },
        { label: 'Websites', value: function (r) { return (r.websites || []).join('; '); } },
        { label: 'New', value: function (r) { return r.isNew ? 'yes' : 'no'; } }
      ]
    }
  };

  // ---- per-register summary cards --------------------------------------
  // Rendered above the table. `extra` carries values that need a second
  // dataset (e.g. the non-compliant count shown on the CASP page).
  function uniqueCount(items, getKey) {
    const seen = {};
    items.forEach(function (i) {
      const k = (getKey(i) || '').trim().toLowerCase();
      if (k) seen[k] = 1;
    });
    return Object.keys(seen).length;
  }

  const SUMMARIES = {
    casps: function (items, extra) {
      return [
        { title: 'Total Providers', value: items.length, subtitle: 'Registered CASP providers', icon: '🏢', color: 'kpi-teal' },
        { title: 'Total Countries', value: uniqueCount(items, function (i) { return i.memberState; }), subtitle: 'Countries represented', icon: '🌍', color: 'kpi-blue' },
        { title: 'Non-Compliant CASPs', value: (extra && extra.nonCompliantCount != null) ? extra.nonCompliantCount : 'N/A', subtitle: 'Flagged providers', icon: '⚠️', color: 'kpi-red' }
      ];
    },
    emt: function (items) {
      const totalTokens = items.reduce(function (s, i) { return s + (Number(i.count) || 0); }, 0);
      return [
        { title: 'Total Issuers', value: items.length, subtitle: 'Active EMT providers', icon: '🏢', color: 'kpi-teal' },
        { title: 'Total Tokens', value: totalTokens, subtitle: 'Authorised EMTs', icon: '🪙', color: 'kpi-blue' },
        { title: 'Countries', value: uniqueCount(items, function (i) { return i.state; }), subtitle: 'Countries represented', icon: '🌍', color: 'kpi-orange' }
      ];
    },
    nonCompliant: function (items) {
      return [
        { title: 'Flagged Entities', value: items.length, subtitle: 'Total non-compliant', icon: '⚠️', color: 'kpi-red' },
        { title: 'New This Update', value: items.filter(function (i) { return i.isNew; }).length, subtitle: 'Recently added', icon: '⭐', color: 'kpi-blue' },
        { title: 'Countries', value: uniqueCount(items, function (i) { return i.country; }), subtitle: 'Countries represented', icon: '🌍', color: 'kpi-orange' }
      ];
    }
  };

  function summaryHtml(cards) {
    if (!cards || !cards.length) return '';
    const cols = Math.min(cards.length, 4);
    return '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-' + cols + ' gap-6 mb-8">' +
      cards.map(function (c) {
        return '<div class="kpi-card ' + c.color + ' p-6 rounded-2xl shadow-lg text-white card-hover">' +
          '<div class="flex items-center justify-between"><div>' +
          '<p class="text-sm opacity-90 font-medium">' + esc(c.title) + '</p>' +
          '<p class="text-3xl font-bold mt-2">' + esc(c.value) + '</p>' +
          '<p class="text-sm opacity-80 mt-1">' + esc(c.subtitle) + '</p>' +
          '</div><div class="text-4xl opacity-80" aria-hidden="true">' + c.icon + '</div></div></div>';
      }).join('') + '</div>';
  }

  const cfg = CONFIGS[register];
  if (!cfg) { root.innerHTML = '<p class="text-red-700">Unknown register.</p>'; return; }

  // ---- state ------------------------------------------------------------
  let all = [];
  let filtered = [];
  // Cross-dataset values that stay constant as the register is filtered
  // (e.g. the non-compliant count shown on the CASP summary).
  let extraSummary = null;
  const sortState = { key: null, dir: 1 };
  // Grouped view is reflected in the URL (?group=country) so a specific
  // arrangement can be linked to and shared, not just screenshotted.
  const groupOptions = cfg.groupOptions || [];
  let groupBy = (function () {
    try {
      const requested = new URLSearchParams(window.location.search).get('group');
      return groupOptions.some(function (o) { return o.key === requested; }) ? requested : '';
    } catch (e) { return ''; }
  })();

  // Collapsed group labels. Long registers start collapsed so the grouped view
  // opens as a scannable index (26 countries) rather than 300+ rows; short ones
  // stay open because there is nothing to scroll past.
  const COLLAPSE_THRESHOLD = 40;
  let collapsed = new Set();
  let collapseInitialised = false;

  function currentGroupOption() {
    for (let i = 0; i < groupOptions.length; i++) {
      if (groupOptions[i].key === groupBy) return groupOptions[i];
    }
    return null;
  }

  // Stable DOM id fragment for a group label (labels contain spaces/accents).
  function groupId(label) {
    return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  }

  function sortRows(rows) {
    if (!sortState.key) return rows;
    const key = sortState.key, dir = sortState.dir;
    return rows.slice().sort(function (a, b) {
      const va = a[key], vb = b[key];
      if (typeof va === 'number' || typeof vb === 'number' || typeof va === 'boolean' || typeof vb === 'boolean') {
        return (Number(va || 0) - Number(vb || 0)) * dir;
      }
      return String(va || '').localeCompare(String(vb || ''), 'en', { sensitivity: 'base' }) * dir;
    });
  }

  function applyFilters() {
    const term = (document.getElementById('rvSearch').value || '').trim().toLowerCase();
    const country = cfg.filters ? (document.getElementById('rvCountry').value || '') : '';
    const service = cfg.filters ? (document.getElementById('rvService').value || '') : '';
    filtered = all.filter(function (item) {
      const matchesSearch = !term || cfg.matches(item, term);
      const matchesCountry = !country || (item.memberState || '') === country;
      const matchesService = !service || (item.services || []).indexOf(service) !== -1;
      return matchesSearch && matchesCountry && matchesService;
    });
    renderRows();
  }

  // Keep the current view reproducible. Search/filter changes use replaceState
  // so typing does not create a browser-history entry for every character,
  // while copied/bookmarked URLs still reopen the same filtered register.
  function syncUrlFilters() {
    try {
      const url = new URL(window.location.href);
      const search = (document.getElementById('rvSearch')?.value || '').trim();
      const country = cfg.filters ? (document.getElementById('rvCountry')?.value || '') : '';
      const service = cfg.filters ? (document.getElementById('rvService')?.value || '') : '';
      const values = { q: search, country, service, group: groupBy || '' };

      Object.keys(values).forEach(function (key) {
        if (values[key]) url.searchParams.set(key, values[key]);
        else url.searchParams.delete(key);
      });
      history.replaceState(null, '', url);
    } catch (e) {
      // URL synchronisation is an enhancement; filtering must still work if
      // history APIs are unavailable in an embedded or restricted browser.
    }
  }

  // Summary cards reflect the current filtered view (Total Providers /
  // Countries track the filter); cross-dataset values come from extraSummary.
  function renderSummary() {
    const mount = document.getElementById('rvSummary');
    if (!mount || !SUMMARIES[register]) return;
    mount.innerHTML = summaryHtml(SUMMARIES[register](filtered, extraSummary));
  }

  function renderRows() {
    renderSummary();
    const rows = sortRows(filtered);
    const tbody = document.getElementById('rvTbody');
    const noResults = document.getElementById('rvNoResults');
    const count = document.getElementById('rvCount');
    if (count) count.textContent = rows.length + (rows.length === 1 ? ' entry' : ' entries');
    if (!rows.length) {
      tbody.innerHTML = '';
      noResults.classList.remove('hidden');
      return;
    }
    noResults.classList.add('hidden');
    if (groupBy && currentGroupOption()) {
      tbody.innerHTML = groupedRowsHtml(rows);
      applyCollapsedState();
    } else {
      tbody.innerHTML = rows.map(function (item, i) { return cfg.row(item, i, all); }).join('');
    }
    const expandBtn = document.getElementById('rvExpandAll');
    if (expandBtn) expandBtn.classList.toggle('hidden', !groupBy);
  }

  // Groups the current view using the selected dimension. An option may be
  // `multi` (a row belongs to several groups, e.g. an issuer backing both EUR
  // and USD); such rows deliberately appear under each, which is stated in the
  // UI so the totals are not read as duplicates.
  function buildGroups(rows) {
    const option = currentGroupOption();
    const groups = {};
    rows.forEach(function (item) {
      (option.values(item) || []).forEach(function (label) {
        const key = String(label || '').trim() || 'Unknown';
        (groups[key] = groups[key] || []).push(item);
      });
    });
    return groups;
  }

  function groupedRowsHtml(rows) {
    const option = currentGroupOption();
    const groups = buildGroups(rows);
    const labels = Object.keys(groups).sort(function (a, b) {
      return groups[b].length - groups[a].length || a.localeCompare(b, 'en');
    });

    // First render after a grouping change decides the default open/closed
    // state; user choices after that are preserved.
    if (!collapseInitialised) {
      collapsed = new Set(rows.length > COLLAPSE_THRESHOLD ? labels : []);
      collapseInitialised = true;
    }

    const singular = (cfg.unit && cfg.unit[0]) || 'entry';
    const plural = (cfg.unit && cfg.unit[1]) || 'entries';
    const span = cfg.columns.length;
    const showFlag = option.key === 'country';

    const multiNote = option.multi
      ? '<tr class="rv-group-note-row"><td colspan="' + span + '" class="rv-group-note">' +
        esc('Some ' + plural + ' appear in more than one group, so the group counts add up to more than the ' +
            rows.length + ' ' + (rows.length === 1 ? singular : plural) + ' shown.') +
        '</td></tr>'
      : '';

    return multiNote + labels.map(function (label) {
      const items = groups[label];
      const id = groupId(label);
      const isOpen = !collapsed.has(label);
      const icon = showFlag ? '<span aria-hidden="true">' + flag(label) + '</span> ' : '';

      const header = '<tr class="rv-group-row"><td class="rv-group-cell" colspan="' + span + '">' +
        '<button type="button" class="rv-group-toggle" data-group="' + esc(label) + '"' +
        ' aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="rvg-' + id + '">' +
        '<span class="rv-group-name"><span class="rv-group-chevron" aria-hidden="true">▸</span> ' + icon + esc(label) + '</span>' +
        '<span class="rv-group-count">' + items.length + ' ' + (items.length === 1 ? singular : plural) + '</span>' +
        '</button></td></tr>';

      const body = items.map(function (item, i) {
        return cfg.row(item, i, all)
          .replace('<tr ', '<tr data-group-body="' + esc(label) + '" ');
      }).join('');

      return header + body;
    }).join('');
  }

  // Hide/show rows without re-rendering the table.
  function applyCollapsedState() {
    root.querySelectorAll('[data-group-body]').forEach(function (tr) {
      tr.classList.toggle('rv-row-hidden', collapsed.has(tr.getAttribute('data-group-body')));
    });
    root.querySelectorAll('.rv-group-toggle').forEach(function (btn) {
      const open = !collapsed.has(btn.getAttribute('data-group'));
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.closest('tr').classList.toggle('rv-group-closed', !open);
    });
    const expandBtn = document.getElementById('rvExpandAll');
    if (expandBtn) {
      const anyClosed = collapsed.size > 0;
      expandBtn.textContent = anyClosed ? 'Expand all' : 'Collapse all';
      expandBtn.dataset.action = anyClosed ? 'expand' : 'collapse';
    }
  }

  function csvColumns() {
    return cfg.csvColumns ? cfg.csvColumns(all) : cfg.csv;
  }

  // ---- markup -----------------------------------------------------------
  function controlsHtml() {
    const filterSelects = cfg.filters
      ? '<select id="rvCountry" aria-label="Filter by country" class="rv-filter search-input px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-teal-500 focus:border-transparent"><option value="">All countries</option></select>' +
        '<select id="rvService" aria-label="Filter by service" class="rv-filter search-input px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-teal-500 focus:border-transparent"><option value="">All services</option></select>'
      : '';
    const dlBtnColor = cfg.theme === 'red' ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700';
    const jsonColor = cfg.theme === 'red' ? 'bg-red-100 text-red-800 hover:bg-red-200' : 'bg-teal-100 text-teal-800 hover:bg-teal-200';
    const ring = cfg.theme === 'red' ? 'focus:ring-red-500' : 'focus:ring-teal-500';
    // Clear / CSV / JSON share one group so they stay on a single line
    // (they wrap together as a unit on narrow screens). The responsive
    // widths are handled in site.css via the rv-* marker classes rather
    // than Tailwind sm:* utilities (which aren't in the prebuilt CSS).
    return '<div class="rv-controls flex flex-wrap items-center gap-3 mb-6">' +
      filterSelects +
      '<div class="rv-search relative">' +
      '<input type="text" id="rvSearch" placeholder="' + esc(cfg.searchPlaceholder) + '" aria-label="' + esc(cfg.searchLabel) + '" class="search-input pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 ' + ring + ' focus:border-transparent w-64">' +
      '<i class="fas fa-search absolute left-3 top-3 text-gray-400" aria-hidden="true"></i>' +
      '</div>' +
      groupControlsHtml() +
      '<div class="rv-actions flex items-center gap-3">' +
      '<button id="rvClear" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors whitespace-nowrap"><i class="fas fa-times mr-1" aria-hidden="true"></i>Clear</button>' +
      '<button id="rvCsv" class="px-3 py-2 text-sm text-white rounded-lg transition-colors whitespace-nowrap ' + dlBtnColor + '"><i class="fas fa-download mr-1" aria-hidden="true"></i>CSV</button>' +
      '<a href="' + cfg.jsonHref + '" download="' + cfg.jsonName + '" class="px-3 py-2 text-sm rounded-lg transition-colors whitespace-nowrap font-semibold ' + jsonColor + '"><i class="fas fa-download mr-1" aria-hidden="true"></i>JSON</a>' +
      '</div></div>';
  }

  function groupControlsHtml() {
    if (!groupOptions.length) return '';
    const opts = ['<option value="">No grouping</option>'].concat(groupOptions.map(function (o) {
      return '<option value="' + esc(o.key) + '"' + (o.key === groupBy ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    })).join('');
    const expandBtn = '<button id="rvExpandAll" type="button" data-action="expand" class="' +
      (groupBy ? '' : 'hidden ') +
      'px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap">Expand all</button>';
    return '<label class="rv-group-control inline-flex items-center gap-2 text-sm text-gray-600">' +
      '<span class="whitespace-nowrap">Group by</span>' +
      '<select id="rvGroup" aria-label="Group the register by" class="search-input px-3 py-2 rounded-lg border border-gray-300">' + opts + '</select>' +
      '</label>' + expandBtn;
  }

  function tableHtml() {
    const cols = cfg.columns.map(function (c) { return '<col style="width: ' + c.width + ';">'; }).join('');
    const ths = cfg.columns.map(function (c) {
      const align = c.align === 'center' ? 'text-center' : 'text-left';
      if (c.sort) {
        return '<th scope="col" aria-sort="none" data-sort-key="' + c.sort + '" class="' + align + ' p-4 font-semibold text-gray-700"><button type="button" class="sort-button">' + esc(c.label) + '<span class="sort-indicator" aria-hidden="true"></span></button></th>';
      }
      return '<th scope="col" class="' + align + ' p-4 font-semibold text-gray-700' + (c.cls ? ' ' + c.cls : '') + '">' + esc(c.label) + '</th>';
    }).join('');
    const tableCls = register === 'casps' ? 'data-table casps-data-table w-full' : 'data-table w-full';
    return '<div class="data-table-container"><table class="' + tableCls + '">' +
      '<caption class="sr-only">' + esc(cfg.caption) + '</caption>' +
      '<colgroup>' + cols + '</colgroup>' +
      '<thead class="sticky-table-header ' + cfg.theme + '"><tr class="bg-gradient-to-r ' + (cfg.theme === 'red' ? 'from-red-50 to-orange-50' : 'from-teal-50 to-blue-50') + '">' + ths + '</tr></thead>' +
      '<tbody id="rvTbody"></tbody></table></div>' +
      '<div id="rvNoResults" class="hidden text-center py-8 text-gray-500"><i class="fas fa-search text-4xl mb-4" aria-hidden="true"></i><p class="text-lg">No results found.</p></div>';
  }

  function shellHtml() {
    return '<div class="rv-shell bg-white bg-opacity-95 backdrop-filter backdrop-blur-lg rounded-2xl shadow-lg p-6">' +
      '<div id="rvSummary"></div>' +
      '<p id="rvCount" class="text-sm text-gray-500 mb-4"></p>' +
      controlsHtml() + tableHtml() + '</div>';
  }

  function wireSort() {
    const headers = root.querySelectorAll('th[data-sort-key]');
    headers.forEach(function (th) {
      const button = th.querySelector('.sort-button');
      if (!button) return;
      button.addEventListener('click', function () {
        const key = th.dataset.sortKey;
        if (sortState.key === key) sortState.dir = -sortState.dir;
        else { sortState.key = key; sortState.dir = 1; }
        headers.forEach(function (h) {
          const active = h === th;
          h.setAttribute('aria-sort', active ? (sortState.dir === 1 ? 'ascending' : 'descending') : 'none');
          const ind = h.querySelector('.sort-indicator');
          if (ind) ind.textContent = active ? (sortState.dir === 1 ? '▲' : '▼') : '';
        });
        renderRows();
      });
    });
  }

  function populateFilters() {
    const countrySel = document.getElementById('rvCountry');
    const serviceSel = document.getElementById('rvService');
    if (countrySel) {
      const countries = {};
      all.forEach(function (i) { const c = (i.memberState || '').trim(); if (c) countries[c] = 1; });
      countrySel.innerHTML = '<option value="">All countries</option>' +
        Object.keys(countries).sort().map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    }
    if (serviceSel) {
      const services = {};
      all.forEach(function (i) { (i.services || []).forEach(function (s) { s = s.trim(); if (s) services[s] = 1; }); });
      serviceSel.innerHTML = '<option value="">All services</option>' +
        Object.keys(services).sort().map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
    }
  }

  function wire() {
    const debounced = debounce(function () {
      syncUrlFilters();
      applyFilters();
    }, 150);
    document.getElementById('rvSearch').addEventListener('input', debounced);
    document.getElementById('rvClear').addEventListener('click', function () {
      document.getElementById('rvSearch').value = '';
      if (cfg.filters) { document.getElementById('rvCountry').value = ''; document.getElementById('rvService').value = ''; }
      syncUrlFilters();
      applyFilters();
    });
    if (cfg.filters) {
      document.getElementById('rvCountry').addEventListener('change', function () {
        syncUrlFilters();
        applyFilters();
      });
      document.getElementById('rvService').addEventListener('change', function () {
        syncUrlFilters();
        applyFilters();
      });
    }
    const groupSelect = document.getElementById('rvGroup');
    if (groupSelect) {
      groupSelect.addEventListener('change', function () {
        groupBy = groupSelect.value;
        collapseInitialised = false; // re-decide the default for the new grouping
        collapsed = new Set();
        syncUrlFilters();
        renderRows();
      });
    }

    window.addEventListener('popstate', function () {
      applyUrlFilters();
      applyFilters();
    });

    // Delegated so it survives re-renders of the table body.
    const tbodyEl = document.getElementById('rvTbody');
    if (tbodyEl) {
      tbodyEl.addEventListener('click', function (event) {
        const btn = event.target.closest('.rv-group-toggle');
        if (!btn) return;
        const label = btn.getAttribute('data-group');
        if (collapsed.has(label)) collapsed.delete(label);
        else collapsed.add(label);
        applyCollapsedState();
      });
    }

    const expandAll = document.getElementById('rvExpandAll');
    if (expandAll) {
      expandAll.addEventListener('click', function () {
        if (expandAll.dataset.action === 'expand') {
          collapsed = new Set();
        } else {
          collapsed = new Set(Object.keys(buildGroups(sortRows(filtered))));
        }
        applyCollapsedState();
      });
    }

    document.getElementById('rvCsv').addEventListener('click', function () {
      downloadCsv(cfg.csvName, csvColumns(), sortRows(filtered));
    });
    wireSort();
  }

  function setFreshness(snapshot) {
    const el = document.getElementById('rvFreshness');
    if (!el || !snapshot) return;
    const parts = [];
    const d = formatSnapshotDate(snapshot[cfg.snapshotKey] || snapshot.emtSnapshotDate || snapshot.caspsSnapshotDate);
    if (d) parts.push('Register snapshot: ' + d);
    if (snapshot.lastUpdated) {
      const u = new Date(snapshot.lastUpdated);
      if (!isNaN(u.getTime())) parts.push('last data update ' + u.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
    }
    if (parts.length) el.textContent = parts.join(' · ');
  }

  function applyUrlFilters() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return false; }
    let active = false;
    const search = params.get('q') || '';
    const country = params.get('country') || '';
    const service = params.get('service') || '';
    const requestedGroup = params.get('group') || '';
    const validGroup = groupOptions.some(function (o) { return o.key === requestedGroup; });
    groupBy = validGroup ? requestedGroup : '';
    collapseInitialised = false;
    collapsed = new Set();

    const searchInput = document.getElementById('rvSearch');
    if (searchInput) {
      searchInput.value = search;
      if (search) active = true;
    }
    const countrySelect = document.getElementById('rvCountry');
    if (countrySelect) {
      const validCountry = country && Array.from(countrySelect.options).some(function (o) { return o.value === country; });
      countrySelect.value = validCountry ? country : '';
      if (validCountry) active = true;
    }
    const serviceSelect = document.getElementById('rvService');
    if (serviceSelect) {
      const validService = service && Array.from(serviceSelect.options).some(function (o) { return o.value === service; });
      serviceSelect.value = validService ? service : '';
      if (validService) active = true;
    }
    const groupSelect = document.getElementById('rvGroup');
    if (groupSelect) groupSelect.value = groupBy;
    if (groupBy) active = true;
    return active;
  }

  // ---- boot -------------------------------------------------------------
  async function boot() {
    try {
      const res = await fetch(cfg.dataUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(cfg.dataUrl + ': HTTP ' + res.status);
      all = await res.json();
      if (!Array.isArray(all)) throw new Error('unexpected data shape');
    } catch (e) {
      root.innerHTML = '<div class="rounded-2xl bg-red-50 border border-red-200 p-4 text-red-800 text-sm" role="alert">Could not load the register data. Please refresh the page; if the problem persists the data file may be temporarily unavailable.</div>';
      return;
    }
    filtered = all.slice();

    // The CASP summary shows the non-compliant count, which lives in a
    // separate file. Fetch it first (non-fatal) so the card renders with
    // the real number; if it fails the card falls back to an em dash.
    if (register === 'casps') {
      try {
        const results = await Promise.all([
          fetch('data/non-compliant.json', { cache: 'no-cache' }),
          fetch('data/entities.json', { cache: 'no-cache' })
        ]);
        const ncRes = results[0];
        const entityRes = results[1];
        if (ncRes.ok) {
          const nc = await ncRes.json();
          if (Array.isArray(nc)) extraSummary = { nonCompliantCount: nc.length };
        }
        if (entityRes.ok) {
          const entityData = await entityRes.json();
          const bySourceId = {};
          const byLei = {};
          (entityData.entities || []).forEach(function (entity) {
            if (entity.lei) byLei[entity.lei] = entity.slug;
            (entity.authorisations || []).forEach(function (record) {
              if (record.sourceId != null) bySourceId[String(record.sourceId)] = entity.slug;
            });
          });
          all.forEach(function (item) {
            item.entitySlug = bySourceId[String(item.id)] || byLei[item.lei] || '';
          });
        }
      } catch (e) { /* non-fatal */ }
    }

    root.innerHTML = shellHtml();
    if (cfg.filters) populateFilters();
    wire();
    if (applyUrlFilters()) applyFilters();
    else renderRows(); // also renders the summary from the (initially full) view
    // Freshness (non-fatal)
    fetch('data/snapshot.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) setFreshness(s); })
      .catch(function () {});
  }

  // Track the site header height (it shrinks on scroll) so the sticky
  // column headers pin just below it - same mechanism as index.html.
  const siteHeaderEl = document.querySelector('.header-sticky');
  if (siteHeaderEl && 'ResizeObserver' in window) {
    const setSiteHeaderHeight = function () {
      document.documentElement.style.setProperty('--site-header-height', siteHeaderEl.offsetHeight + 'px');
    };
    setSiteHeaderHeight();
    new ResizeObserver(setSiteHeaderHeight).observe(siteHeaderEl, { box: 'border-box' });
  }

  boot();
})();
