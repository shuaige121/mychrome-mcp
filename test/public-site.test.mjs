/** Verify the actual public site artifacts and links, without a network or browser session. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const base = new URL('https://shuaige121.github.io/mychrome-mcp/');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const socialImage = new URL(`assets/social-card.png?v=${version}`, base).href;
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
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]'])
    check(document.querySelector(selector)?.content?.trim(), `${name}: ${selector}`);
  check(document.querySelector('meta[name="twitter:card"]')?.content === 'summary_large_image', `${name}: image sharing card`);
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]'])
    check(document.querySelector(selector)?.content === socialImage, `${name}: ${selector} uses the current release image`);
  for (const selector of ['meta[property="og:image:alt"]', 'meta[name="twitter:image:alt"]'])
    check(document.querySelector(selector)?.content?.trim(), `${name}: sharing image description`);
  check(!/mychrome-workspace|mychrome-practice|examples\/first-task|weekend plan|周末计划/i.test(html), `${name}: retired practice content is not presented as the product experience`);
  const canonical = new URL(document.querySelector('link[rel="canonical"]')?.href);
  const expected = new URL(name === 'index.html' ? './' : name === 'zh/index.html' ? 'zh/' : name, base);
  check(canonical.href === expected.href, `${name}: canonical is the deployed page URL`);
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  check(new Set(ids).size === ids.length, `${name}: unique anchors`);
  for (const image of document.querySelectorAll('img')) check(image.hasAttribute('alt'), `${name}: image has alt text`);
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(script.textContent);
    check(data && typeof data === 'object', `${name}: parseable structured data`);
    if (data['@type'] === 'SoftwareApplication')
      check(data.softwareVersion === version, `${name}: structured data has the current release version`);
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
for (const name of ['index.html', 'zh/index.html']) {
  const document = documents.get(name);
  check(document.querySelector('.hero a[href="getting-started.html"]'), `${name}: primary action starts setup for the current Chrome`);
  check(document.querySelector('.hero a[href="#film"]'), `${name}: hero links to the product film`);
  check(document.querySelector('.handoff-story ol')?.children.length === 4, `${name}: same-page handoff and explicit continuation are explained`);
  check(document.querySelector('#your-pace a[href="getting-started.html#personal-rhythm"]'), `${name}: personal input rhythm has a setup destination`);
  check(document.querySelectorAll('#demo .task-row').length === 3, `${name}: task requests are presented as examples`);
  check(!document.querySelector('[data-demo], .demo-figure, .hero-figure'), `${name}: no retired simulated task demo or onboarding screenshot`);
  const film = document.querySelector('#film video');
  check(film?.hasAttribute('controls') && film.hasAttribute('playsinline'), `${name}: film has native controls and inline playback`);
  check(film.getAttribute('preload') === 'none' && !film.hasAttribute('autoplay') && !film.hasAttribute('loop'), `${name}: film only plays on request`);
  check(film.getAttribute('poster')?.includes('mychrome-overview-poster.webp'), `${name}: film has a static poster`);
  check(film.querySelector('source[type="video/mp4"]')?.getAttribute('src')?.includes('mychrome-overview.mp4'), `${name}: film has MP4 media`);
  const subtitles = film.querySelector('track[kind="subtitles"][srclang="en"]');
  check(subtitles?.getAttribute('src')?.includes('mychrome-overview.en.vtt'), `${name}: English subtitles are available`);
  check(subtitles.hasAttribute('default') === (name === 'index.html'), `${name}: English subtitles are default on the English page`);
  check(document.querySelector('#film a[href*="mychrome-overview.mp4"]') && document.querySelector('#film a[href*="mychrome-overview.gif"]'), `${name}: direct MP4 and GIF links`);
  check(document.getElementById(film.getAttribute('aria-describedby'))?.textContent?.includes('38'), `${name}: film has a visible duration and disclosure`);
  check(Boolean(document.querySelector('.hero').compareDocumentPosition(document.getElementById('film')) & 4) && Boolean(document.getElementById('film').compareDocumentPosition(document.getElementById('demo')) & 4), `${name}: film follows the hero and precedes task examples`);
}
const subtitleText = await fs.readFile(path.join(site, 'assets/mychrome-overview.en.vtt'), 'utf8');
check(/^WEBVTT(?:\r?\n)/.test(subtitleText) && subtitleText.includes(' --> '), 'Film subtitles contain WebVTT cues');
const socialBytes = await fs.readFile(path.join(site, 'assets/social-card.png'));
check(socialBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && socialBytes.readUInt32BE(16) === 1200 && socialBytes.readUInt32BE(20) === 630, 'Social card matches its 1200 by 630 PNG metadata');
for (const name of ['getting-started.html', 'zh/getting-started.html']) {
  const document = documents.get(name);
  check(document.querySelector('#start-your-task + p'), `${name}: setup ends with the user's actual page and task`);
  check(document.querySelector('#personal-rhythm + p'), `${name}: optional personal rhythm controls are documented`);
  check(document.querySelector('.toc a[href="#start-your-task"]'), `${name}: task continuation is directly navigable`);
}
const llms = await fs.readFile(path.join(site, 'llms.txt'), 'utf8');
check(!/local practice task|examples\/first-task/.test(llms), 'Machine-readable entry uses the actual task onboarding');
check(llms.includes('personal input habit sampling is experimental'), 'Machine-readable entry preserves the personal rhythm feature boundary');
for (const name of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'llms.txt'])
  check((await fs.readFile(path.join(root, name), 'utf8')).trim().length > 50, `Public entry document exists: ${name}`);
console.log(`public-site: ${checks} artifact checks passed across ${pages.length} pages`);
