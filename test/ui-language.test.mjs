#!/usr/bin/env node
/* I18N1 (problems-20261101, contracts-batch4.md): MyChrome's own words follow one language choice — CHROME_BRIDGE_UI_LANG
 * (en|zh), then the older CHROME_BRIDGE_LANG, then the settings file's uiLanguage, then the Mac's first preferred language
 * (zh* → Chinese, otherwise English). Agent-facing receipts never change (the tool-definition length stays 14995).
 * New fix (each RED under its targeted mutation in runs/I18N1/rerun.sh):
 *   server-order       src/index.js uiEnglish: the order above; the Mac's language read at most every 10 minutes
 *   held-note          the held-input notification in both languages, through the production sender
 *   refusal-note       NOTICE1's refusal notification in both languages (the Chinese wording unchanged)
 *   popup-note         scope addition (integration review B): an executed Chrome popup action is stated next to the
 *                      requested input's own delivery, never "no click or key was sent"
 *   site-blocked       the real read_page on a CAPTCHA page: the notification and the panel's alert line in the UI language
 *   veil-language      bin/cgevent veilsnap without --lang: the takeover card follows the same order (env, settings file)
 *   panel-language     bin/cbmenu --read-activity: the panel's labels follow the same order; the server's home-folder label too
 *   routine-messages   r1 A1: the production runner's views (running, completed, failed cleanup, blocked, cancelled) worded in
 *                      English by the GUI's routineRunMessage from status/code/counts; Chinese unchanged
 *   restart-notes      r1 A2: every outcome restart.js produces in test/restart.test.mjs's scenarios, worded by restartNoteText
 *                      from what happened (restarted / already / closed / typed without Return / untouched / failed)
 *   language-lock      r1 B: an environment variable that fixes the language shows on the Language row (disabled then)
 *   panel-render       bin/cbmenu --snapshot / --snapshot-gui rendered offscreen in both languages and read back with the
 *                      helper's OCR: English words in English, Chinese in Chinese; the panel keeps its fixed width
 * Nothing here drives Chrome, posts input or shows a window or a notification (the sender is a stub). */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'cb-i18n1-'));
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|KITTY_)/.test(k) || k === 'CLAUDECODE') delete process.env[k];
for (const k of ['CHROME_BRIDGE_UI_LANG', 'CHROME_BRIDGE_LANG', 'CGEVENT_DRYRUN']) delete process.env[k];
Object.assign(process.env, {
  CHROME_BRIDGE_LOCK: path.join(tmp, 'lock', 'input.lock'), CHROME_BRIDGE_TAB_DIR: path.join(tmp, 'tabs'),
  CHROME_BRIDGE_AGENT_STATE: path.join(tmp, 'agent-window.json'), CHROME_BRIDGE_NOTIFY: '0', CHROME_BRIDGE_HABITS: 'off',
  CHROME_BRIDGE_MENUBAR: '0', CHROME_BRIDGE_WARM: '0', CHROME_BRIDGE_AGENT_NAME: 'i18n1-test',
});
await mkdir(path.join(tmp, 'lock'), { recursive: true });
const idx = await import('../src/index.js');
const ONLY = process.env.I18N1_CASE ? process.env.I18N1_CASE.split(',') : null;
const CJK = /[㐀-鿿　-〿＀-￯]/;
const CGEVENT = process.env.CGEVENT_BIN || path.join(ROOT, 'bin', 'cgevent');
const CBMENU = process.env.CBMENU_BIN || path.join(ROOT, 'bin', 'cbmenu');
let failed = 0, passed = 0;
async function check(name, fn) {
  if (ONLY && !ONLY.some(x => name.startsWith(x))) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`FAIL - ${name}\n${e?.stack || e}`); }
}
/** `env` for the server functions: one variable set or none, with this file's settings path. */
const settingsAt = async (name, value) => {
  const file = path.join(tmp, `${name}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
};
const sent = [];
idx.__notifyForTests({ send: text => sent.push(text), everyMs: 60_000 });

await check('server-order: CHROME_BRIDGE_UI_LANG, then CHROME_BRIDGE_LANG, then the settings file, then the Mac', async () => {
  const none = await settingsAt('none', {}), en = await settingsAt('en', { uiLanguage: 'en' }), zh = await settingsAt('zh', { uiLanguage: 'zh' });
  const bad = await settingsAt('bad', { uiLanguage: 'English' }), auto = await settingsAt('auto', { uiLanguage: 'auto' });
  const at = (file, extra = {}) => ({ CHROME_BRIDGE_SETTINGS: file, ...extra });
  idx.__uiLanguageForTests({ mac: 'zh-Hans-SG' });
  assert.equal(idx.uiEnglish(at(none)), false, 'a Chinese Mac, nothing chosen: Chinese');
  assert.equal(idx.uiEnglish(at(auto)), false, 'auto follows the Mac');
  assert.equal(idx.uiEnglish(at(bad)), false, 'a bad file value is no choice');
  assert.equal(idx.uiEnglish(at(en)), true, 'the settings file wins over the Mac');
  assert.equal(idx.uiEnglish(at(en, { CHROME_BRIDGE_UI_LANG: 'zh' })), false, 'the variable wins over the file');
  assert.equal(idx.uiEnglish(at(zh, { CHROME_BRIDGE_UI_LANG: 'en' })), true, 'the variable wins over the file (en)');
  assert.equal(idx.uiEnglish(at(en, { CHROME_BRIDGE_UI_LANG: 'auto' })), true, 'CHROME_BRIDGE_UI_LANG=auto leaves the file to decide');
  assert.equal(idx.uiEnglish(at(en, { CHROME_BRIDGE_UI_LANG: 'fr' })), true, 'a bad variable value is no choice');
  assert.equal(idx.uiEnglish(at(en, { CHROME_BRIDGE_LANG: 'zh' })), false, 'the older variable wins over the file');
  assert.equal(idx.uiEnglish(at(none, { CHROME_BRIDGE_LANG: 'en', CHROME_BRIDGE_UI_LANG: 'zh' })), false, 'the new variable wins over the older one');
  idx.__uiLanguageForTests({ mac: 'en-SG' });
  assert.equal(idx.uiEnglish(at(none)), true, 'an English Mac: English');
  idx.__uiLanguageForTests({ mac: 'fr-FR' });
  assert.equal(idx.uiEnglish(at(none)), true, 'any other language: English');
  idx.__uiLanguageForTests({ mac: 'zh-Hant-TW' });
  assert.equal(idx.uiEnglish(at(zh)), false);
  assert.equal(idx.uiEnglish(at(none)), false, 'traditional Chinese: Chinese');
  let reads = 0;
  idx.__uiLanguageForTests({ mac: () => { reads++; return 'en-US'; } });
  for (let i = 0; i < 5; i++) idx.uiEnglish(at(none));
  idx.uiEnglish(at(en));
  assert.equal(reads, 1, `the Mac's language read ${reads} times for 5 auto decisions`);
  idx.__uiLanguageForTests({ mac: () => { reads++; return 'en-US'; } });
  idx.uiEnglish(at(zh, { CHROME_BRIDGE_UI_LANG: 'en' }));
  assert.equal(reads, 1, 'read although an explicit choice decided');
});

