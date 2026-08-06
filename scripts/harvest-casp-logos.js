#!/usr/bin/env node
/*
 * Best-effort CASP logo enrichment.
 *
 * The ESMA register gives us official website URLs, not logo URLs. This
 * script discovers a provider's public brand image from that first-party
 * website, stores it locally, and records the source beside the entity logo
 * manifest. It is deliberately a separate, manually-invoked step: a blocked
 * or changed website must never prevent the regulatory data pipeline from
 * publishing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ASSET_DIR = path.join(ROOT, 'assets', 'casp-logos');
const MANIFEST_FILE = path.join(DATA_DIR, 'casp-logos.json');
const REPORT_FILE = path.join(DATA_DIR, 'casp-logo-report.json');

const REQUEST_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 5;
const USER_AGENT = 'MiCAR-Tracker-logo-enrichment/1.0 (+https://micatracker.digital-euro-association.de)';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (_) { return fallback; }
}

function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function canonicalDomain(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return hostname;
  } catch (_) {
    return '';
  }
}

function displayDomain(domain) {
  return domain.replace(/^www\./, '');
}

function fileBase(domain) {
  return domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
}

function assetExtension(contentType, url) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (mime === 'image/svg+xml' || /\.svg(?:$|[?#])/i.test(url)) return 'svg';
  if (mime === 'image/png' || /\.png(?:$|[?#])/i.test(url)) return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg' || /\.(?:jpe?g)(?:$|[?#])/i.test(url)) return 'jpg';
  if (mime === 'image/webp' || /\.webp(?:$|[?#])/i.test(url)) return 'webp';
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon' || /\.ico(?:$|[?#])/i.test(url)) return 'ico';
  if (mime === 'image/gif' || /\.gif(?:$|[?#])/i.test(url)) return 'gif';
  return '';
}

function isSafeSvg(buffer) {
  const text = buffer.toString('utf8', 0, Math.min(buffer.length, 500000));
  return !/<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']https?:/i.test(text);
}

function attr(tag, name) {
  const pattern = new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])(.*?)\\1', 'i');
  const match = tag.match(pattern);
  return match ? match[2].trim() : '';
}

function absoluteUrl(value, base) {
  const raw = String(value || '').trim();
  if (!raw || /^data:|^javascript:|^mailto:|^#|^blob:/i.test(raw)) return '';
  try { return new URL(raw, base).toString(); } catch (_) { return ''; }
}

function firstSrcset(value) {
  return String(value || '').split(',')[0].trim().split(/\s+/)[0] || '';
}

function candidateKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch (_) { return url; }
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(function (token) {
      return token.length > 2 && !/^(gmbh|ag|sa|sarl|sas|spa|bv|nv|as|oy|ab|ltd|limited|llc|inc|plc|company|co|europe|eu|services|service|for|the)$/.test(token);
    }));
}

function tokenOverlap(a, b) {
  let score = 0;
  a.forEach(function (token) { if (b.has(token)) score += 1; });
  return score;
}

function extractCandidates(html, pageUrl, entities, domain) {
  const candidates = [];
  const seen = new Set();
  const entityTokens = new Set();
  entities.forEach(function (entity) {
    tokens(entity.name).forEach(function (token) { entityTokens.add(token); });
  });
  const domainTokens = tokens(displayDomain(domain).split('.')[0]);

  function add(rawUrl, kind, score, signal) {
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return;
    const key = candidateKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    const urlTokens = tokens(url);
    const signalTokens = tokens(signal);
    const overlap = tokenOverlap(entityTokens, new Set([...urlTokens, ...signalTokens]));
    const domainOverlap = tokenOverlap(domainTokens, new Set([...urlTokens, ...signalTokens]));
    candidates.push({ url, kind, score: score + overlap * 7 + domainOverlap * 3, signal: String(signal || '').trim() });
  }

  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  linkTags.forEach(function (tag) {
    const rel = attr(tag, 'rel').toLowerCase();
    const href = attr(tag, 'href');
    if (!href || /manifest|alternate|canonical|stylesheet|preload/.test(rel)) return;
    if (/icon|apple-touch|mask-icon|logo/.test(rel)) {
      const score = /apple-touch/.test(rel) ? 90 : /mask-icon/.test(rel) ? 86 : 82;
      add(href, 'link-' + (rel.split(/\s+/)[0] || 'icon'), score, rel);
    }
  });

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  metaTags.forEach(function (tag) {
    const property = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (!/^(og:image|twitter:image|twitter:image:src)$/.test(property)) return;
    add(attr(tag, 'content'), property, 48, property);
  });

  const imageTags = html.match(/<img\b[^>]*>/gi) || [];
  imageTags.forEach(function (tag) {
    const signal = [attr(tag, 'alt'), attr(tag, 'class'), attr(tag, 'id'), attr(tag, 'title'), attr(tag, 'aria-label')].join(' ');
    const src = attr(tag, 'src') || attr(tag, 'data-src') || firstSrcset(attr(tag, 'srcset')) || firstSrcset(attr(tag, 'data-srcset'));
    if (!src) return;
    const signalTokens = tokens(signal);
    const markedLogo = /\b(logo|wordmark|brand|site[-_ ]?mark|header[-_ ]?mark)\b/i.test(signal);
    const likelyBrand = tokenOverlap(entityTokens, signalTokens) > 0 || tokenOverlap(domainTokens, signalTokens) > 0;
    if (!markedLogo && !likelyBrand) return;
    add(src, markedLogo ? 'img-logo' : 'img-brand', markedLogo ? 94 : 76, signal);
  });

  [
    '/favicon.svg', '/favicon.ico', '/favicon.png', '/apple-touch-icon.png',
    '/logo.svg', '/logo.png', '/assets/logo.svg', '/assets/logo.png',
    '/images/logo.svg', '/images/logo.png'
  ].forEach(function (suffix) { add(new URL(suffix, pageUrl).toString(), 'common-path', 35, suffix); });

  return candidates.sort(function (a, b) { return b.score - a.score; });
}

async function fetchBytes(url, accept, maxBytes) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: accept }
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('response exceeds size limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('response exceeds size limit');
  return { buffer, response, finalUrl: response.url || url };
}

async function fetchPage(url) {
  const result = await fetchBytes(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', MAX_HTML_BYTES);
  return { html: result.buffer.toString('utf8'), finalUrl: result.finalUrl, response: result.response };
}

async function fetchImage(candidate) {
  const result = await fetchBytes(candidate.url, 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8,*/*;q=0.1', MAX_IMAGE_BYTES);
  const type = result.response.headers.get('content-type') || '';
  const extension = assetExtension(type, result.finalUrl);
  if (!extension) throw new Error('not an image response (' + type + ')');
  if (extension === 'svg' && !isSafeSvg(result.buffer)) throw new Error('SVG contains active or external content');
  if (result.buffer.length < 50) throw new Error('image response is too small');
  return { buffer: result.buffer, extension, finalUrl: result.finalUrl, contentType: type };
}

