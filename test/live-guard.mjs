/* Every live script starts here: on a locked screen or sleeping displays nothing works as it should
 * (new windows keep their default size, closed ones linger, every capture fails — 2026-10-06), so
 * refuse before opening anything. */
import * as B from '../src/bridge.js';

export async function requireUnlocked() {
  const d = await B.cgevent(['displays']).catch(() => null);
  if (!d || d.locked || d.displaysAsleep || !(d.displays || []).length) {
    console.error(`REFUSED: the screen is ${d && d.locked ? 'locked' : 'asleep or unreadable'} — unlock it, then run this again. Nothing was opened.`);
    process.exit(3);
  }
}
