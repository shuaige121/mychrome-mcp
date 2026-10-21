#!/usr/bin/env node
/** Install this checkout's native App. No settings, credentials, or running services change. */
import { installGuiApp } from '../src/setup.js';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--app-path')) {
  process.stderr.write('Usage: node scripts/install-gui.mjs [--app-path /absolute/path/MyChrome.app]\n');
  process.exitCode = 2;
} else {
  try {
    const { appPath } = await installGuiApp({ ...(args.length ? { appPath: args[1] } : {}) });
    console.log(`Installed ${appPath}\nOpen it from Finder or Spotlight. After rebuilding, run npm run install:gui again.`);
  } catch (error) { process.stderr.write(`App installation stopped: ${error.message}\n`); process.exitCode = 1; }
}