await check('held-note: the held-input notification in both languages, through the production sender', async () => {
  const both = idx.heldNoticeText({ keys: 3, pointer: 1 });
  assert.equal(both.zh, 'agent 操作期间拦下了你的 3 个按键、1 次点击/滚动，没有送到任何程序，需要的话请重新输入。', 'the Chinese wording changed');
  assert.match(both.en, /held back 3 key presses and 1 click or scroll/);
  assert.equal(CJK.test(both.en), false, both.en);
  assert.match(idx.heldNoticeText({ keys: 1, pointer: 0 }).en, /held back 1 key press of yours/);
  const held = idx.__notifyForTests({ send: text => sent.push(text), everyMs: 60_000 });
  sent.length = 0;
  process.env.CHROME_BRIDGE_UI_LANG = 'en';
  try { held(2, 0); } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^During the AI's action, MyChrome held back 2 key presses of yours/, sent[0]);
  idx.__notifyForTests({ send: text => sent.push(text), everyMs: 60_000 });
  sent.length = 0;
  process.env.CHROME_BRIDGE_UI_LANG = 'zh';
  try { held(0, 2); } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
  assert.equal(sent[0], 'agent 操作期间拦下了你的 2 次点击/滚动，没有送到任何程序，需要的话请重新输入。');
});

