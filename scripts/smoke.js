#!/usr/bin/env node
/*
 * smoke.js: opens every page in a real browser and asserts it renders.
 *
 * Every other check in CI validates JSON or pipeline logic. None of them opens
 * a page, and the bugs that actually reached production were all render-time:
 * a Tailwind class missing from the committed build (three times), display:flex
 * cancelling a colspan, controls colliding on mobile. A file can be valid JSON,
 * valid JS and still paint a broken page.
 *
 * So this asserts the things a human would notice: the table has rows, the
 * controls exist, search narrows the list, and the console is clean.
 *
 * Run: npm run test:smoke
 * Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH; no download needed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 8123);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.txt': 'text/plain'
};

function serve() {
  return http.createServer(function (req, res) {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
}

// Umami is a third-party script; it is unreachable from CI and its absence
// says nothing about whether our pages work.
function isOurProblem(text) {
  return !/umami|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/i.test(text);
}

async function assertAccessibilityBasics(page, expect) {
  const issues = await page.evaluate(function () {
    const problems = [];
    const ids = Array.from(document.querySelectorAll('[id]')).map(function (el) { return el.id; });
    const duplicateIds = ids.filter(function (id, index) { return ids.indexOf(id) !== index; });
    if (duplicateIds.length) problems.push('duplicate ids: ' + Array.from(new Set(duplicateIds)).join(', '));

    document.querySelectorAll('a,button,input,select,textarea').forEach(function (el) {
      const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() ||
        (el.tagName === 'INPUT' && el.getAttribute('placeholder')) || '';
      if (!name) problems.push(el.tagName.toLowerCase() + ' has no accessible name');
    });
    document.querySelectorAll('input,select,textarea').forEach(function (el) {
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
        (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
      if (!labelled) problems.push((el.id || el.tagName.toLowerCase()) + ' has no label');
    });
    document.querySelectorAll('table').forEach(function (table) {
      if (!table.querySelector('caption')) problems.push('table has no caption');
    });
    return problems;
  });
  await expect(issues.length === 0, issues.length ? 'basic accessibility checks: ' + issues.join('; ') : 'basic accessibility checks pass');
}

/*
 * Some environments ship a preinstalled Chromium whose build number does not
 * match the pinned playwright package. Rather than download a second copy,
 * point at the one that is already there. In CI, where `playwright install`
 * has fetched a matching build, this finds nothing and we use the default.
 */
function launchOptions() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return {};
  let dirs;
  try {
    dirs = fs.readdirSync(base).filter(function (d) { return /^chromium-\d+$/.test(d); });
  } catch (error) {
    return {};
  }
  for (const dir of dirs) {
    const candidate = path.join(base, dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(candidate)) return { executablePath: candidate };
  }
  return {};
}

