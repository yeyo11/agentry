import assert from 'node:assert/strict';
import test from 'node:test';
import { frontmatterProblem } from '../src/pages/config/frontmatter.ts';

// An agent file the CLI cannot read is skipped without a word, so the editors check its frontmatter
// before saving it.

const agent = (head: string) => `---\n${head}\n---\n\nYou are a specialist.\n`;

test('an agent needs a closed frontmatter with its name and its description', () => {
  assert.equal(frontmatterProblem('agents', agent('name: reviewer\ndescription: Reviews code\ntools: Read, Grep')), null);
  assert.equal(frontmatterProblem('agents', 'You are a specialist.'), 'missing');
  assert.equal(frontmatterProblem('agents', '---\nname: reviewer\ndescription: Reviews code\n\nbody'), 'unclosed');
  assert.equal(frontmatterProblem('agents', agent('description: Reviews code')), 'name');
  assert.equal(frontmatterProblem('agents', agent('name: reviewer\ndescription: ""')), 'description');
  assert.equal(frontmatterProblem('agents', agent('name: reviewer\ndescription Reviews code')), 'line');
});

test('list items, block values, comments and colons inside a value are fields the CLI reads', () => {
  const head = 'name: reviewer\ndescription: Use it when: the diff is large\n# a comment\ntools:\n  - Read\n  - Grep\nnotes: |\n  more';
  assert.equal(frontmatterProblem('agents', agent(head)), null);
  assert.equal(frontmatterProblem('agents', `﻿${agent('name: a\ndescription: b')}`), null);
});

test('a command may have no frontmatter, a skill needs its description, and a workflow is a script', () => {
  assert.equal(frontmatterProblem('commands', 'Do the following with $ARGUMENTS'), null);
  assert.equal(frontmatterProblem('commands', '---\ndescription: x\n'), 'unclosed');
  assert.equal(frontmatterProblem('skills', agent('name: s')), 'description');
  assert.equal(frontmatterProblem('workflows', 'export const meta = {}'), null);
});
