'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { sourceHash } = require('../../evals/acceptance/fingerprint.cjs');

test('schema and dependency changes invalidate evidence while unrelated private data does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bakaut-fingerprint-'));
  try {
    for (const d of ['src', 'sql', '.private']) fs.mkdirSync(path.join(root, d));
    const inputs = ['src/app.ts', 'sql/001.sql', 'package.json', 'package-lock.json'];
    for (const file of inputs) fs.writeFileSync(path.join(root, file), '{}');
    const original = sourceHash(root);
    fs.writeFileSync(path.join(root, '.private/unrelated'), 'must not participate');
    assert.equal(sourceHash(root), original);
    for (const file of inputs) {
      fs.writeFileSync(path.join(root, file), '{"changed":true}');
      assert.notEqual(sourceHash(root), original, file);
      fs.writeFileSync(path.join(root, file), '{}');
      assert.equal(sourceHash(root), original);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