const CHECKS = [
  {
    page: 'index.html',
    assert: async function (page, expect) {
      await expect(await page.locator('header').count() > 0, 'header renders');
      await expect(await page.locator('footer a[href="data-quality.html"]').count() > 0,
        'footer links to the data-quality page');
      const flagFont = await page.evaluate(async function () {
        await document.fonts.ready;
        return document.fonts.check('16px "Twemoji Country Flags"');
      });
      await expect(flagFont, 'shared country flag font loads');
    }
  },
  {
    page: 'micar-explained.html',
    assert: async function (page, expect) {
      await expect(await page.locator('h1').textContent() === 'MiCA is the EU rulebook for crypto-assets.', 'MiCA explainer heading renders');
      await expect(await page.locator('#live-snapshot-title').count() === 1, 'live snapshot section renders');
      await expect(await page.locator('text=CASPs listed').count() === 1, 'live CASP stat renders');
      await expect(await page.locator('text=represented countries').count() === 1, 'live country stat renders');
      await expect(await page.locator('text=Largest represented country').count() === 1, 'largest represented country stat renders');
      await expect(await page.getByRole('link', { name: /Search authorised CASPs/i }).count() === 1, 'primary CASP action renders');
      await expect(await page.locator('a[href="casp-tracker.html"]').count() > 0, 'explainer links to CASP register');
      await assertAccessibilityBasics(page, expect);
    }
  },
  {
    page: 'index.html',
    name: 'index.html (mobile)',
    viewport: { width: 390, height: 844 },
    assert: async function (page, expect) {
      const overflow = await page.evaluate(function () {
        return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
      });
      await expect(overflow, 'no horizontal overflow at 390px');

      const menuButton = page.locator('#mobile-menu-button');
      await expect(await page.locator('#hamburger-icon').isVisible(), 'hamburger icon is visible while menu is closed');
      await expect(!(await page.locator('#close-icon').isVisible()), 'close icon is hidden while menu is closed');
      await menuButton.click();
      await expect(await menuButton.getAttribute('aria-expanded') === 'true', 'mobile menu opens');
      await expect(await page.locator('#mobile-menu:not(.hidden)').count() === 1, 'mobile menu is visible');
      await expect(!(await page.locator('#hamburger-icon').isVisible()), 'hamburger icon is hidden while menu is open');
      await expect(await page.locator('#close-icon').isVisible(), 'close icon is visible while menu is open');
      const closeButtonIsReachable = await page.evaluate(function () {
        const button = document.getElementById('mobile-menu-button');
        if (!button) return false;
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === button || button.contains(hit);
      });
      await expect(closeButtonIsReachable, 'open menu does not cover its close button');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await expect(await menuButton.getAttribute('aria-expanded') === 'false', 'Escape closes mobile menu');
      await expect(await page.evaluate(function () { return document.activeElement?.id === 'mobile-menu-button'; }),
        'closing the menu restores focus to its button');
      await assertAccessibilityBasics(page, expect);
    }
  },
  {
    page: 'casp-tracker.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 100, 'CASP table renders rows (got ' + rows + ')');
      const flags = await page.locator('#registerRoot tbody td[data-label="Country"] span[aria-hidden="true"]').count();
      await expect(flags > 0, 'CASP country flags render (got ' + flags + ')');
      const flagFont = await page.evaluate(async function () {
        await document.fonts.ready;
        return document.fonts.check('16px "Twemoji Country Flags"');
      });
      await expect(flagFont, 'shared country flag font loads');
      await page.fill('#rvSearch', 'Bitpanda');
      await page.waitForTimeout(400);
      const hits = await page.locator('#registerRoot tbody tr').count();
      await expect(hits > 0 && hits < rows, 'search narrows the CASP table (' + rows + ' -> ' + hits + ')');
      const sharedUrl = page.url();
      await expect(new URL(sharedUrl).searchParams.get('q') === 'Bitpanda', 'search is reflected in a shareable URL');
      await page.goto(sharedUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      await page.waitForTimeout(250);
      await expect(await page.inputValue('#rvSearch') === 'Bitpanda', 'shareable URL restores the search');
      await expect(await page.locator('#registerRoot tbody tr').count() > 0, 'shareable URL restores matching rows');
      await expect(await page.locator('#rvCsv').count() > 0, 'CSV button present');
    }
  },
  {
    page: 'casp-tracker.html',
    name: 'casp-tracker.html (mobile)',
    viewport: { width: 390, height: 844 },
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const layout = await page.evaluate(function () {
        const root = document.documentElement;
        const search = document.querySelector('#rvSearch');
        const controls = document.querySelector('.rv-controls');
        const summary = document.querySelector('#rvSummary');
        const count = document.querySelector('#rvCount');
        const boxes = [search, document.querySelector('#rvCountry'), document.querySelector('#rvService')]
          .filter(Boolean).map(function (el) { return el.getBoundingClientRect(); });
        const overlaps = boxes.some(function (a, i) {
          return boxes.slice(i + 1).some(function (b) {
            return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          });
        });
        return {
          overflow: root.scrollWidth > root.clientWidth + 1,
          searchBeforeSummary: controls && summary && controls.getBoundingClientRect().top < summary.getBoundingClientRect().top,
          summaryAfterSearch: search && summary && search.getBoundingClientRect().bottom <= summary.getBoundingClientRect().top,
          countAfterSummary: summary && count && summary.getBoundingClientRect().bottom <= count.getBoundingClientRect().top,
          controlsOverlap: overlaps
        };
      });
      await expect(!layout.overflow, 'no horizontal overflow at 390px');
      await expect(layout.searchBeforeSummary, 'search and filters appear before statistics on mobile');
      await expect(layout.summaryAfterSearch, 'search field does not collide with summary cards');
      await expect(layout.countAfterSummary, 'register count follows the summary cards');
      await expect(!layout.controlsOverlap, 'search and filters do not overlap');

      // Basic keyboard/focus contract: the primary search control is reachable
      // and has a visible focus indicator rather than silently disappearing.
      await page.locator('#rvSearch').focus();
      const focus = await page.evaluate(function () {
        const el = document.activeElement;
        if (!el) return { id: '', visible: false, named: false };
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          id: el.id,
          visible: rect.width > 0 && rect.height > 0,
          named: Boolean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim()),
          focusStyle: style.outlineStyle !== 'none' || style.boxShadow !== 'none'
        };
      });
      await expect(focus.id === 'rvSearch' && focus.visible && focus.named, 'search is keyboard reachable and named');
      await expect(focus.focusStyle, 'keyboard focus is visibly indicated');
      await assertAccessibilityBasics(page, expect);
    }
  },
  {
    page: 'emt-tracker.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 5, 'EMT table renders rows (got ' + rows + ')');
      const flags = await page.locator('#registerRoot tbody td[data-label="Country"] span[aria-hidden="true"]').count();
      await expect(flags > 0, 'EMT country flags render (got ' + flags + ')');
      const flagFont = await page.evaluate(async function () {
        await document.fonts.ready;
        return document.fonts.check('16px "Twemoji Country Flags"');
      });
      await expect(flagFont, 'shared country flag font loads');
    }
  },
  {
    page: 'non-compliant-casps.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 50, 'non-compliant table renders rows (got ' + rows + ')');
      const flags = await page.locator('#registerRoot tbody td[data-label="Country"] span[aria-hidden="true"]').count();
      await expect(flags > 0, 'non-compliant country flags render (got ' + flags + ')');
      const flagFont = await page.evaluate(async function () {
        await document.fonts.ready;
        return document.fonts.check('16px "Twemoji Country Flags"');
      });
      await expect(flagFont, 'shared country flag font loads');
      // Hard security invariant: these websites are never clickable.
      const links = await page.locator('#registerRoot tbody a').count();
      await expect(links === 0, 'non-compliant rows contain no links (got ' + links + ')');
    }
  },
  {
    page: 'data-quality.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#dqSearch', { timeout: 15000 });
      const cards = await page.locator('.dq-card').count();
      await expect(cards === 5, 'five summary cards render (got ' + cards + ')');
      const sections = await page.locator('.dq-section').count();
      await expect(sections === 5, 'five grouped sections render (got ' + sections + ')');
      const rows = await page.locator('.dq-table tbody tr').count();
      await expect(rows > 0, 'findings render (got ' + rows + ')');
      // The uncategorised bucket means the page has drifted behind the
      // pipeline. It must stay hidden while every emitted type is mapped.
      const unknown = await page.locator('#dq-uncategorised').count();
      await expect(unknown === 0, 'no "Not yet categorised" section while all types are mapped');
      // Anomaly values failed validation; they must never become links.
      const links = await page.locator('.dq-value a').count();
      await expect(links === 0, 'anomaly values are never rendered as links');
      await page.fill('#dqSearch', 'zzzznomatch');
      await page.waitForTimeout(300);
      const empty = await page.locator('.dq-table tbody tr').count();
      await expect(empty === 5, 'a no-match search shows one empty state per section (got ' + empty + ')');
    }
  },
  {
    page: 'entities/flowdesk-europe-sas.html',
    assert: async function (page, expect) {
      await expect(await page.locator('#entity-name').textContent() === 'FLOWDESK EUROPE SAS', 'entity page renders the legal name');
      await expect(await page.locator('.entity-status').count() === 1, 'authorisation status is present');
      await expect(await page.locator('.entity-note').count() === 1, 'entity-specific data note renders');
      await expect(await page.locator('.entity-context-row').count() >= 4, 'context rows render');
      await expect(await page.locator('a[href*="casp-tracker.html?country=France"]').count() > 0, 'context links to the filtered CASP tracker');
      await expect(await page.locator('a[href^="mailto:"]').count() === 2, 'verification and correction routes are actionable');
      await expect(await page.locator('[data-copy="984500AB011S3AEF6706"]').count() === 1, 'LEI is shown with a copy action');
    }
  },
  {
    page: 'entities/bitpanda-gmbh.html',
    assert: async function (page, expect) {
      const logo = page.locator('.entity-logo-image');
      await expect(await logo.count() === 1, 'Bitpanda logo renders');
      await expect(await logo.evaluate(function (image) {
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }), 'Bitpanda logo asset loads');
    }
  },
  { page: 'about.html', assert: async function (page, expect) {
      await expect(await page.locator('main').count() > 0, 'about page renders');
    } }
];

