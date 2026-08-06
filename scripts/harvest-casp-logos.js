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
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 5;
const MAX_CANDIDATES = 40;
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
  if (mime === 'image/avif' || /\.avif(?:$|[?#])/i.test(url)) return 'avif';
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
  const raw = String(value || '').trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#x26;/gi, '&')
    .replace(/&#x2f;/gi, '/');
  if (!raw || /^javascript:|^mailto:|^#|^blob:/i.test(raw)) return '';
  if (/^data:image\/(?:png|jpe?g|webp|avif|gif|x-icon|svg\+xml);/i.test(raw)) return raw;
  if (/^data:/i.test(raw)) return '';
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

function isTokenAsset(value) {
  const text = String(value || '');
  const token = '(?:bitcoin|ethereum|litecoin|dogecoin|ripple|xrp|tether|solana|cardano|polkadot|avalanche|chainlink|tron|stellar|monero|uniswap|polygon|cosmos|near|dai|usdc|usdt|bnb|shib)';
  return new RegExp('\\b' + token + '(?:[-_][a-z0-9]+)*[-_]logo\\b', 'i').test(text)
    || new RegExp('\\b' + token + '\\b', 'i').test(text) && /wp-content|carousel|gallery|token|coin|currency|uploads/i.test(text);
}

function isTokenBrand(value) {
  return /\b(?:bitcoin|ethereum|litecoin|dogecoin|ripple|xrp|tether|solana|cardano|polkadot|avalanche|chainlink|tron|stellar|monero|uniswap|polygon|cosmos|near|dai|usdc|usdt|bnb|shib)\b/i.test(String(value || ''));
}

function isNonBrandAsset(value) {
  return isTokenAsset(value) || /cookie-law-info|cookieyes|consent|revisit\.svg|jugendgo|startseite-vrnw|veranstaltung_vr|:3-2|co-branded|banner/i.test(String(value || ''));
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
    if (isNonBrandAsset(rawUrl) || isNonBrandAsset(signal)) return;
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
    const src = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || firstSrcset(attr(tag, 'srcset')) || firstSrcset(attr(tag, 'data-srcset'));
    const alt = attr(tag, 'alt');
    const signal = [src, alt, attr(tag, 'class'), attr(tag, 'id'), attr(tag, 'title'), attr(tag, 'aria-label')].join(' ');
    if (!src) return;
    // Coin illustrations and partner-gallery assets are often labelled
    // "logo" but are not the provider's own mark.
    if (isNonBrandAsset(src + ' ' + signal)) return;
    const signalTokens = tokens(signal);
    const markedLogo = /\b(logo|wordmark|brand|site[-_ ]?mark|header[-_ ]?mark)\b/i.test(signal);
    const likelyBrand = tokenOverlap(entityTokens, signalTokens) > 0 || tokenOverlap(domainTokens, signalTokens) > 0;
    if (!markedLogo && !likelyBrand) return;
    const altTokens = tokens(alt);
    ['logo', 'brand', 'wordmark', 'partner', 'sponsor', 'footer', 'gallery'].forEach(function (token) { altTokens.delete(token); });
    if (markedLogo && /\b(partner|sponsor|footer|gallery)\b/i.test(alt)) return;
    if (markedLogo && (alt.length > 180 || /\b(?:text|bild|header|banner|teaser|startseite)\s*:/i.test(alt))) return;
    if (markedLogo && altTokens.size && tokenOverlap(entityTokens, altTokens) === 0 && tokenOverlap(domainTokens, altTokens) === 0) return;
    add(src, markedLogo ? 'img-logo' : 'img-brand', markedLogo ? 94 : 76, signal);
  });

  // Some banking platforms put the actual brand image in an inline JSON
  // configuration object (for example, a bankLogo or urlFarbeAbsolute field)
  // instead of an <img> tag. Match those fields explicitly: a generic
  // "logo" substring also occurs in partner/footer galleries and can select
  // an unrelated third-party mark.
  const brandedFieldPattern = /["'](?:bankLogo|urlFarbeAbsolute)["']\s*:\s*["']([^"']+)["']/gi;
  let brandedFieldMatch;
  while ((brandedFieldMatch = brandedFieldPattern.exec(html))) {
    add(brandedFieldMatch[1], 'embedded-logo-config', 103, 'embedded first-party logo configuration');
  }

  // A few sites render the wordmark as a self-contained inline SVG. Restrict
  // extraction to SVGs in an explicit logo context; generic UI icons are not
  // useful provider logos.
  const inlineSvgs = html.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi) || [];
  inlineSvgs.forEach(function (svg) {
    const index = html.indexOf(svg);
    const context = html.slice(Math.max(0, index - 500), index);
    if (!/w-logo|data-framer-name\s*=\s*["'][^"']*logo|aria-label\s*=\s*["'][^"']*logo|wordmark/i.test(context)) return;
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    add(dataUrl, 'inline-svg-logo', 100, 'inline SVG logo');
  });

  // Many modern sites expose their primary mark only in JSON-LD rather than
  // an <img> tag. Keep this first-party signal narrowly scoped to logo fields
  // so hero/product images are not mistaken for a company logo.
  const jsonLdTags = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  function collectLogos(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(collectLogos);
    if (value.logo) {
      const logo = typeof value.logo === 'string' ? value.logo : value.logo.url || value.logo.contentUrl;
      if (logo) add(logo, 'jsonld-logo', 99, 'json-ld logo');
    }
    Object.keys(value).forEach(function (key) {
      if (key !== 'logo' && value[key] && typeof value[key] === 'object') collectLogos(value[key]);
    });
  }
  jsonLdTags.forEach(function (tag) {
    const raw = tag.replace(/^.*?>/s, '').replace(/<\/script>\s*$/i, '').trim();
    try { collectLogos(JSON.parse(raw)); } catch (_) { /* malformed JSON-LD is ignored */ }
  });

  // CSS background images are common for header marks on bank sites. Only
  // consider URLs near a logo/brand signal or whose own path looks branded.
  const cssUrlPattern = /(?:logo|wordmark|brand|site[-_ ]?mark|header[-_ ]?logo)[^{}]{0,300}?url\(\s*["']?([^\s"')]+)["']?\s*\)/gi;
  let cssMatch;
  while ((cssMatch = cssUrlPattern.exec(html))) add(cssMatch[1], 'css-logo', 86, 'logo/brand CSS background');

  [
    '/favicon.svg', '/favicon.ico', '/favicon.png', '/favicon.webp', '/apple-touch-icon.png',
    '/logo.svg', '/logo.png', '/logo.webp', '/logo.jpg', '/assets/logo.svg', '/assets/logo.png', '/assets/logo.webp',
    '/images/logo.svg', '/images/logo.png', '/images/logo.webp', '/images/logo.jpg'
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

async function fetchManifestIcons(html, pageUrl) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  const manifestUrls = links.map(function (tag) {
    const rel = attr(tag, 'rel').toLowerCase();
    return /(?:^|\s)manifest(?:\s|$)/.test(rel) ? absoluteUrl(attr(tag, 'href'), pageUrl) : '';
  }).filter(Boolean);
  const icons = [];
  for (const manifestUrl of manifestUrls.slice(0, 2)) {
    try {
      const result = await fetchBytes(manifestUrl, 'application/manifest+json,application/json;q=0.9,*/*;q=0.1', 256 * 1024);
      const manifest = JSON.parse(result.buffer.toString('utf8'));
      (Array.isArray(manifest.icons) ? manifest.icons : []).forEach(function (icon) {
        if (icon && icon.src) icons.push({ url: absoluteUrl(icon.src, result.finalUrl || manifestUrl), kind: 'manifest-icon', score: 88, signal: 'web app manifest icon' });
      });
    } catch (_) { /* optional enhancement; continue with page candidates */ }
  }
  return icons.filter(function (icon) { return icon.url; });
}

async function fetchImage(candidate) {
  if (/^data:image\//i.test(candidate.url)) {
    const match = candidate.url.match(/^data:(image\/[^;]+);base64,(.*)$/i);
    if (!match) throw new Error('unsupported data image');
    const buffer = Buffer.from(match[2], 'base64');
    const contentType = match[1];
    const extension = assetExtension(contentType, '');
    if (!extension || buffer.length > MAX_IMAGE_BYTES || buffer.length < 50) throw new Error('invalid data image');
    if (extension === 'svg' && !isSafeSvg(buffer)) throw new Error('SVG contains active or external content');
    return { buffer, extension, finalUrl: candidate.url, contentType };
  }
  const result = await fetchBytes(candidate.url, 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8,*/*;q=0.1', MAX_IMAGE_BYTES);
  const type = result.response.headers.get('content-type') || '';
  const extension = assetExtension(type, result.finalUrl);
  if (!extension) throw new Error('not an image response (' + type + ')');
  if (extension === 'svg' && !isSafeSvg(result.buffer)) throw new Error('SVG contains active or external content');
  if (result.buffer.length < 50) throw new Error('image response is too small');
  return { buffer: result.buffer, extension, finalUrl: result.finalUrl, contentType: type };
}

async function discoverForDomain(domain, entities) {
  const officialUrls = entities.flatMap(function (entity) { return (entity.websites || []).map(safeHttpUrl).filter(Boolean); });
  const firstUrl = officialUrls[0] || '';
  const pageUrl = firstUrl;
  if (!pageUrl) return { status: 'missing', domain, reason: 'no valid official website' };

  const pageUrls = [];
  function addPageUrl(url) {
    if (!url || pageUrls.includes(url)) return;
    pageUrls.push(url);
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!host.startsWith('www-')) {
        for (const prefix of ['https://', 'http://']) {
          const alternate = prefix + host + parsed.pathname;
          if (!pageUrls.includes(alternate)) pageUrls.push(alternate);
          if (!host.startsWith('www.')) {
            const www = prefix + 'www.' + host + parsed.pathname;
            if (!pageUrls.includes(www)) pageUrls.push(www);
          }
        }
      }
    } catch (_) { /* invalid URL already filtered */ }
  }
  officialUrls.forEach(addPageUrl);

  let page = { html: '', finalUrl: pageUrl, error: '' };
  for (const candidatePageUrl of pageUrls) {
    try {
      page = await fetchPage(candidatePageUrl);
      if (page.html) break;
    } catch (error) {
      page = { html: '', finalUrl: candidatePageUrl, error: error.message };
    }
  }

  const candidates = extractCandidates(page.html || '', page.finalUrl || pageUrl, entities, domain);
  const manifestIcons = await fetchManifestIcons(page.html || '', page.finalUrl || pageUrl);
  manifestIcons.forEach(function (icon) {
    if (!candidates.some(function (candidate) { return candidateKey(candidate.url) === candidateKey(icon.url); })) candidates.push(icon);
  });
  candidates.sort(function (a, b) { return b.score - a.score; });
  const failures = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const image = await fetchImage(candidate);
      if (isTokenBrand(image.finalUrl) && canonicalDomain(image.finalUrl) !== domain) {
        throw new Error('redirected to unrelated token asset');
      }
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
    tried: candidates.slice(0, MAX_CANDIDATES).map(function (candidate) { return candidate.url; }),
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
  const retryMissing = process.argv.includes('--retry-missing');
  const retryLowConfidence = process.argv.includes('--retry-low-confidence');
  const previousReport = readJson('casp-logo-report.json', { results: [] });
  const previousBySlug = new Map((previousReport.results || []).map(function (entry) { return [entry.slug, entry]; }));
  const limitArg = process.argv.find(function (arg) { return arg.indexOf('--limit=') === 0; });
  const limit = limitArg ? Math.max(0, Number(limitArg.split('=')[1]) || 0) : 0;
  const concurrencyArg = process.argv.find(function (arg) { return arg.indexOf('--concurrency=') === 0; });
  const concurrency = concurrencyArg ? Math.max(1, Number(concurrencyArg.split('=')[1]) || DEFAULT_CONCURRENCY) : DEFAULT_CONCURRENCY;
  const existingByDomain = existingDomainLogos(entities, manifest);
  const retryDomains = new Set((previousReport.results || [])
    .filter(function (entry) { return entry.status === 'missing' && entry.domain; })
    .map(function (entry) { return entry.domain; }));
  const lowConfidenceSlugs = new Set(Object.entries(manifest)
    .filter(function (entry) {
      const value = entry[1] || {};
      return value.method === 'embedded-logo-config' || isNonBrandAsset(value.sourceUrl || '') || /\/vpb\.webp(?:$|[?#])/i.test(value.sourceUrl || '') || /kriptomat\.hr/i.test(value.source || '');
    })
    .map(function (entry) { return entry[0]; }));
  const lowConfidenceDomains = new Set();
  groups.forEach(function (domainEntities, domain) {
    if (domainEntities.some(function (entity) { return lowConfidenceSlugs.has(entity.slug); })) lowConfidenceDomains.add(domain);
  });
  const domains = [...groups.keys()].filter(function (domain) {
    if (retryLowConfidence) return lowConfidenceDomains.has(domain);
    if (retryMissing) return retryDomains.has(domain) && !existingByDomain.has(domain);
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
    const targetedRefresh = retryLowConfidence && domains.includes(domain);
    if (existingSlugs.length && !refresh && !targetedRefresh) {
      domainEntities.forEach(function (entity) {
        if (!manifest[entity.slug]) report.push({ slug: entity.slug, name: entity.name, domain, status: 'review', reason: 'shared website already has a curated logo entry' });
      });
      return;
    }
    domainEntities.forEach(function (entity) {
      if (result.status === 'found') {
        if (!manifest[entity.slug] || refresh || targetedRefresh) {
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
        if (targetedRefresh && lowConfidenceSlugs.has(entity.slug)) delete manifest[entity.slug];
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
        const previous = previousBySlug.get(entity.slug);
        if (previous && previous.status === 'missing' || (previous && previous.status === 'review' && !existingByDomain.has(domain))) {
          report.push(Object.assign({}, previous, {
            name: entity.name,
            domain,
            status: 'missing',
            reason: /shared website already has a curated logo entry/i.test(previous.reason || '') ? 'no usable logo discovered' : previous.reason
          }));
        } else {
          report.push({
            slug: entity.slug,
            name: entity.name,
            domain,
            status: 'review',
            reason: 'shared website already has a curated logo entry; confirm whether this legal entity uses the same brand'
          });
        }
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
