import assert from 'node:assert/strict';
import { access, constants, readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../herdr-plugin.toml', import.meta.url);

test('manifest references existing entrypoints and declares all operator actions', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const file of [
    'bin/open.mjs',
    'bin/popup.mjs',
    'bin/install-hooks.mjs',
    'bin/status.mjs',
    'bin/uninstall-hooks.mjs',
  ]) {
    assert.match(text, new RegExp(file.replace('.', '\\.')));
    await access(new URL(`../${file}`, import.meta.url), constants.R_OK);
  }
  for (const action of ['open', 'install-hooks', 'hook-status', 'uninstall-hooks']) {
    assert.match(text, new RegExp(`id = "${action}"`));
  }
  assert.match(text, /placement = "popup"/);
  assert.doesNotMatch(text, /\["bash", "-c"/);
  // v2 is hook-driven: no event handler, and the old event entrypoint is gone.
  assert.doesNotMatch(text, /agent_status_changed/);
  await assert.rejects(access(new URL('../bin/event.mjs', import.meta.url), constants.R_OK));
});

test('manifest build pipeline checks Node, tests, and idempotently installs hooks', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "test"\]/);
  assert.match(text, /command = \["node", "bin\/install-hooks\.mjs"\]/);
});

test('operator README uses herdr 0.7.5 action argument order', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const action of ['hook-status', 'open', 'install-hooks', 'uninstall-hooks']) {
    assert.match(text, new RegExp(`herdr plugin action invoke ${action} --plugin cdragon\\.ask-inbox`));
  }
});