(async function () {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (error) {
    console.error('playwright is not installed. Run: npm ci');
    process.exit(1);
  }

  const server = serve();
  await new Promise(function (resolve) { server.listen(PORT, resolve); });

  const browser = await chromium.launch(launchOptions());
  let failed = 0;
  let passed = 0;

  for (const check of CHECKS) {
    const page = await browser.newPage(check.viewport ? { viewport: check.viewport } : {});
    const problems = [];
    page.on('pageerror', function (e) { problems.push('uncaught: ' + e.message); });
    page.on('response', function (response) {
      if (response.status() >= 400 && isOurProblem(response.url())) {
        problems.push('HTTP ' + response.status() + ': ' + response.url());
      }
    });
    page.on('console', function (m) {
      if (m.type() === 'error' && isOurProblem(m.text())) problems.push('console: ' + m.text());
    });

    console.log('\n' + (check.name || check.page));
    async function expect(condition, label) {
      if (condition) { console.log('  ok   ' + label); passed += 1; }
      else { console.log('  FAIL ' + label); failed += 1; }
    }

    try {
      const res = await page.goto('http://127.0.0.1:' + PORT + '/' + check.page, { waitUntil: 'load', timeout: 30000 });
      await expect(res && res.status() === 200, 'responds 200');
      await check.assert(page, expect);
    } catch (error) {
      console.log('  FAIL threw: ' + (error && error.message));
      failed += 1;
    }

    if (problems.length) {
      problems.forEach(function (p) { console.log('  FAIL ' + p); });
      failed += problems.length;
    } else {
      console.log('  ok   no console errors');
      passed += 1;
    }
    await page.close();
  }

  await browser.close();
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
