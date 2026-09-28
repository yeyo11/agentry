import assert from 'node:assert/strict';
import test from 'node:test';
import { freeName, renamedContent } from '../src/pages/home/resources/names';

// "Create with AI" and "Suggest" may propose a name a file already has, which the API refuses to
// overwrite: the editor offers the first free one instead, and the file's own name follows it.

test('a proposed name already taken becomes the first free one after it', () => {
  assert.equal(freeName('reviewer', new Set()), 'reviewer');
  assert.equal(freeName('reviewer', new Set(['reviewer'])), 'reviewer-2');
  assert.equal(freeName('reviewer', new Set(['reviewer', 'reviewer-2', 'reviewer-3'])), 'reviewer-4');
  assert.equal(freeName('reviewer-2', new Set(['reviewer-2'])), 'reviewer-3');
  assert.ok(freeName('x'.repeat(64), new Set(['x'.repeat(64)])).length <= 64);
});

test("a rename carries into the frontmatter's name, and nowhere else", () => {
  const file = '---\nname: reviewer\ndescription: Reviews the reviewer role\n---\n\nname: reviewer stays in the body\n';
  assert.equal(renamedContent(file, 'reviewer', 'reviewer-2'), '---\nname: reviewer-2\ndescription: Reviews the reviewer role\n---\n\nname: reviewer stays in the body\n');
  assert.equal(renamedContent('---\nname: "reviewer"\n---\n', 'reviewer', 'r2'), '---\nname: "r2"\n---\n');
  assert.equal(renamedContent('---\nname: other\n---\n', 'reviewer', 'r2'), '---\nname: other\n---\n');
  assert.equal(renamedContent('no frontmatter', 'reviewer', 'r2'), 'no frontmatter');
});
