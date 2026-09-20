import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = fileURLToPath(new URL('../skills/paper-library-review/', import.meta.url));

/** The bundled review skill ships with the public plugin, so it must stay generic:
 * no personal paths, no private overlay content, no vendor-specific agent file. */
const FORBIDDEN = [
  { pattern: /shiqi/i, why: 'personal name' },
  { pattern: /vault|obsidian/i, why: 'private vault path' },
  { pattern: /_shared\/quality/, why: 'private quality record' },
  { pattern: /task-execution|academic-supervisor|assistant-router/, why: 'personal skill composition' },
  { pattern: /PhDPlan|CIVAL|HKUST|导师|我的阶段/, why: 'personal profile content' },
  { pattern: /\/Users\/shiqi/, why: 'absolute personal path' },
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

test('the bundled review skill carries no personal customisation', async () => {
  const paths = await files(skillRoot);
  assert.ok(paths.length >= 5, `Expected the skill and its references (${paths.length} files)`);
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    for (const { pattern, why } of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${path} contains ${why} (${pattern})`);
    }
    assert.ok(!source.includes('/Users/'), `${path} contains an absolute home path`);
  }
});

test('the review skill documents the auto-parse contract and its boundaries', async () => {
  const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /references\/auto-parse\.md/);
  assert.match(skill, /reviewProfile/);
  const auto = await readFile(join(skillRoot, 'references/auto-parse.md'), 'utf8');
  for (const required of ['needs-review', 'author_claim', 'not_comparable', '24,000', '8,000', 'reviewProfile']) {
    assert.ok(auto.includes(required), `auto-parse.md must document ${required}`);
  }
  assert.match(auto, /不会让整理作业失败/);
});
