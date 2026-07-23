#!/usr/bin/env node

import { resolveCliOptions, uninstallHooks } from '../src/installer.mjs';

try {
  const result = await uninstallHooks(await resolveCliOptions());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`herdr-question hook uninstall failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
}
