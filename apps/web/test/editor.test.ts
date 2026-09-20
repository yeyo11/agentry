import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EDITOR, diffCommand, editorLink, joinPath, mapPath, sanitizeEditor, shellQuote, templateProblem } from '../src/lib/editor.ts';

const vscode = DEFAULT_EDITOR;

test('the default template opens a file at a line without doubling the slash', () => {
  assert.equal(editorLink(vscode, '/home/ana/app/src/a.ts', 42), 'vscode://file/home/ana/app/src/a.ts:42');
});

test('without a line, the line and column parts go away with it', () => {
  assert.equal(editorLink(vscode, '/home/ana/app', undefined), 'vscode://file/home/ana/app');
  assert.equal(editorLink({ template: 'vscode://file/{path}:{line}:{column}' }, '/x/y.ts', 3), 'vscode://file/x/y.ts:3');
  assert.equal(editorLink({ template: 'vscode://file/{path}:{line}:{column}' }, '/x/y.ts', 3, 9), 'vscode://file/x/y.ts:3:9');
});

test('a template that puts the path after two slashes keeps the absolute path whole', () => {
  assert.equal(editorLink({ template: 'zed://{path}:{line}' }, '/x/y.ts', 1), 'zed:///x/y.ts:1');
});

test('the path is encoded, so a space or a hash cannot end the link early', () => {
  assert.equal(editorLink(vscode, '/my project/a#1.ts', 2), 'vscode://file/my%20project/a%231.ts:2');
});

test('container paths become host paths before the template is filled, on whole segments only', () => {
  const settings = { template: vscode.template, pathMap: [{ from: '/workspace', to: '/home/ana/code' }] };
  assert.equal(mapPath('/workspace/app/a.ts', settings.pathMap), '/home/ana/code/app/a.ts');
  assert.equal(mapPath('/workspace', settings.pathMap), '/home/ana/code');
  assert.equal(mapPath('/workspace-old/a.ts', settings.pathMap), '/workspace-old/a.ts');
  assert.equal(editorLink(settings, '/workspace/app/a.ts', 7), 'vscode://file/home/ana/code/app/a.ts:7');
});

test('the first row that matches wins, and a trailing slash on either side is harmless', () => {
  const map = [
    { from: '/workspace/special/', to: '/mnt/special/' },
    { from: '/workspace', to: '/home/ana' },
  ];
  assert.equal(mapPath('/workspace/special/x.ts', map), '/mnt/special/x.ts');
  assert.equal(mapPath('/workspace/other/x.ts', map), '/home/ana/other/x.ts');
});

test('a template that could run script or read a local file is never turned into a link', () => {
  for (const template of ['javascript:alert({path})', 'data:text/html,{path}', 'file:///{path}', 'JAVASCRIPT:{path}']) {
    assert.equal(templateProblem(template), 'unsafe', template);
    assert.equal(editorLink({ template }, '/x.ts', 1), null);
  }
  assert.equal(templateProblem('/just/a/path/{path}'), 'scheme');
  assert.equal(templateProblem('   '), 'empty');
  assert.equal(templateProblem('vscode://file/'), 'path');
  assert.equal(templateProblem('cursor://file/{path}:{line}'), null);
});

test('joinPath does not double or lose the slash between a directory and a file', () => {
  assert.equal(joinPath('/a/b/', '/c.ts'), '/a/b/c.ts');
  assert.equal(joinPath('/a/b', 'c/d.ts'), '/a/b/c/d.ts');
});

test('the diff command carries both files, mapped to the host and quoted for a shell', () => {
  const settings = { template: vscode.template, diffCommand: 'code --diff {left} {right}', pathMap: [{ from: '/workspace', to: '/home/ana' }] };
  assert.equal(diffCommand(settings, '/workspace/app/a.ts', '/workspace/app-wt/a.ts'), 'code --diff /home/ana/app/a.ts /home/ana/app-wt/a.ts');
  assert.equal(diffCommand(settings, "/w/it's here.ts", '/w/b.ts'), `code --diff '/w/it'\\''s here.ts' /w/b.ts`);
  assert.equal(diffCommand(vscode, '/a', '/b'), null, 'no button without a command');
  assert.equal(shellQuote('plain/path-1.ts'), 'plain/path-1.ts');
});

test('a stored value that is not a setting falls back to a working one', () => {
  assert.deepEqual(sanitizeEditor(null), DEFAULT_EDITOR);
  assert.deepEqual(sanitizeEditor('vscode://x'), DEFAULT_EDITOR);
  assert.deepEqual(sanitizeEditor({ template: '  ' }), DEFAULT_EDITOR);
  assert.deepEqual(
    sanitizeEditor({ template: 'cursor://file/{path}', diffCommand: ' ', pathMap: [{ from: '/a', to: '/b' }, { from: '', to: '/c' }, 'nope', { from: 1, to: 2 }] }),
    { template: 'cursor://file/{path}', pathMap: [{ from: '/a', to: '/b' }] },
  );
});