await check('refusal-note: NOTICE1\'s notification in both languages; the Chinese wording is unchanged', async () => {
  const base = { reason: 'other_app_front', front: 'Terminal', delivery: 'not_sent', apple: true };
  assert.equal(idx.refusalNoticeText(base, false),
    'agent 想操作 Chrome 但没能完成：MyChrome 已尝试切到 Chrome，最前面仍是「Terminal」。没有发送任何点击或按键。如果还是切不过去，请点一下 Chrome 窗口。');
  assert.equal(idx.refusalNoticeText(base, true),
    'The AI tried to use Chrome but could not: MyChrome tried to switch to Chrome, but “Terminal” is still in front. No click or key was sent. If it still does not switch, click the Chrome window once.');
  for (const reason of ['other_app_front', 'covered', 'not_key', 'tab_not_current', 'unknown', 'page_focus', 'nonsense']) {
    for (const delivery of ['not_sent', 'sent', 'unknown', undefined]) {
      for (const apple of [true, false]) {
        const en = idx.refusalNoticeText({ reason, front: 'Terminal', delivery, apple }, true);
        assert.equal(CJK.test(en), false, `${reason}/${delivery}: ${en}`);
        assert.equal(/No click or key was sent/.test(en), delivery === 'not_sent', `${reason}/${delivery}: ${en}`);
        assert.equal(/click the Chrome window/.test(en), reason === 'other_app_front' && apple, `${reason}/${apple}: ${en}`);
        assert.match(idx.refusalNoticeText({ reason, front: 'Terminal', delivery, apple }, false), /^agent 想操作 Chrome/);
      }
    }
  }
  // the default follows the UI language
  process.env.CHROME_BRIDGE_UI_LANG = 'en';
  try { assert.match(idx.refusalNoticeText(base), /^The AI tried to use Chrome/); } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
});

await check('popup-note: an executed Chrome popup action is stated next to the requested input\'s own delivery', async () => {
  const allowed = { reason: 'other_app_front', front: 'Terminal', delivery: 'not_sent', apple: true, popupAction: 'allow', popupDelivery: 'sent' };
  const zh = idx.refusalNoticeText(allowed, false), en = idx.refusalNoticeText(allowed, true);
  assert.match(zh, /已在 Chrome 的网站权限询问里选了「允许」；没有发送这次要做的点击或按键。/, zh);
  assert.equal(zh.includes('没有发送任何点击或按键'), false, `says nothing at all was sent: ${zh}`);
  assert.match(en, /MyChrome chose Allow in Chrome's site permission prompt; the requested click or key was not sent\./, en);
  assert.equal(/No click or key was sent/.test(en), false, en);
  const dismissed = idx.refusalNoticeText({ ...allowed, popupAction: 'dismiss', delivery: 'sent' }, false);
  assert.match(dismissed, /关掉了它；这次要做的输入已发出一部分/, dismissed);
  const unsure = idx.refusalNoticeText({ ...allowed, popupDelivery: 'unknown', delivery: 'unknown' }, true);
  assert.match(unsure, /it is not certain whether a button in Chrome's prompt was pressed; it is not certain whether the requested input was sent/i, unsure);
  // only the finite words count: no action, an observation or a word outside the set adds nothing
  for (const facts of [{ popupAction: 'none', popupDelivery: 'not_sent' }, { popupAction: 'observe', popupDelivery: 'sent' },
    { popupAction: 'allow', popupDelivery: 'not_sent' }, { popupAction: 'Allow', popupDelivery: 'sent' }]) {
    assert.equal(idx.refusalNoticeText({ ...allowed, ...facts }, false),
      idx.refusalNoticeText({ reason: 'other_app_front', front: 'Terminal', delivery: 'not_sent', apple: true }, false), JSON.stringify(facts));
  }
});

/* ------------------------------------------------ the real read_page on a CAPTCHA page (as test/promo-record-v02.test.mjs) */

const page = { w: null };
const fakeB = Object.fromEntries(idx.__bridgeKeysForTests().map(k => [k, () => { throw new Error(`the test reached the real bridge: ${k}`); }]));
delete fakeB.pageScript;
Object.assign(fakeB, {
  pageDialog: async () => ({ ok: true, open: false }),
  evalInPage: async (src, tab) => {
    const p = JSON.parse(page.w.eval(src));
    if (!p.ok) throw Object.assign(new Error(p.message || p.error), { code: p.error });
    return { ...p, bounds: { left: 24, top: 40, width: 1100, height: 760 },
      target: { tabId: tab ?? 100, windowId: 1100, url: page.w.location.href, title: page.w.document.title, tabActive: true } };
  },
});
function dom(html, url) {
  const w = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.Element.prototype.getBoundingClientRect = function () {
    const spec = this.getAttribute('data-rect');
    const [x, y, width, height] = spec ? spec.split(',').map(Number) : [10, 10, 120, 24];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } };
  };
  w.Element.prototype.getClientRects = function () { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; };
  w.document.elementFromPoint = () => null;
  for (const [k, v] of Object.entries({ innerWidth: 1100, innerHeight: 700, outerWidth: 1100, outerHeight: 760, screenX: 24, screenY: 40, devicePixelRatio: 2 })) {
    Object.defineProperty(w, k, { value: v, configurable: true });
  }
  return w;
}
const CAPTCHA = `<!doctype html><html><head><title>ReCAPTCHA demo</title></head><body><form><div class="g-recaptcha">
<iframe title="reCAPTCHA" data-rect="20,300,304,78" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le&co=aHR0&hl=en&size=normal"></iframe>
<textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea></div></form></body></html>`;
const TASK_FILE = path.join(tmp, 'lock', 'tasks', `${process.pid}.json`);

