import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark, ProgramMark, brandOf } from '@agentry/ui/components/BrandMark';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { BRAND_ART } from '../../../packages/ui/src/components/brand-art';

// The official marks of the programs Agentry names (design system, "Brand marks"): every program
// it knows has one, a tracker on a host wears its host's, and one it does not know keeps its monogram.

const PROGRAMS = ['github', 'gitlab', 'jira', 'youtrack', 'claude-code', 'codex', 'copilot', 'gemini', 'opencode'];

test('every program Agentry names has an official mark, with real art', () => {
  for (const id of PROGRAMS) {
    assert.ok(brandOf(id), `${id} has a mark`);
    const art = BRAND_ART[brandOf(id) ?? ''];
    assert.ok(art && art.shapes.length > 0 && art.shapes.every((s) => s.d.length > 10), `${id} has its art`);
    // A mark either takes the brand's colour from a token or draws its own
    assert.ok(art.ink === null || art.ink === `--brand-${brandOf(id)}`, `${id}'s colour is its token`);
  }
});

test('a tracker on a host wears its host\'s mark, and an unknown name has none', () => {
  assert.equal(brandOf('github-issues'), 'github');
  assert.equal(brandOf('gitlab-issues'), 'gitlab');
  assert.equal(brandOf('nope'), null);
  assert.equal(renderToStaticMarkup(<BrandMark id="nope" label="Nope" />), '');
});

test('a mark is an image with the label as its name, or decoration when the label is beside it', () => {
  const alone = renderToStaticMarkup(<BrandMark id="github" label="GitHub" />);
  assert.match(alone, /role="img"/);
  assert.match(alone, /aria-label="GitHub"/);
  const beside = renderToStaticMarkup(<BrandMark id="github" label="GitHub" decorative />);
  assert.match(beside, /aria-hidden="true"/);
  assert.doesNotMatch(beside, /role="img"/);
});

test('YouTrack draws its gradient with an id of its own, so two marks on a page do not share one', () => {
  const html = renderToStaticMarkup(
    <>
      <BrandMark id="youtrack" label="YouTrack" />
      <BrandMark id="youtrack" label="YouTrack" />
    </>,
  );
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(html.includes(`url(#${ids[0]})`) && html.includes(`url(#${ids[1]})`));
});

test('the agents and the integrations render the mark, and a program with none keeps its monogram', () => {
  for (const provider of ['claude-code', 'codex', 'copilot', 'gemini', 'opencode']) {
    assert.match(renderToStaticMarkup(<ProviderMark provider={provider} label={provider} decorative />), /class="brand-mark prov-mark"/, provider);
  }
  assert.match(renderToStaticMarkup(<ProgramMark id="jira" label="Jira" />), /data-brand="jira"/);
  assert.match(renderToStaticMarkup(<ProgramMark id="unknown" label="Unknown tool" />), /class="monogram"/);
});
