/*
 * register-view.js — renders a single MiCA register (CASPs, EMT issuers, or
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
      searchPlaceholder: 'Search CASPs, countries, services…',
      searchLabel: 'Search CASPs by name, country, authority, service, or website',
      caption: 'Crypto-Asset Service Providers registered under MiCAR',
      filters: true,
      columns: [
        { label: '#', width: '4%' },
        { label: 'CASP', width: '24%', sort: 'name' },
        { label: 'Country', width: '16%', sort: 'memberState' },
        { label: 'Competent Authority', width: '12%', sort: 'authority' },
        { label: 'Services', width: '28%', cls: 'services-cell' },
        { label: 'Websites', width: '16%' }
      ],
      matches: function (item, term) {
        return (item.name || '').toLowerCase().indexOf(term) !== -1 ||
          (item.memberState || '').toLowerCase().indexOf(term) !== -1 ||
          (item.authority || '').toLowerCase().indexOf(term) !== -1 ||
          (item.services || []).join(' ').toLowerCase().indexOf(term) !== -1 ||
          (item.websites || []).join(' ').toLowerCase().indexOf(term) !== -1;
      },
      row: function (item, i) {
        const services = (item.services || []).map(function (s) {
          return '<span class="service-badge px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium">' + esc(s) + '</span>';
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
          '<td class="p-4 text-sm font-semibold text-gray-500">' + (i + 1) + '</td>' +
          '<td class="p-4"><p class="text-gray-900 font-semibold">' + esc(item.name || 'N/A') + '</p></td>' +
          '<td class="p-4"><span class="casps-country-badge px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.memberState) + '</span> ' + esc(item.memberState || 'Unknown') + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm casps-authority-cell">' + esc(item.authority || '—') + '</td>' +
          '<td class="p-4 services-cell"><div class="service-badges">' + (services || '<span class="text-xs text-gray-500">Not specified</span>') + '</div></td>' +
          '<td class="p-4"><div class="space-y-1">' + sites + '</div></td></tr>';
      },
      csv: [
        { label: 'CASP', value: function (r) { return r.name; } },
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
          '<td class="p-4"><div class="font-semibold text-gray-800">' + esc(item.issuer) + '</div></td>' +
          '<td class="p-4"><span class="px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.state) + '</span> ' + esc(item.state) + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm">' + esc(item.authority) + '</td>' +
          '<td class="p-4"><div class="text-sm text-gray-800 font-mono">' + esc(item.tokens || 'N/A') + '</div></td>' +
          '<td class="p-4 text-center"><span class="px-3 py-1 rounded-full text-sm font-bold ' + countCls + '">' + esc(item.count) + '</span></td>' +
          '<td class="p-4 text-center"><div class="flex justify-center space-x-1">' + badges + '</div></td></tr>';
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
          '<td class="p-4 text-sm font-semibold text-gray-500">' + (i + 1) + '</td>' +
          '<td class="p-4"><div class="font-semibold text-gray-800 flex items-center"><span>' + esc(item.entity) + '</span>' + newBadge + '</div></td>' +
          '<td class="p-4"><span class="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-medium"><span aria-hidden="true">' + flag(item.country) + '</span> ' + esc(item.country) + '</span></td>' +
          '<td class="p-4 text-gray-600 text-sm">' + esc(item.authority) + '</td>' +
          '<td class="p-4"><div class="space-y-1">' + sites + '</div></td>' +
          '<td class="p-4 text-center"><span class="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-bold" title="Flagged"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i><span class="sr-only">Flagged</span></span></td></tr>';
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

  const cfg = CONFIGS[register];
  if (!cfg) { root.innerHTML = '<p class="text-red-700">Unknown register.</p>'; return; }

  // ---- state ------------------------------------------------------------
  let all = [];
  let filtered = [];
  const sortState = { key: null, dir: 1 };

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

  function renderRows() {
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
    tbody.innerHTML = rows.map(function (item, i) { return cfg.row(item, i, all); }).join('');
  }

  function csvColumns() {
    return cfg.csvColumns ? cfg.csvColumns(all) : cfg.csv;
  }

  // ---- markup -----------------------------------------------------------
  function controlsHtml() {
    const filterSelects = cfg.filters
      ? '<select id="rvCountry" aria-label="Filter by country" class="search-input px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-teal-500 focus:border-transparent"><option value="">All countries</option></select>' +
        '<select id="rvService" aria-label="Filter by service" class="search-input px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-teal-500 focus:border-transparent"><option value="">All services</option></select>'
      : '';
    const dlBtnColor = cfg.theme === 'red' ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700';
    const jsonColor = cfg.theme === 'red' ? 'bg-red-100 text-red-800 hover:bg-red-200' : 'bg-teal-100 text-teal-800 hover:bg-teal-200';
    const ring = cfg.theme === 'red' ? 'focus:ring-red-500' : 'focus:ring-teal-500';
    return '<div class="flex flex-wrap items-center gap-3 mb-6">' +
      filterSelects +
      '<div class="relative">' +
      '<input type="text" id="rvSearch" placeholder="' + esc(cfg.searchPlaceholder) + '" aria-label="' + esc(cfg.searchLabel) + '" class="search-input pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 ' + ring + ' focus:border-transparent w-64">' +
      '<i class="fas fa-search absolute left-3 top-3 text-gray-400" aria-hidden="true"></i>' +
      '</div>' +
      '<button id="rvClear" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors"><i class="fas fa-times mr-1" aria-hidden="true"></i>Clear</button>' +
      '<div class="flex items-center gap-3">' +
      '<span class="text-sm text-gray-500">Download:</span>' +
      '<button id="rvCsv" class="px-3 py-2 text-sm text-white rounded-lg transition-colors whitespace-nowrap ' + dlBtnColor + '"><i class="fas fa-download mr-1" aria-hidden="true"></i>CSV</button>' +
      '<a href="' + cfg.jsonHref + '" download="' + cfg.jsonName + '" class="px-3 py-2 text-sm rounded-lg transition-colors whitespace-nowrap font-semibold ' + jsonColor + '">JSON</a>' +
      '</div></div>';
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
    return '<div class="bg-white bg-opacity-95 backdrop-filter backdrop-blur-lg rounded-2xl shadow-lg p-6">' +
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
    const debounced = debounce(applyFilters, 150);
    document.getElementById('rvSearch').addEventListener('input', debounced);
    document.getElementById('rvClear').addEventListener('click', function () {
      document.getElementById('rvSearch').value = '';
      if (cfg.filters) { document.getElementById('rvCountry').value = ''; document.getElementById('rvService').value = ''; }
      applyFilters();
    });
    if (cfg.filters) {
      document.getElementById('rvCountry').addEventListener('change', applyFilters);
      document.getElementById('rvService').addEventListener('change', applyFilters);
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
      if (!isNaN(u.getTime())) parts.push('last checked ' + u.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
    }
    if (parts.length) el.textContent = parts.join(' · ');
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
    root.innerHTML = shellHtml();
    if (cfg.filters) populateFilters();
    wire();
    renderRows();
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