await check('site-blocked: the notification and the panel\'s alert line follow the UI language (the agent\'s receipt does not)', async () => {
  idx.__setBridgeForTests(fakeB);
  const blocked = async (lang) => {
    idx.__resetPanelTaskForTests();
    idx.__notifyForTests({ send: text => sent.push(text), everyMs: 60_000 });
    sent.length = 0;
    process.env.CHROME_BRIDGE_UI_LANG = lang;
    try {
      page.w = dom(CAPTCHA, 'https://www.google.com/recaptcha/api2/demo');
      const e = await idx.readPage({ tab: 100, full: true }).then(() => null, x => x);
      assert.equal(e?.code, 'site_blocked', String(e?.message));
      return { told: [...sent], alert: JSON.parse(await readFile(TASK_FILE, 'utf8')).alert, receipt: e.message };
    } finally { delete process.env.CHROME_BRIDGE_UI_LANG; }
  };
  const en = await blocked('en');
  assert.equal(en.told.length, 1, JSON.stringify(en.told));
  assert.match(en.told[0], /^Needs you: www\.google\.com is showing a reCAPTCHA check\. The AI has given the keyboard and mouse back\./, en.told[0]);
  assert.match(en.alert, /^Needs you: www\.google\.com is showing a reCAPTCHA check$/, en.alert);
  assert.match(en.receipt, /不代做、也不绕过/, 'the agent-facing receipt changed language');
  const zh = await blocked('zh');
  assert.match(zh.told[0], /^需要你处理：www\.google\.com 出现了reCAPTCHA 人机验证（验证码）。AI 已交还键盘鼠标。/, zh.told[0]);
  assert.equal(zh.alert, '需要你处理：www.google.com reCAPTCHA 人机验证（验证码）');
  assert.equal(zh.receipt, en.receipt, 'the agent-facing receipt depends on the UI language');
  idx.__resetPanelTaskForTests();
});

/* ------------------------------------------------ the native renderers */

const nativeEnv = (extra) => ({ HOME: os.homedir(), PATH: '/usr/bin:/bin', CHROME_BRIDGE_SETTINGS: path.join(tmp, 'none.json'),
  CHROME_BRIDGE_LOCK: path.join(tmp, 'native', 'input.lock'), CHROME_BRIDGE_ONBOARDING: path.join(tmp, 'native', 'onboarding.json'), ...extra });

