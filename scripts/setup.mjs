#!/usr/bin/env node
import { parseSetupArgs, runSetup, formatSetupReport, SETUP_USAGE } from '../src/setup.js';
let options;
try { options = parseSetupArgs(process.argv.slice(2)); }
catch (error) {
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, status: 'usage_error', error: { detail: error.message } }) + '\n');
  else process.stderr.write(`${error.message}\n\n${SETUP_USAGE}\n`);
  process.exitCode = 2;
}
if (options?.help) process.stdout.write(`${SETUP_USAGE}\n`);
else if (options) {
  try {
    const report = await runSetup({ ...options, onProgress: line => process.stderr.write(`${line}\n`), onOutput: text => process.stderr.write(text) });
    process.stdout.write(options.json ? JSON.stringify(report) + '\n' : formatSetupReport(report));
    process.exitCode = options.instructions || report.ok ? 0 : 1;
  } catch (error) {
    if (options.json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, status: 'failed', error: { detail: error.message } }) + '\n');
    else process.stderr.write(`Setup could not finish: ${error.message}\nRun again with --check after resolving this issue.\n`);
    process.exitCode = 1;
  }
}
