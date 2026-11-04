import test from 'node:test';
import assert from 'node:assert/strict';
import { md } from '../src/markdown.js';

test('bold markers become <strong>, not literal asterisks', () => {
  const html = md('**Powerplay Pandits (t1)** has four out.');
  assert.match(html, /<strong>Powerplay Pandits \(t1\)<\/strong>/);
  assert.ok(!html.includes('**'));
});

test('dash and asterisk bullets become a list, with paragraphs around it', () => {
  const html = md('Intro line\n-   First swap\n- Second swap\n\nClosing line');
  assert.match(html, /<ul class="md"><li>First swap<\/li><li>Second swap<\/li><\/ul>/);
  assert.match(html, /^<p>Intro line<\/p>/);
  assert.match(html, /<p>Closing line<\/p>$/);
});

test('model text can never inject HTML', () => {
  const html = md('<img src=x onerror=alert(1)> **<b>hi</b>** <script>x</script>');
  assert.ok(!/<img|<script|<b>/.test(html));
  assert.match(html, /&lt;img/);
});

test('plain text and empty input are safe', () => {
  assert.equal(md('Just text.'), '<p>Just text.</p>');
  assert.equal(md(''), '');
  assert.equal(md(undefined), '');
  assert.ok(!md('2 * 3 = 6 and a*b').includes('<em>'), 'a lone asterisk is not italics');
});