await check('veil-language: the takeover card (veilsnap without --lang) follows the variable, then the older variable, then the settings file', async () => {
  const lang = async (extra) => JSON.parse(execFileSync(CGEVENT, ['veilsnap', '--out', path.join(tmp, 'veil.png'), '--frames', 'start'],
    { encoding: 'utf8', timeout: 60_000, env: nativeEnv(extra) })).lang;
  const en = await settingsAt('veil-en', { uiLanguage: 'en' }), zh = await settingsAt('veil-zh', { uiLanguage: 'zh' });
  assert.equal(await lang({ CHROME_BRIDGE_UI_LANG: 'en', CHROME_BRIDGE_SETTINGS: zh }), 'en', 'CHROME_BRIDGE_UI_LANG=en');
  assert.equal(await lang({ CHROME_BRIDGE_UI_LANG: 'zh', CHROME_BRIDGE_SETTINGS: en }), 'zh', 'CHROME_BRIDGE_UI_LANG=zh');
  assert.equal(await lang({ CHROME_BRIDGE_SETTINGS: en }), 'en', 'settings file uiLanguage en');
  assert.equal(await lang({ CHROME_BRIDGE_SETTINGS: zh }), 'zh', 'settings file uiLanguage zh');
  assert.equal(await lang({ CHROME_BRIDGE_UI_LANG: 'auto', CHROME_BRIDGE_SETTINGS: en }), 'en', 'auto leaves the file to decide');
  assert.equal(await lang({ CHROME_BRIDGE_LANG: 'en', CHROME_BRIDGE_SETTINGS: zh }), 'en', 'the older variable wins over the file');
  // a dry run reads the settings file only when CHROME_BRIDGE_SETTINGS isolates it (as the speed preference)
  assert.equal(await lang({ CGEVENT_DRYRUN: '1', CHROME_BRIDGE_SETTINGS: en }), 'en', 'dry run with an isolated settings file');
});

await check('panel-language: bin/cbmenu follows the variable, then the older variable, then the settings file (--read-activity labels)', async () => {
  const log = path.join(tmp, 'activity.jsonl');
  await writeFile(log, [{ t: 1, tool: 'type_text', ok: false, code: 'paused_by_user', who: 'Claude · 主目录' }, { t: 2, tool: 'read_page', ok: true, host: 'a.test', who: 'x' }]
    .map(x => JSON.stringify(x)).join('\n') + '\n');
  const labels = extra => JSON.parse(execFileSync(CBMENU, ['--read-activity'], { encoding: 'utf8', timeout: 30_000, env: nativeEnv({ CHROME_BRIDGE_ACTIVITY: log, ...extra }) }))
    .map(x => [x.label, x.why, x.who].filter(Boolean).join(' | '));
  const EN = ['Read page | x', 'Type text | AI operations were paused | Claude · home folder'];
  const ZH = ['读取页面 | x', '输入文字 | 当时 AI 操作已暂停 | Claude · 主目录'];
  const en = await settingsAt('panel-en', { uiLanguage: 'en' }), zh = await settingsAt('panel-zh', { uiLanguage: 'zh' });
  assert.deepEqual(labels({ CHROME_BRIDGE_UI_LANG: 'en', CHROME_BRIDGE_SETTINGS: zh }), EN, 'CHROME_BRIDGE_UI_LANG=en');
  assert.deepEqual(labels({ CHROME_BRIDGE_UI_LANG: 'zh', CHROME_BRIDGE_SETTINGS: en }), ZH, 'CHROME_BRIDGE_UI_LANG=zh');
  assert.deepEqual(labels({ CHROME_BRIDGE_SETTINGS: en }), EN, 'settings file uiLanguage en');
  assert.deepEqual(labels({ CHROME_BRIDGE_SETTINGS: zh }), ZH, 'settings file uiLanguage zh');
  assert.deepEqual(labels({ CHROME_BRIDGE_UI_LANG: 'auto', CHROME_BRIDGE_SETTINGS: en }), EN, 'auto leaves the file to decide');
  assert.deepEqual(labels({ CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_SETTINGS: en }), ZH, 'the older variable wins over the file');
});

const ocr = (png) => JSON.parse(execFileSync(CGEVENT, ['ocr', png, '--langs', 'zh-Hans,en-US'], { encoding: 'utf8', timeout: 120_000, env: nativeEnv({}) }))
  .lines.map(l => l.text).join('\n').replace(/\bAl\b/g, 'AI');   // OCR reads the sans-serif "AI" as "Al"