async function discoverForDomain(domain, entities) {
  const pageUrl = safeHttpUrl(entities[0].websites && entities[0].websites[0]);
  if (!pageUrl) return { status: 'missing', domain, reason: 'no valid official website' };

  let page;
  try {
    page = await fetchPage(pageUrl);
  } catch (error) {
    page = { html: '', finalUrl: pageUrl, error: error.message };
  }

  const candidates = extractCandidates(page.html || '', page.finalUrl || pageUrl, entities, domain);
  const failures = [];
  for (const candidate of candidates.slice(0, 14)) {
    try {
      const image = await fetchImage(candidate);
      const digest = crypto.createHash('sha1').update(image.buffer).digest('hex').slice(0, 12);
      const filename = fileBase(domain) + '-' + digest + '.' + image.extension;
      const absolutePath = path.join(ASSET_DIR, filename);
      if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, image.buffer);
      return {
        status: 'found',
        domain,
        source: pageUrl,
        sourceUrl: image.finalUrl,
        method: candidate.kind,
        signal: candidate.signal,
        score: candidate.score,
        asset: '../assets/casp-logos/' + filename,
        extension: image.extension,
        bytes: image.buffer.length,
        pageError: page && page.error ? page.error : ''
      };
    } catch (error) {
      failures.push(candidate.kind + ': ' + error.message);
    }
  }
  return {
    status: 'missing',
    domain,
    source: pageUrl,
    reason: page && page.error ? 'website fetch failed: ' + page.error : 'no usable logo image discovered',
    tried: candidates.slice(0, 14).map(function (candidate) { return candidate.url; }),
    failures
  };
}

function logoAlt(entity, result) {
  const domain = displayDomain(result.domain);
  return entity.name + ' logo from ' + domain;
}

function existingDomainLogos(entities, manifest) {
  const byDomain = new Map();
  entities.forEach(function (entity) {
    if (!manifest[entity.slug]) return;
    (entity.websites || []).forEach(function (website) {
      const domain = canonicalDomain(website);
      if (domain) {
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(entity.slug);
      }
    });
  });
  return byDomain;
}

