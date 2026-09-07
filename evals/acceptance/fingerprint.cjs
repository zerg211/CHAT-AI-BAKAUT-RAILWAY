'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Include executable code, schema and dependency resolution, using stable paths
// across Windows and Linux. Never include secrets or runtime/customer data.
function sourceHash(root = process.cwd()) {
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Source symlink');
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute)) walk(path.join(relative, name));
    else files.push(relative.split(path.sep).join('/'));
  }
  for (const entry of ['src', 'sql', 'package.json', 'package-lock.json']) walk(entry);
  const h = createHash('sha256');
  for (const file of files.sort()) {
    const data = fs.readFileSync(path.join(root, file));
    h.update(JSON.stringify([file, data.length])).update('\0').update(data);
  }
  return h.digest('hex');
}
function currentCommit(root = process.cwd()) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}
module.exports = { sourceHash, currentCommit };
