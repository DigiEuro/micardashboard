/*
 * data-quality.js — renders data/anomalies.json as a public audit of what the
 * pipeline had to correct, preserve, or merely note while turning ESMA's
 * register rows into entities.
 *
 * The framing is deliberate. A flat "107 anomalies" headline would be
 * misleading: most entries are values we successfully repaired, and two of the
 * types are not defects at all (a firm may legitimately hold more than one
 * authorisation). Lumping those together would overstate how broken the source
 * is and understate how much the pipeline is doing. So entries are grouped by
 * what we DID about them, not by their internal type code.
 *
 * Security invariant: an anomaly value is by definition a value that failed
 * validation. None of them is ever rendered as a link, only as escaped text -
 * same rule the non-compliant register follows.
 *
 * Mount point: <div id="dqRoot"></div>
 */
(function () {
  'use strict';

  const root = document.getElementById('dqRoot');
  if (!root) return;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
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

  // ---- how each anomaly type is presented -------------------------------
  const TYPE_LABELS = {
    malformed_url: 'Website missing its scheme',
    encoding_artefact: 'Mistyped scheme',
    non_url_in_website_field: 'Not a URL',
    repeated_service_code: 'Service listed twice',
    multi_authorisation: 'Multiple authorisations'
  };

  const GROUPS = [
    {
      key: 'repaired',
      title: 'Corrections applied',
      icon: 'fa-wrench',
      tone: 'amber',
      types: ['malformed_url', 'encoding_artefact'],
      blurb: 'The register published a value we could interpret but not use as-is. '
        + 'We repaired it and record both forms — the original is kept verbatim in '
        + 'the data so the correction is always auditable.'
    },
    {
      key: 'preserved',
      title: 'Values we could not interpret',
      icon: 'fa-circle-question',
      tone: 'rose',
      types: ['non_url_in_website_field'],
      blurb: 'The field holds something that is not a URL — a page title, a postal '
        + 'address, or a note. We never guess. The value is preserved exactly as '
        + 'published and is shown as plain text, never as a clickable link.'
    },
    {
      key: 'observations',
      title: 'Observations, not defects',
      icon: 'fa-circle-info',
      tone: 'slate',
      types: ['multi_authorisation', 'repeated_service_code'],
      blurb: 'Nothing is wrong with these records. They are listed because they look '
        + 'surprising at a glance and we would rather explain them than have you '
        + 'wonder. A firm may legitimately hold more than one authorisation.'
    }
  ];

  let all = [];
  let sourceRows = 0;

  function groupOf(type) {
    for (const g of GROUPS) {
      if (g.types.indexOf(type) !== -1) return g;
    }
    return GROUPS[GROUPS.length - 1];
  }

  function matches(item, term) {
    return (item.name || '').toLowerCase().indexOf(term) !== -1 ||
      (item.country || '').toLowerCase().indexOf(term) !== -1 ||
      (item.entityKey || '').toLowerCase().indexOf(term) !== -1 ||
      (TYPE_LABELS[item.type] || item.type || '').toLowerCase().indexOf(term) !== -1 ||
      (item.values || []).join(' ').toLowerCase().indexOf(term) !== -1;
  }

  function downloadCsv(rows) {
    const cols = [
      { label: 'Entity', value: function (r) { return r.name; } },
      { label: 'Country', value: function (r) { return r.country; } },
      { label: 'Entity key', value: function (r) { return r.entityKey; } },
      { label: 'Category', value: function (r) { return groupOf(r.type).title; } },
      { label: 'Finding', value: function (r) { return TYPE_LABELS[r.type] || r.type; } },
      { label: 'Value as published', value: function (r) { return (r.values || []).join(' | '); } },
      { label: 'Detail', value: function (r) { return r.detail; } }
    ];
    const header = cols.map(function (c) { return csvEscape(c.label); }).join(',');
    const lines = rows.map(function (r) {
      return cols.map(function (c) { return csvEscape(c.value(r)); }).join(',');
    });
    const blob = new Blob(['﻿' + [header].concat(lines).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'micar-data-quality.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ---- rendering ---------------------------------------------------------
  function summaryCards(rows) {
    const cards = GROUPS.map(function (g) {
      const n = rows.filter(function (r) { return groupOf(r.type).key === g.key; }).length;
      return '<div class="dq-card dq-card-' + g.tone + '">' +
        '<p class="dq-card-count">' + n + '</p>' +
        '<p class="dq-card-label"><i class="fas ' + g.icon + ' mr-2" aria-hidden="true"></i>' + esc(g.title) + '</p>' +
        '</div>';
    }).join('');
    return '<div class="dq-cards">' + cards + '</div>';
  }

  function tableFor(group, rows) {
    const mine = rows.filter(function (r) { return groupOf(r.type).key === group.key; });

    const body = mine.length
      ? mine.map(function (r) {
        const values = (r.values || []).map(function (v) {
          // Never a link. These are the values that failed validation.
          return '<code class="dq-value">' + esc(v) + '</code>';
        }).join(' ');
        return '<tr class="border-b">' +
          '<td class="p-4" data-label="Entity"><p class="font-semibold text-gray-900">' + esc(r.name || 'Unknown') + '</p>' +
          '<p class="text-xs text-gray-500 mt-1">' + esc(r.country || '') + '</p></td>' +
          '<td class="p-4" data-label="Finding"><span class="dq-badge dq-badge-' + group.tone + '">' +
          esc(TYPE_LABELS[r.type] || r.type) + '</span></td>' +
          '<td class="p-4" data-label="Value as published">' + (values || '<span class="text-xs text-gray-500">—</span>') + '</td>' +
          '<td class="p-4 text-sm text-gray-600" data-label="What we did">' + esc(r.detail || '') + '</td>' +
          '</tr>';
      }).join('')
      : '<tr><td colspan="4" class="p-6 text-center text-gray-500">Nothing in this category — the register is clean here.</td></tr>';

    return '<section class="dq-section" id="dq-' + group.key + '">' +
      '<h2 class="dq-section-title"><i class="fas ' + group.icon + ' mr-2" aria-hidden="true"></i>' +
      esc(group.title) + ' <span class="dq-section-count">' + mine.length + '</span></h2>' +
      '<p class="dq-section-blurb">' + esc(group.blurb) + '</p>' +
      '<div class="overflow-x-auto">' +
      '<table class="w-full text-left dq-table">' +
      '<thead><tr class="dq-thead">' +
      '<th class="p-4" style="width:24%">Entity</th>' +
      '<th class="p-4" style="width:18%">Finding</th>' +
      '<th class="p-4" style="width:26%">Value as published</th>' +
      '<th class="p-4" style="width:32%">What we did</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }

  function render() {
    const term = (document.getElementById('dqSearch').value || '').trim().toLowerCase();
    const rows = term ? all.filter(function (r) { return matches(r, term); }) : all;

    document.getElementById('dqSummary').innerHTML = summaryCards(rows);
    document.getElementById('dqSections').innerHTML = GROUPS.map(function (g) {
      return tableFor(g, rows);
    }).join('');
    document.getElementById('dqCount').textContent = term
      ? rows.length + ' of ' + all.length + ' findings match'
      : all.length + ' findings across ' + sourceRows + ' authorisation records';
  }

  function shell() {
    root.innerHTML =
      '<div class="dq-controls">' +
      '<label for="dqSearch" class="sr-only">Search findings by entity, country, or value</label>' +
      '<input id="dqSearch" type="search" class="search-input" ' +
      'placeholder="Search entity, country, LEI, or value…" autocomplete="off">' +
      '<button id="dqCsv" class="px-3 py-2 text-sm text-white rounded-lg transition-colors whitespace-nowrap bg-blue-600 hover:bg-blue-700">' +
      '<i class="fas fa-download mr-1" aria-hidden="true"></i>CSV</button>' +
      '<a href="data/anomalies.json" download="micar-data-quality.json" ' +
      'class="px-3 py-2 text-sm rounded-lg transition-colors whitespace-nowrap font-semibold bg-white text-blue-700 hover:bg-blue-50">' +
      '<i class="fas fa-download mr-1" aria-hidden="true"></i>JSON</a>' +
      '</div>' +
      '<p id="dqCount" class="dq-count"></p>' +
      '<div id="dqSummary"></div>' +
      '<div id="dqSections"></div>';
  }

  function fail(message) {
    root.innerHTML = '<div class="bg-white bg-opacity-95 rounded-2xl shadow-lg p-6 text-gray-700">' +
      '<p class="font-semibold text-gray-900">Could not load the data-quality report.</p>' +
      '<p class="mt-2 text-sm">' + esc(message) + '</p></div>';
  }

  Promise.all([
    fetch('data/anomalies.json').then(function (r) {
      if (!r.ok) throw new Error('anomalies.json responded ' + r.status);
      return r.json();
    }),
    fetch('data/entities.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (results) {
    const payload = results[0];
    const entities = results[1];
    all = (payload && payload.anomalies) || [];
    sourceRows = (entities && entities.sourceRows) || 0;

    shell();
    render();
    document.getElementById('dqSearch').addEventListener('input', debounce(render, 150));
    document.getElementById('dqCsv').addEventListener('click', function () {
      const term = (document.getElementById('dqSearch').value || '').trim().toLowerCase();
      downloadCsv(term ? all.filter(function (r) { return matches(r, term); }) : all);
    });
  }).catch(function (error) {
    fail(error && error.message ? error.message : String(error));
  });
})();