async function run() {
  const entitiesFile = readJson('entities.json', { entities: [] });
  const entities = Array.isArray(entitiesFile.entities) ? entitiesFile.entities : [];
  if (!entities.length) throw new Error('No entities found in data/entities.json');

  const manifest = readJson('casp-logos.json', {});
  const report = [];
  const groups = new Map();
  entities.forEach(function (entity) {
    const website = (entity.websites || []).map(safeHttpUrl).find(Boolean);
    const domain = canonicalDomain(website);
    if (!domain) {
      report.push({ slug: entity.slug, name: entity.name, status: 'missing', reason: 'no valid official website' });
      return;
    }
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(entity);
  });

  const refresh = process.argv.includes('--refresh');
  const limitArg = process.argv.find(function (arg) { return arg.indexOf('--limit=') === 0; });
  const limit = limitArg ? Math.max(0, Number(limitArg.split('=')[1]) || 0) : 0;
  const concurrencyArg = process.argv.find(function (arg) { return arg.indexOf('--concurrency=') === 0; });
  const concurrency = concurrencyArg ? Math.max(1, Number(concurrencyArg.split('=')[1]) || DEFAULT_CONCURRENCY) : DEFAULT_CONCURRENCY;
  const existingByDomain = existingDomainLogos(entities, manifest);
  const domains = [...groups.keys()].filter(function (domain) {
    return refresh || !existingByDomain.has(domain);
  }).slice(0, limit || undefined);

  fs.mkdirSync(ASSET_DIR, { recursive: true });
  console.log('Discovering logos for ' + domains.length + ' website domains (' + groups.size + ' total)...');
  let completed = 0;
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= domains.length) return;
      const domain = domains[index];
      const result = await discoverForDomain(domain, groups.get(domain));
      results.set(domain, result);
      completed += 1;
      console.log('[' + completed + '/' + domains.length + '] ' + domain + ' - ' + result.status + (result.method ? ' (' + result.method + ')' : ''));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(domains.length, 1)) }, worker));

  results.forEach(function (result, domain) {
    const domainEntities = groups.get(domain) || [];
    const existingSlugs = existingByDomain.get(domain) || [];
    if (existingSlugs.length && !refresh) {
      domainEntities.forEach(function (entity) {
        if (!manifest[entity.slug]) report.push({ slug: entity.slug, name: entity.name, domain, status: 'review', reason: 'shared website already has a curated logo entry' });
      });
      return;
    }
    domainEntities.forEach(function (entity) {
      if (result.status === 'found') {
        if (!manifest[entity.slug] || refresh) {
          manifest[entity.slug] = {
            src: result.asset,
            alt: logoAlt(entity, result),
            source: result.source,
            sourceUrl: result.sourceUrl,
            method: result.method,
            retrievedAt: new Date().toISOString().slice(0, 10),
            confidence: result.method === 'img-logo' ? 'high' : 'medium'
          };
        }
        report.push({ slug: entity.slug, name: entity.name, domain, status: 'found', sourceUrl: result.sourceUrl, method: result.method, asset: result.asset });
      } else {
        report.push({ slug: entity.slug, name: entity.name, domain, status: 'missing', reason: result.reason, tried: result.tried || [] });
      }
    });
  });

  groups.forEach(function (domainEntities, domain) {
    if (domains.includes(domain)) return;
    domainEntities.forEach(function (entity) {
      if (manifest[entity.slug]) {
        if (!report.some(function (entry) { return entry.slug === entity.slug; })) {
          report.push({ slug: entity.slug, domain, status: 'existing', asset: manifest[entity.slug].src });
        }
      } else if (!report.some(function (entry) { return entry.slug === entity.slug; })) {
        report.push({
          slug: entity.slug,
          name: entity.name,
          domain,
          status: 'review',
          reason: 'shared website already has a curated logo entry; confirm whether this legal entity uses the same brand'
        });
      }
    });
  });

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), entities: entities.length, domains: groups.size, results: report }, null, 2) + '\n');
  const found = report.filter(function (entry) { return entry.status === 'found'; }).length;
  const missing = report.filter(function (entry) { return entry.status === 'missing'; }).length;
  const review = report.filter(function (entry) { return entry.status === 'review'; }).length;
  console.log('\nLogo enrichment complete: ' + found + ' found, ' + missing + ' missing, ' + review + ' require review.');
  console.log('Manifest: ' + path.relative(ROOT, MANIFEST_FILE));
  console.log('Report:   ' + path.relative(ROOT, REPORT_FILE));
}

run().catch(function (error) {
  console.error('Logo enrichment failed: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