await check('panel-render: the panel and the workspace render in English or Chinese offscreen; the panel keeps its width', async () => {
  const shot = (lang, page) => {
    const out = path.join(tmp, `panel-${page}-${lang}.png`);
    const r = JSON.parse(execFileSync(CBMENU, ['--snapshot', out, '--page', page, '--demo', '--habits', 'recorded'],
      { encoding: 'utf8', timeout: 60_000, env: nativeEnv({ CHROME_BRIDGE_UI_LANG: lang }) }));
    return { out, w: r.w };
  };
  for (const page of ['status', 'settings', 'records']) {
    const en = shot('en', page), zh = shot('zh', page);
    assert.equal(en.w, zh.w, `${page}: the English panel is ${en.w} pt wide, the Chinese ${zh.w}`);
    assert.equal(en.w, 360, `${page}: the panel is not its fixed width`);
  }
  const en = ocr(path.join(tmp, 'panel-status-en.png')), zh = ocr(path.join(tmp, 'panel-status-zh.png'));
  for (const word of ['Open conversation center', 'Status', 'Settings', 'Activity', 'Readiness', 'Keep screen awake']) assert.ok(en.includes(word), `English panel lacks "${word}":\n${en}`);
  for (const word of ['打开会话中心', '状态', '准备情况', '屏幕常亮']) {
    assert.ok(zh.includes(word), `Chinese panel lacks "${word}":\n${zh}`);
    assert.equal(en.includes(word), false, `English panel shows "${word}"`);
  }
  const gui = path.join(tmp, 'workspace-en.png');
  execFileSync(CBMENU, ['--snapshot-gui', gui], { timeout: 60_000, env: nativeEnv({ CHROME_BRIDGE_UI_LANG: 'en' }) });
  const g = ocr(gui);
  for (const word of ['New conversation', 'Conversations', 'Operation settings', 'Website routines', 'Pause AI operations', 'Go handle it']) {
    assert.ok(g.includes(word), `English workspace lacks "${word}":\n${g}`);
  }
  assert.equal(/对话|操作设置|网站流程|去处理/.test(g), false, `Chinese in the English workspace:\n${g}`);
});

/* ------------------------------------------------ r1 A1/A2: the GUI's own wording of the runner's and restart program's outcomes */

/** A probe compiled from the production Swift: the language core (src/onboarding-ui.swift), routineRunMessage
 * (src/routine-ui.swift) and restartNoteText (src/menubar.swift), fed with production outcomes. */
