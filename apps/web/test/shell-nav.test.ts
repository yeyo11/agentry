import assert from 'node:assert/strict';
import test from 'node:test';
import { House } from 'lucide-react';
import { isActive, type NavItem } from '../src/components/shell/nav.ts';

// Gap 22 of orchestration 6: a project's page and its tabs live at `/`, yet they are one of the
// projects, so the sidebar marks Projects and the phone's tab bar "More", as the references draw it.

const item = (to: string): NavItem => ({ to, label: to, icon: House });
const home = item('/');
const projects = item('/projects');
const chats = item('/chats');

test("a project's page marks Projects, not Home", () => {
  assert.equal(isActive(home, '/', true), false);
  assert.equal(isActive(projects, '/', true), true);
  assert.equal(isActive(chats, '/', true), false);
});

test('Home with no project is Home, and every other page keeps its own section', () => {
  assert.equal(isActive(home, '/', false), true);
  assert.equal(isActive(projects, '/', false), false);
  assert.equal(isActive(projects, '/projects', false), true);
  assert.equal(isActive(projects, '/projects/p1/assistant', false), true);
  assert.equal(isActive(chats, '/chats/c1', true), true, 'the flag is about `/` alone');
  assert.equal(isActive(projects, '/chats/c1', true), false);
  assert.equal(isActive(home, '/chats', false), false);
});
