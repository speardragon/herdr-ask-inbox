#!/usr/bin/env node

import { installHooks, resolveCliOptions } from '../src/installer.mjs';

try {
  const result = await installHooks(await resolveCliOptions());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`ask-inbox hook install failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
}