let probe = null;
function swiftFunction(source, name) {
  const start = source.indexOf(`func ${name}(`);
  assert.ok(start >= 0, `production function missing: ${name}`);
  const open = source.indexOf('{', start);
  for (let i = open, depth = 0; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function wording(requests, lang) {
  if (!probe) {
    const read = f => readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const ob = read('onboarding-ui.swift');
    const core = ob.slice(ob.indexOf('// MARK: - I18N1: one language for the whole native UI'), ob.indexOf('// MARK: - Small independent preference'));
    assert.ok(core.includes('func L('), 'the language core moved');
    const dir = path.join(tmp, 'probe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'main.swift'), `import Foundation
let SUPPORT_DIR = "/nonexistent-i18n1-probe"
func envPath(_ key: String, _ fallback: String) -> String { ProcessInfo.processInfo.environment[key] ?? fallback }
${core}
${swiftFunction(read('routine-ui.swift'), 'routineRunMessage')}
${swiftFunction(read('menubar.swift'), 'restartNoteText')}
let requests = (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))) as! [[String: Any]]
let out: [String] = requests.map { r in
    r["kind"] as? String == "routine"
        ? routineRunMessage(status: r["status"] as? String ?? "", code: r["code"] as? String, completed: r["completed"] as? Int ?? 0,
                            total: r["total"] as? Int ?? 0, step: r["step"] as? Int, message: r["message"] as? String ?? "")
        : restartNoteText(state: r["state"] as? String ?? "", how: r["how"] as? String, note: r["note"] as? String ?? "")
}
print(String(decoding: try! JSONSerialization.data(withJSONObject: out), as: UTF8.self))
`);
    probe = path.join(dir, 'probe');
    execFileSync('/usr/bin/swiftc', [path.join(dir, 'main.swift'), '-o', probe], { timeout: 180_000, stdio: 'pipe' });
  }
  const file = path.join(tmp, `requests-${lang}.json`);
  writeFileSync(file, JSON.stringify(requests));
  return JSON.parse(execFileSync(probe, [file], { encoding: 'utf8', timeout: 30_000,
    env: nativeEnv({ CHROME_BRIDGE_UI_LANG: lang, CHROME_BRIDGE_SETTINGS: path.join(tmp, 'none.json') }) }));
}

await check('routine-messages: a routine run\'s progress, completion and failure in English from the runner\'s facts (production runner; Chinese unchanged)', async () => {
  const { createRoutineRunner } = await import('../src/routine-runner.js');
  const ORIGIN = 'https://example.test';
  const page = n => ({ origin: ORIGIN, path: '/form', fingerprint: String(n).padStart(64, '0') });
  const step = n => ({ tool: 'click', before: page(n), after: page(n + 1), target: { version: 1, tag: 'button', role: 'button', name: 'Go' }, args: {} });
  const routine = { id: 'routine-a', site: ORIGIN, name: 'Test flow', archived: false, steps: [step(0), step(1)], parameters: [] };
  const views = [];
  const runOnce = async (hooks = {}) => {
    let current = page(hooks.startAt ?? 0);
    const runner = createRoutineRunner({
      store: { async get() { return structuredClone(routine); }, async recordRun() {} },
      adapter: {
        async inspect() { return { page: structuredClone(current) }; },
        async resolve() { return { ok: true, marker: 7, targetState: {} }; },
        async act(tool, args, ctx) { if (hooks.act) return hooks.act(ctx); current = structuredClone(ctx.before.fingerprint === page(0).fingerprint ? page(1) : page(2)); return { ok: true }; },
        async finish() { if (hooks.finish) throw new Error('release not confirmed'); },
      },
      onChange: v => views.push({ kind: 'routine', ...structuredClone(v) }), wait: async () => {},
    });
    return runner.run({ id: 'routine-a', tab: 17, nonce: `n${views.length}`, params: {} });
  };
  await runOnce();                                                                   // running …, completed
  await runOnce({ finish: true });                                                    // completed actions, release unconfirmed: failed
  await runOnce({ act: () => ({ ok: true }) });                                       // the page never changes: postcondition_failed (blocked)
  await runOnce({ act: () => ({ ok: false, code: 'user_cancelled' }) });              // the user took control back: cancelled
  await runOnce({ startAt: 5 });                                                      // not at the recorded start: wrong_page
  const has = (status, code) => views.some(v => v.status === status && (code === undefined || v.code === code));
  for (const [status, code] of [['running'], ['completed'], ['failed', 'cleanup_unconfirmed'], ['blocked', 'postcondition_failed'], ['cancelled', 'user_cancelled'], ['blocked', 'wrong_page']]) {
    assert.ok(has(status, code), `the production runner gave no ${status}/${code ?? '-'} view: ${JSON.stringify(views.map(v => [v.status, v.code]))}`);
  }
  const zh = wording(views, 'zh'), en = wording(views, 'en');
  views.forEach((v, i) => {
    const said = `${v.status}/${v.code ?? '-'} "${v.message}" → "${en[i]}"`;
    assert.equal(zh[i], v.message, `Chinese changed: ${said}`);
    assert.equal(CJK.test(en[i]), false, `Chinese in English: ${said}`);
    if (v.code === 'cleanup_unconfirmed') assert.match(en[i], /^The actions ended, but returning control was not confirmed\. Check the browser\.$/, said);
    else if (v.status === 'completed') assert.equal(en[i], `Routine run and checked: ${v.completed} steps.`, said);
    else if (v.status === 'running' && !v.step) assert.equal(en[i], 'Checking the routine\'s starting page', said);
    else if (v.status === 'running' && v.message.startsWith('正在执行')) assert.equal(en[i], `Running step ${v.step} of ${v.total}`, said);
    else if (v.status === 'running') assert.equal(en[i], `Step ${v.completed} of ${v.total} confirmed`, said);
    else if (v.code === 'postcondition_failed') assert.match(en[i], /^The action was sent, but the expected page state was not confirmed; the routine stopped and will not retry by itself\.$/, said);
    else if (v.code === 'user_cancelled') assert.match(en[i], /^You took back control, so the routine stopped\.$/, said);
    else if (v.code === 'wrong_page') assert.match(en[i], /not where the routine was recorded/, said);
    else assert.fail(`an unexpected view: ${said}`);
  });
});

await check('restart-notes: each Restart-all outcome restart.js produces is worded from what actually happened (both languages)', async () => {
  const out = path.join(tmp, 'restart-outcomes.jsonl');
  execFileSync(process.execPath, [path.join(ROOT, 'test', 'restart.test.mjs')], { timeout: 300_000, stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: path.join(tmp, 'restart-home'), TMPDIR: tmp, RESTART_OUTCOMES_OUT: out } });
  const seen = new Map();
  for (const line of readFileSync(out, 'utf8').split('\n').filter(Boolean)) { const o = JSON.parse(line); seen.set(`${o.state}\0${o.how}\0${o.note}`, { kind: 'restart', ...o }); }
  const outcomes = [...seen.values()];
  const typed = o => o.state === 'skipped' && o.note.includes('没有按回车');
  const groups = {
    restarted: o => o.state === 'done' && o.note === '已重启，用上新版了', already: o => o.state === 'done' && o.note === '已经换成新版了',
    closed: o => o.state === 'done' && o.note === '会话已经关了', typed, untouched: o => o.state === 'skipped' && !typed(o),
    failed: o => o.state === 'failed', sent: o => o.state === 'sent', waiting: o => o.state === 'waiting',
  };
  for (const [name, is] of Object.entries(groups)) assert.ok(outcomes.some(is), `restart.js produced no "${name}" outcome`);
  const zh = wording(outcomes, 'zh'), en = wording(outcomes, 'en');
  outcomes.forEach((o, i) => {
    const said = `${o.state}/${o.how} "${o.note}" → "${en[i]}"`;
    assert.equal(zh[i], o.note, `Chinese changed: ${said}`);
    assert.equal(CJK.test(en[i]), false, `Chinese in English: ${said}`);
    if (!groups.restarted(o)) assert.doesNotMatch(en[i], /^Restarted/, `claims a restart: ${said}`);
    if (groups.restarted(o)) assert.equal(en[i], 'Restarted; now on the new version', said);
    else if (groups.already(o)) assert.match(en[i], /^Already on the new version/, said);
    else if (groups.closed(o)) assert.equal(en[i], 'The session has closed; it was not restarted', said);
    else if (typed(o)) {
      assert.match(en[i], /^\/mcp reconnect chrome-bridge was typed into that session's input box, but Return was not pressed and nothing was deleted/, said);
    } else if (o.state === 'skipped') {
      assert.match(en[i], /nothing was typed/, said);
      assert.doesNotMatch(en[i], /was typed into/, said);
    } else if (o.state === 'failed') assert.doesNotMatch(en[i], /^(Restarted|Already)/, said);
    else if (o.state === 'sent') assert.match(en[i], /^Reconnect sent/, said);
    else assert.match(en[i], /^Waiting for this session to be idle$/, said);
  });
});

await check('language-lock: an environment variable that fixes the language shows on the Language row, which is then disabled', async () => {
  const snap = extra => JSON.parse(execFileSync(CBMENU, ['--snapshot', path.join(tmp, 'lock.png'), '--page', 'settings', '--habits', 'recorded'],
    { encoding: 'utf8', timeout: 60_000, env: nativeEnv(extra) })).uiLanguage;
  const en = await settingsAt('lock-en', { uiLanguage: 'en' });
  assert.deepEqual(snap({ CHROME_BRIDGE_UI_LANG: 'en' }), { selected: 'en', fixedBy: 'CHROME_BRIDGE_UI_LANG', english: true });
  assert.deepEqual(snap({ CHROME_BRIDGE_LANG: 'zh', CHROME_BRIDGE_SETTINGS: en }), { selected: 'zh', fixedBy: 'CHROME_BRIDGE_LANG', english: false });
  // Unlocked, the row shows the panel model's setting (a --snapshot model keeps the default, auto) and stays enabled.
  assert.deepEqual(snap({ CHROME_BRIDGE_UI_LANG: 'auto', CHROME_BRIDGE_SETTINGS: en }), { selected: 'auto', fixedBy: null, english: true }, 'auto fixes nothing');
  assert.deepEqual(snap({ CHROME_BRIDGE_SETTINGS: en }), { selected: 'auto', fixedBy: null, english: true });
  snap({ CHROME_BRIDGE_UI_LANG: 'en' });
  const text = ocr(path.join(tmp, 'lock.png')).replace(/\s+/g, ' ');
  assert.match(text, /Fixed by this app's environment variable CHROME_BRIDGE_U[IL1l|]_LANG=en/, text);   // OCR may read "UI" as "UL"
});

console.log(`\nui-language: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
