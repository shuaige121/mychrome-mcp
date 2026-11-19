/** Verify the actual public site artifacts and links, without a network or browser session. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const base = new URL('https://shuaige121.github.io/mychrome-mcp/');
// Retained website artifacts have an explicitly reviewed release identity;
// a local package candidate does not authorize rewriting marketing assets.
const { siteArtifactVersion: version } = JSON.parse(await fs.readFile(path.join(root, 'docs/release/release-manifest.json'), 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/, 'release metadata must pin a specific site-artifact version');
const socialImage = new URL(`assets/social-card.png?v=${version}`, base).href;
const pages = ['index.html', 'getting-started.html', 'faq.html', 'zh/index.html', 'zh/getting-started.html', 'zh/faq.html'];
const documents = new Map();
const titles = new Set();
const descriptions = new Set();
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }

for (const name of pages) {
  const html = await fs.readFile(path.join(site, name), 'utf8');
  const document = new JSDOM(html).window.document;
  documents.set(name, document);
  check(document.querySelectorAll('h1').length === 1, `${name}: one visible primary heading`);
  check(document.title.includes('MyChrome'), `${name}: descriptive product title`);
  check(document.title.length <= 60 && !titles.has(document.title), `${name}: unique title within 60 characters`);
  titles.add(document.title);
  const description = document.querySelector('meta[name="description"]')?.content ?? '';
  check(description.length > 0 && description.length <= 155 && !descriptions.has(description), `${name}: unique description within 155 characters`);
  descriptions.add(description);
  check(document.documentElement.lang?.length >= 2, `${name}: document language`);
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]'])
    check(document.querySelector(selector)?.content?.trim(), `${name}: ${selector}`);
  check(document.querySelector('meta[name="twitter:card"]')?.content === 'summary_large_image', `${name}: image sharing card`);
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]'])
    check(document.querySelector(selector)?.content === socialImage, `${name}: ${selector} uses the reviewed site-artifact image`);
  for (const selector of ['meta[property="og:image:alt"]', 'meta[name="twitter:image:alt"]'])
    check(document.querySelector(selector)?.content?.trim(), `${name}: sharing image description`);
  check(!/mychrome-workspace|mychrome-practice|examples\/first-task|weekend plan|周末计划/i.test(html), `${name}: retired practice content is not presented as the product experience`);
  const canonical = new URL(document.querySelector('link[rel="canonical"]')?.href);
  const expected = new URL(name === 'index.html' ? './' : name === 'zh/index.html' ? 'zh/' : name, base);
  check(canonical.href === expected.href, `${name}: canonical is the deployed page URL`);
  check(document.querySelector('meta[property="og:url"]')?.content === expected.href, `${name}: OG URL matches canonical`);
  const englishName = name.replace(/^zh\//, '');
  const expectedAlternates = {
    en: new URL(englishName === 'index.html' ? './' : englishName, base).href,
    'zh-CN': new URL(englishName === 'index.html' ? 'zh/' : `zh/${englishName}`, base).href,
  };
  expectedAlternates['x-default'] = expectedAlternates.en;
  for (const [lang, href] of Object.entries(expectedAlternates)) {
    const alternates = document.querySelectorAll(`link[rel="alternate"][hreflang="${lang}"]`);
    check(alternates.length === 1 && alternates[0].href === href, `${name}: reciprocal ${lang} alternate`);
  }
  for (const prefix of ['og', 'twitter']) {
    const attr = prefix === 'og' ? 'property' : 'name';
    check(document.querySelector(`meta[${attr}="${prefix}:title"]`)?.content === document.title, `${name}: ${prefix} title matches visible page identity`);
    check(document.querySelector(`meta[${attr}="${prefix}:description"]`)?.content === description, `${name}: ${prefix} description matches page metadata`);
  }
  let priorLevel = 0;
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const level = Number(heading.tagName.slice(1));
    check(level <= priorLevel + 1, `${name}: heading order does not skip levels at ${heading.textContent.trim()}`);
    priorLevel = level;
  }
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  check(new Set(ids).size === ids.length, `${name}: unique anchors`);
  for (const image of document.querySelectorAll('img')) {
    check(image.getAttribute('alt')?.trim(), `${name}: image has descriptive alt text`);
    check(Number(image.getAttribute('width')) > 0 && Number(image.getAttribute('height')) > 0, `${name}: image reserves width and height`);
    if (!image.closest('.hero')) check(image.getAttribute('loading') === 'lazy', `${name}: below-fold image is lazy loaded`);
  }
  const types = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(script.textContent);
    check(data && typeof data === 'object', `${name}: parseable structured data`);
    types.push(data['@type']);
    const checkSchema = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        check(!['softwareVersion', 'offers', 'aggregateRating', 'review', 'ratingValue'].includes(key), `${name}: no unapproved version, offer or rating in JSON-LD`);
        checkSchema(child);
      }
    };
    checkSchema(data);
    // A site-artifact cache key is not a software release; no version is claimed until the release is confirmed (MKT1 QA).
    if (data['@type'] === 'SoftwareApplication')
      check(!Object.hasOwn(data, 'softwareVersion'), `${name}: structured data claims no unconfirmed software version`);
    if (data['@type'] === 'FAQPage') {
      const normalize = value => value.replace(/\s+/g, ' ').trim();
      const headings = [...document.querySelectorAll('article.prose h2')];
      check(data.mainEntity?.length === headings.length, `${name}: FAQ schema covers all visible questions`);
      headings.forEach((heading, index) => {
        const answer = [];
        for (let next = heading.nextElementSibling; next && next.tagName !== 'H2'; next = next.nextElementSibling) answer.push(next.textContent);
        const entity = data.mainEntity[index];
        check(entity['@type'] === 'Question' && entity.name === normalize(heading.textContent), `${name}: FAQ question matches visible heading`);
        check(entity.acceptedAnswer?.['@type'] === 'Answer' && entity.acceptedAnswer.text === normalize(answer.join(' ')), `${name}: FAQ answer exactly matches visible copy`);
      });
    }
  }
  check(types.filter(t => t === 'SoftwareApplication').length === 1, `${name}: one fact-backed SoftwareApplication`);
  check(types.filter(t => t === 'FAQPage').length === (name.endsWith('faq.html') ? 1 : 0), `${name}: FAQ schema only on FAQ pages`);
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
check(locations.size === pages.length && sitemap.querySelectorAll('url').length === pages.length, 'Sitemap lists each public page exactly once');
for (const entry of sitemap.querySelectorAll('url')) {
  const document = [...documents.values()].find(d => d.querySelector('link[rel="canonical"]').href === entry.querySelector('loc').textContent.trim());
  const alternates = [...entry.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'link')];
  check(alternates.length === 3, 'Each sitemap URL includes three XHTML language alternates');
  for (const lang of ['en', 'zh-CN', 'x-default']) {
    const match = alternates.filter(a => a.getAttribute('hreflang') === lang);
    check(match.length === 1 && match[0].getAttribute('rel') === 'alternate' && match[0].getAttribute('href') === document.querySelector(`link[hreflang="${lang}"]`).href, `Sitemap ${lang} alternate matches page head`);
  }
}
const robots = await fs.readFile(path.join(site, 'robots.txt'), 'utf8');
check(robots.includes(new URL('sitemap.xml', base).href), 'Robots links the actual sitemap');
check(!/^Disallow:\s*\/\s*$/im.test(robots), 'Public site is not accidentally blocked');
check((await fs.stat(path.join(site, '.nojekyll'))).isFile(), 'Static deployment bypasses Jekyll');
for (const name of ['index.html', 'zh/index.html']) {
  const document = documents.get(name);
  check(document.querySelector('.hero a[href="getting-started.html"]'), `${name}: primary action starts setup for the current Chrome`);
  check(document.querySelector('.handoff-story ol')?.children.length === 4, `${name}: same-page handoff and explicit continuation are explained`);
  check(document.querySelector('#your-pace a[href="getting-started.html#personal-rhythm"]'), `${name}: personal input rhythm has a setup destination`);
  check(document.querySelectorAll('#demo .task-row').length === 3, `${name}: task requests are presented as examples`);
  check(!document.querySelector('[data-demo], .demo-figure, .hero-figure'), `${name}: no retired simulated task demo or onboarding screenshot`);
}
// The overview film shows a Chinese interface: it stays on the Chinese page only until an English film exists.
// The English hero is the takeover card rendered from the product's own code (MKT1, 2026-11-04).
{
  const name = 'index.html', document = documents.get(name);
  check(document.querySelector('.hero a[href="#how-it-works"]') && document.getElementById('how-it-works')?.querySelector('.handoff-story'), `${name}: hero links to the handoff explanation`);
  const hero = document.querySelector('.hero .hero-media img');
  check(hero?.getAttribute('src')?.includes('takeover-card-en.gif') && hero.getAttribute('alt')?.trim().length > 40, `${name}: hero shows the English takeover card with a description`);
  check((await fs.stat(path.join(site, hero.dataset.still.replace(/^\.\//, '')))).isFile(), `${name}: hero has a still frame for pausing`);
  check(document.querySelector('.hero-media source[media="(prefers-reduced-motion: reduce)"]')?.getAttribute('srcset')?.includes('takeover-card-en.png'), `${name}: reduced motion shows the still frame`);
  check(/not a screen recording/.test(document.querySelector('.hero-media figcaption')?.textContent ?? ''), `${name}: hero media discloses that it is a rendering`);
  check(Boolean(document.getElementById('how-it-works').compareDocumentPosition(document.getElementById('demo')) & 4), `${name}: handoff explanation precedes task examples`);
}
for (const name of ['index.html', 'getting-started.html', 'faq.html']) {
  const html = await fs.readFile(path.join(site, name), 'utf8');
  check(!/mychrome-overview\.(?:mp4|gif)/.test(html) && !documents.get(name).querySelector('video'), `${name}: no Chinese-interface film on an English page`);
}
for (const name of ['zh/index.html']) {
  const document = documents.get(name);
  check(document.querySelector('.hero a[href="#film"]'), `${name}: hero links to the product film`);
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
// English surfaces contain no Chinese text except the one language switch (MKT1 brief and Codex QA, 2026-11-04).
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/u;
const zhCounterpart = { 'index.html': 'zh/', 'getting-started.html': 'zh/getting-started.html', 'faq.html': 'zh/faq.html' };
for (const [name, target] of Object.entries(zhCounterpart)) {
  const copy = documents.get(name).documentElement.cloneNode(true);
  const switches = [...copy.querySelectorAll('header nav a.language')].filter(a => a.getAttribute('lang') === 'zh-CN' && a.getAttribute('href') === target);
  check(switches.length === 1, `${name}: exactly one language switch to ${target}`);
  switches[0]?.remove();
  const attributes = [...copy.querySelectorAll('*')].flatMap(e => ['alt', 'title', 'aria-label', 'content', 'label'].map(a => e.getAttribute(a) ?? ''));
  check(!CJK.test([copy.textContent, ...attributes].join('\n')), `${name}: English page has no Chinese text outside the language switch`);
}
// Markdown and text surfaces: the only exemption is the literal language-switch link of that file.
const languageSwitch = { 'README.md': '[中文](README.zh-CN.md)', 'docs/getting-started.md': '[简体中文](getting-started.zh-CN.md)' };
const englishText = ['README.md', 'llms.txt', 'site/llms.txt', 'docs/launch-kit.md', 'site/brand-brief.md', 'docs/getting-started.md',
  ...(await fs.readdir(path.join(root, 'docs/faq'))).filter(f => f.endsWith('.md')).map(f => `docs/faq/${f}`)];
for (const name of englishText) {
  let text = await fs.readFile(path.join(root, name), 'utf8');
  if (languageSwitch[name]) {
    check(text.split(languageSwitch[name]).length === 2, `${name}: exactly one language-switch link`);
    text = text.replace(languageSwitch[name], '');
  }
  check(!CJK.test(text), `${name}: English surface has no Chinese text outside the language switch`);
}
// H1–H8 shipped in 0.15.0; public copy must not retain candidate qualifiers.
const releaseSurfaces = [...new Set([...englishText, 'README.zh-CN.md', 'docs/getting-started.zh-CN.md',
  ...pages.map(name => `site/${name}`)])];
for (const name of releaseSurfaces) {
  const text = (await fs.readFile(path.join(root, name), 'utf8')).replace(/\s+/g, ' ');
  check(!/upcoming[ -]release|next release|即将发布|下一版|下个版本|下一个版本/i.test(text), `${name}: no unreleased H-feature wording`);
  check(!/currently published release|main (?:MyChrome )?window (?:uses Chinese labels|is labelled in Chinese)|notifications default to Chinese|目前已发布|主窗口为中文|通知默认中文/i.test(text), `${name}: no superseded language disclosure`);
}
for (const [name, heading] of [['index.html', 'New in 0.15.0.'], ['zh/index.html', '0.15.0 新增功能。']]) {
  check(documents.get(name).getElementById('next-title')?.textContent === heading, `${name}: release feature heading pins 0.15.0`);
}
for (const name of ['README.md', 'README.zh-CN.md', 'llms.txt', 'site/llms.txt',
  'docs/getting-started.md', 'docs/getting-started.zh-CN.md', 'docs/faq/README.md',
  'docs/faq/use-my-logged-in-chrome-with-claude-code.md', 'docs/launch-kit.md', 'site/brand-brief.md',
  ...pages.map(name => `site/${name}`)]) {
  const text = await fs.readFile(path.join(root, name), 'utf8');
  check(text.includes('0.15.0'), `${name}: released features identify 0.15.0`);
}
// README heroes play inline on GitHub: animated GIFs with descriptions, never a poster still that looks like a player.
function gifInfo(bytes) {
  if (bytes.subarray(0, 6).toString('latin1') !== 'GIF89a') return null;
  let i = 13, frames = 0, loops = false;
  if (bytes[10] & 0x80) i += 3 * (1 << ((bytes[10] & 7) + 1));
  const skipBlocks = () => { for (let n; i < bytes.length && (n = bytes[i++]) !== 0;) i += n; };
  while (i < bytes.length) {
    const block = bytes[i++];
    if (block === 0x3b) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames, loops };
    if (block === 0x21) {
      if (bytes[i++] === 0xff && bytes.subarray(i + 1, i + 12).toString('latin1') === 'NETSCAPE2.0') loops = true;
      skipBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[i + 8]; i += 9;
      if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
      i++; skipBlocks(); frames++;
    } else return null;
  }
  return null;
}
for (const [name, gif] of [['README.md', 'site/assets/takeover-card-en.gif'], ['README.zh-CN.md', 'site/assets/mychrome-overview.gif']]) {
  const readme = await fs.readFile(path.join(root, name), 'utf8');
  const img = new JSDOM(readme).window.document.querySelector(`img[src="${gif}"]`);
  check(img && img.getAttribute('alt')?.trim().length > 40, `${name}: hero embeds ${gif} inline with a description`);
  check(!/mychrome-overview-poster\.webp/.test(readme), `${name}: no poster still presented as a video`);
  const info = gifInfo(await fs.readFile(path.join(root, gif)));
  check(info && info.frames >= 4 && info.loops, `${name}: ${gif} is a complete looping animation (${info?.frames} frames)`);
}
check(!CJK.test((await fs.readFile(path.join(root, 'README.md'), 'utf8')).match(/<img[^>]*takeover-card-en\.gif[^>]*>/)?.[0] ?? '中'), 'README.md: English hero description is English');
const englishGif = gifInfo(await fs.readFile(path.join(site, 'assets/takeover-card-en.gif')));
check(englishGif?.width === 640 && englishGif.height === 705, 'English hero GIF keeps its reviewed 640 by 705 size');
const llms = await fs.readFile(path.join(site, 'llms.txt'), 'utf8');
check(llms === await fs.readFile(path.join(root, 'llms.txt'), 'utf8'), 'Root and site llms.txt are byte-identical');
check(!/local practice task|examples\/first-task/.test(llms), 'Machine-readable entry uses the actual task onboarding');
check(llms.includes('personal input habit sampling is experimental'), 'Machine-readable entry preserves the personal rhythm feature boundary');
for (const name of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'llms.txt'])
  check((await fs.readFile(path.join(root, name), 'utf8')).trim().length > 50, `Public entry document exists: ${name}`);
console.log(`public-site: ${checks} artifact checks passed across ${pages.length} pages`);
