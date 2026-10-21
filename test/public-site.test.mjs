/** Verify the actual public site artifacts and links, without a network or browser session. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const base = new URL('https://shuaige121.github.io/mychrome-mcp/');
const pages = ['index.html', 'getting-started.html', 'faq.html', 'zh/index.html', 'zh/getting-started.html', 'zh/faq.html'];
const documents = new Map();
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }

for (const name of pages) {
  const html = await fs.readFile(path.join(site, name), 'utf8');
  const document = new JSDOM(html).window.document;
  documents.set(name, document);
  check(document.querySelectorAll('h1').length === 1, `${name}: one visible primary heading`);
  check(document.title.includes('MyChrome'), `${name}: descriptive product title`);
  check(document.documentElement.lang?.length >= 2, `${name}: document language`);
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:image"]'])
    check(document.querySelector(selector)?.content?.trim(), `${name}: ${selector}`);
  const canonical = new URL(document.querySelector('link[rel="canonical"]')?.href);
  const expected = new URL(name === 'index.html' ? './' : name === 'zh/index.html' ? 'zh/' : name, base);
  check(canonical.href === expected.href, `${name}: canonical is the deployed page URL`);
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  check(new Set(ids).size === ids.length, `${name}: unique anchors`);
  for (const image of document.querySelectorAll('img')) check(image.hasAttribute('alt'), `${name}: image has alt text`);
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(script.textContent);
    check(data && typeof data === 'object', `${name}: parseable structured data`);
  }
}

for (const [name, document] of documents) {
  const source = new URL(name, base);
  const refs = [...document.querySelectorAll('[href], [src], [poster]')].flatMap(node =>
    ['href', 'src', 'poster'].map(attr => node.getAttribute(attr)).filter(Boolean));
  for (const ref of refs) {
    if (/^(?:mailto:|tel:|data:|javascript:)/i.test(ref)) {
      check(!/^javascript:/i.test(ref), `${name}: no javascript links`); continue;
    }
    const url = new URL(ref, source);
    if (url.origin !== base.origin) continue;
    check(url.pathname.startsWith(base.pathname), `${name}: internal URL stays under project site (${ref})`);
    let relative = decodeURIComponent(url.pathname.slice(base.pathname.length));
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const target = path.resolve(site, relative);
    check(target.startsWith(site + path.sep), `${name}: local link stays inside site`);
    check((await fs.stat(target)).isFile(), `${name}: linked artifact exists (${ref})`);
    if (url.hash && documents.has(relative))
      check(documents.get(relative).getElementById(decodeURIComponent(url.hash.slice(1))), `${name}: destination anchor exists (${ref})`);
  }
}

const sitemapText = await fs.readFile(path.join(site, 'sitemap.xml'), 'utf8');
const sitemap = new JSDOM(sitemapText, { contentType: 'application/xml' }).window.document;
const locations = new Set([...sitemap.querySelectorAll('loc')].map(e => e.textContent.trim()));
for (const document of documents.values()) check(locations.has(document.querySelector('link[rel="canonical"]').href), 'Sitemap includes every public page');
const robots = await fs.readFile(path.join(site, 'robots.txt'), 'utf8');
check(robots.includes(new URL('sitemap.xml', base).href), 'Robots links the actual sitemap');
check(!/^Disallow:\s*\/\s*$/im.test(robots), 'Public site is not accidentally blocked');
check((await fs.stat(path.join(site, '.nojekyll'))).isFile(), 'Static deployment bypasses Jekyll');
for (const filename of ['mychrome-workspace.webp', 'mychrome-practice-poster.webp', 'mychrome-practice.gif', 'social-card.png']) {
  const stat = await fs.stat(path.join(site, 'assets', filename));
  check(stat.size > 100 && stat.size <= (filename.endsWith('.gif') ? 12 : 4) * 1024 * 1024, `Public media size: ${filename}`);
}
for (const name of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'llms.txt'])
  check((await fs.readFile(path.join(root, name), 'utf8')).trim().length > 50, `Public entry document exists: ${name}`);
console.log(`public-site: ${checks} artifact checks passed across ${pages.length} pages`);
