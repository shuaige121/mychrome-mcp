/* Every live script starts here: on a locked screen or sleeping displays nothing works as it should
 * (new windows keep their default size, closed ones linger, every capture fails — 2026-10-06), so
 * refuse before opening anything. */

/** Permanently quarantine these entrypoints; there is intentionally no override. */
export function refuseUnsafeLegacy(entrypoint) {
  throw Object.assign(new Error(`REFUSED: ${entrypoint} uses legacy unguarded visible mutations. Use reliability-reset-live.mjs --check; only the root operator may run its explicit --run modes.`),
    { code: 'unsafe_legacy_live', stage: 'entry', inputDelivery: 'not_sent' });
}

export async function requireUnlocked() {
  const B = await import('../src/bridge.js');
  const d = await B.cgevent(['displays']).catch(() => null);
  if (!d || d.locked || d.displaysAsleep || !(d.displays || []).length) {
    console.error(`REFUSED: the screen is ${d && d.locked ? 'locked' : 'asleep or unreadable'} — unlock it, then run this again. Nothing was opened.`);
    process.exit(3);
  }
}
