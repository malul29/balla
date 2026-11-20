const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const docs = require('../lib/docs');
const Schedule = require('../lib/schedule');

test('payment attachment follows each letter for both unit documents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balla-schedule-test-'));
  try {
    for (const build of [docs.suratKonfirmasi, docs.suratPemesanan]) {
      for (const tipe of ['tunai-keras', 'tunai-bertahap', 'kpr', undefined]) {
        const file = path.join(dir, 'letter.docx');
        fs.writeFileSync(file, await build({ no: 'TEST', nama: 'Pemesan Uji', cara: { tipe }, jadwal: { kali: 12, mulai: '2026-11-20', catatan: 'Catatan pembayaran uji\nBaris kedua'  } }));
        const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const footers = execFileSync('unzip', ['-p', file, 'word/footer*.xml'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const attached = ['tunai-bertahap', 'kpr'].includes(tipe);
        const total = attached ? 4 : 3;
        for (let page = 1; page <= total; page++) assert.ok(footers.includes(`${page}/${total}`), `footer ${page}/${total}`);
        assert.equal(xml.split('LAMPIRAN JADWAL PEMBAYARAN').length - 1, attached ? 3 : 0);
        assert.equal(xml.split(Schedule.attachmentNotice).length - 1, attached ? 3 : 0);
        const sections = xml.split('</w:sectPr>');
        assert.equal(sections[0].includes('Tanggal Jatuh Tempo'), !attached);
        const scheduleSection = attached ? sections[1] : sections[0];
        assert.ok(scheduleSection.indexOf('Tanggal Jatuh Tempo') < scheduleSection.indexOf('Keterangan'));
        if (attached) {
          assert.ok(sections[1].includes('LAMPIRAN JADWAL PEMBAYARAN'));
          assert.ok(sections[1].includes('Tanggal Jatuh Tempo'));
          assert.ok(sections[1].includes('Catatan pembayaran uji'));
          assert.ok(sections[1].includes('Baris kedua'));
          assert.ok(!sections[0].includes('Catatan pembayaran uji'));
          assert.ok(sections[1].includes(tipe === 'kpr' ? 'Uang Muka 12/12' : 'Angsuran 10/10'));
        }
      }
    }
    assert.equal(Schedule.hasAttachment({ blank: true, cara: { tipe: 'kpr' } }), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
