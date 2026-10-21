/** Stable Node versions allowed by the source package's dependency engines. */
export const NODE_ENGINE_RANGE = '^20.19.0 || ^22.13.0 || >=24.0.0';
export const NODE_REQUIREMENT = 'Node.js 24+ (recommended), 22.13+ on 22.x, or 20.19+ on 20.x';

export function supportedNode(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor] = parts;
  return major >= 24 || (major === 22 && minor >= 13) || (major === 20 && minor >= 19);
}
