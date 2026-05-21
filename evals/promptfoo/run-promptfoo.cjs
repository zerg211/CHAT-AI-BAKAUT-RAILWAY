const path = require('node:path');
const { spawnSync } = require('node:child_process');

const promptfooIndexPath = require.resolve('promptfoo');
const promptfooRoot = path.resolve(path.dirname(promptfooIndexPath), '..', '..');
const promptfooEntrypoint = path.join(promptfooRoot, 'dist', 'src', 'entrypoint.js');

const result = spawnSync(process.execPath, [promptfooEntrypoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK || '1',
    PROMPTFOO_DISABLE_TELEMETRY: process.env.PROMPTFOO_DISABLE_TELEMETRY || '1',
    PROMPTFOO_DISABLE_UPDATE: process.env.PROMPTFOO_DISABLE_UPDATE || '1'
  }
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
