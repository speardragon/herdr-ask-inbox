#!/usr/bin/env node

import { hookStatus, resolveCliOptions } from '../src/installer.mjs';

try {
  const result = await hookStatus(await resolveCliOptions());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`herdr-question hook status failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
}
