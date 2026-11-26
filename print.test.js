import test from 'node:test';
import assert from 'node:assert/strict';
import { printHtml } from './print.js';

test('print: one block per line, text escaped, *bold* kept, empty line preserved', () => {
  const h = printHtml('*Shop <A>*\n\nTotal : 8 DH');
  assert.match(h, /<div dir="auto"><b>Shop &lt;A&gt;<\/b><\/div>/);
  assert.match(h, /<div dir="auto">&nbsp;<\/div>/);
  assert.match(h, /<div dir="auto">Total : 8 DH<\/div>/);
  assert.match(h, /size:80mm auto/);
  assert.equal(h.includes('<A>'), false);
});
