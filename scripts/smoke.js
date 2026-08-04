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
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
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
    }
  },
  {
    page: 'casp-tracker.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 100, 'CASP table renders rows (got ' + rows + ')');
      await page.fill('#rvSearch', 'Bitpanda');
      await page.waitForTimeout(400);
      const hits = await page.locator('#registerRoot tbody tr').count();
      await expect(hits > 0 && hits < rows, 'search narrows the CASP table (' + rows + ' -> ' + hits + ')');
      await expect(await page.locator('#rvCsv').count() > 0, 'CSV button present');
    }
  },
  {
    page: 'emt-tracker.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 5, 'EMT table renders rows (got ' + rows + ')');
    }
  },
  {
    page: 'non-compliant-casps.html',
    assert: async function (page, expect) {
      await page.waitForSelector('#rvSearch', { timeout: 15000 });
      const rows = await page.locator('#registerRoot tbody tr').count();
      await expect(rows > 50, 'non-compliant table renders rows (got ' + rows + ')');
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
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', function (e) { problems.push('uncaught: ' + e.message); });
    page.on('console', function (m) {
      if (m.type() === 'error' && isOurProblem(m.text())) problems.push('console: ' + m.text());
    });

    console.log('\n' + check.page);
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
