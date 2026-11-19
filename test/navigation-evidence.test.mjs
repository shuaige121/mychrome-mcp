// Exercise the compiled helper in dry-run; never reads or posts real input.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import { openInputSession } from '../src/bridge.js';

for (const kind of ['none', 'other_window', 'target', 'ambiguous', 'unreliable', 'target_then_unreliable']) {
  const session = openInputSession({ env: { ...process.env, CGEVENT_DRYRUN: '1', CHROME_BRIDGE_HABITS: 'off' } });
  try {
    const start = await session.request({ op: 'watchNavigation', maxMs: 10000 });
    assert.equal(start.readOnly, true);
    if (kind !== 'none') await session.request({ op: '_navigationEvent', pid: 42,
      ...(kind.startsWith('target') ? { window: 7 } : kind === 'other_window' ? { window: 8 } : {}),
      ...(kind === 'unreliable' ? { unknown: true } : {}), epoch: start.startedAt + 1 });
    if (kind === 'target_then_unreliable') await session.request({ op: '_navigationEvent', unknown: true });
    const r = await session.request({ op: 'navigationState', chromePid: 42, window: 7, since: start.startedAt });
    assert.equal(r.known, !kind.includes('unreliable'));
    assert.equal(r.targetInput, kind.startsWith('target'));
    assert.equal(r.ambiguousInput, kind === 'ambiguous');
    assert.equal(r.untouched, kind === 'none' || kind === 'other_window');
    const invalid = await session.request({ op: 'navigationState', chromePid: 42, window: 7, since: start.startedAt - 1 });
    assert.equal(invalid.known, false);
    assert.equal(invalid.targetInput, false);
  } finally { await session.close(); }
}
console.log('navigation-evidence: 6 exact-window, ambiguous and unavailable cases passed');
