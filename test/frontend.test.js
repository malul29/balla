const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// One page, one big script: a duplicate `const` or a typo anywhere stops every tab from working.
test('the app page script parses (no syntax errors or duplicate declarations)', () => {
  for (const file of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(file === 'login.html' || scripts.length > 0, 'index.html has an inline script');
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: file }), file);
  }
});

test('SKU and Surat Pemesanan offer an image-only payment proof upload', async () => {
  const { JSDOM } = await import('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const document = new JSDOM(html).window.document;
  for (const form of ['sk', 'su']) {
    const proof = document.querySelector(`#${form} .upl[data-kind="bukti"]`);
    assert.ok(proof, form);
    assert.equal(proof.hasAttribute('data-images-only'), true, form);
  }
});

test('SKU and Surat Pemesanan accept a PDF or image work-status document', async () => {
  const { JSDOM } = await import('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const document = new JSDOM(html).window.document;
  for (const form of ['sk', 'su']) {
    const work = document.querySelector(`#${form} .upl[data-kind="pekerjaan"]`);
    assert.ok(work, form);
    assert.equal(work.hasAttribute('data-images-only'), false, form);
  }
});

test('unit preview includes payment attachment and escaped multiline notes only for instalment methods', async () => {
  const { JSDOM } = await import('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /\.jd tr:first-child th \{ border-top-width:2px; \}/);
  assert.match(html, /\.jd tr:last-child td \{ border-bottom-width:2px; \}/);
  assert.match(html, /\.jd th:first-child, #paper \.jd td:first-child \{ border-left-width:2px; \}/);
  assert.match(html, /\.jd th:last-child, #paper \.jd td:last-child \{ border-right-width:2px; \}/);
  const code = html.slice(html.indexOf('function jadwalHtml('), html.indexOf('/* mirrors lib/docs.js kwitansi() */'));
  const dom = new JSDOM('<body class="pv-on"><div id="paper"></div><div id="pvNote"></div><form id="sk"><input class="autono" value="TEST"></form><form id="su"><input class="autono" value="TEST"></form></body>');
  const document = dom.window.document;
  const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const context = vm.createContext({ document, Schedule: require('../lib/schedule'), curTab: 'sk',
    $: (selector, root = document) => root.querySelector(selector),
    data: {}, toJSON: () => context.data, esc: escape, ph: escape, tglID: String, rp: String,
    terb: () => '', cb: () => '', luasHtml: () => '', UT: {}, FOOT: 'Footer', fit: () => {},
    NOTES: { unit: '' }, PV_META: { sk: { heading: 'SKU', label: 'SKU', reservasi: true }, su: { heading: 'SPU', label: 'SPU', reservasi: false } },
  });
  vm.runInContext(code, context);
  for (const tab of ['sk', 'su']) {
    context.curTab = tab;
    for (const tipe of ['kpr', 'tunai-bertahap', 'tunai-keras']) {
      context.data = { cara: { tipe }, jadwal: { kali: 2, catatan: '<img src=x>\nBaris kedua' } };
      vm.runInContext('draw()', context);
      const attachment = document.querySelector('.attachment-page');
      assert.equal(!!attachment, tipe !== 'tunai-keras');
      assert.equal(document.querySelectorAll('.jd').length, 1);
      assert.deepEqual([...document.querySelectorAll('.jd th')].map((th) => th.textContent), ['Tanggal Jatuh Tempo', 'Keterangan', 'Jumlah (Rp)']);
      if (attachment) {
        assert.ok(attachment.querySelector('.jd'));
        assert.equal(document.querySelector('.unit-page .pg-footer b').textContent, '1/4');
        assert.equal(attachment.querySelector('.pg-footer b').textContent, '2/4');
        assert.equal(attachment.querySelector('.payment-notes').textContent, '<img src=x>\nBaris kedua');
        assert.equal(attachment.querySelector('.payment-notes img'), null);
      }
      if (!attachment) assert.equal(document.querySelector('.unit-page .pg-footer b').textContent, '1/3');
    }
  }
});
