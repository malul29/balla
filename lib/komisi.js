// Sales commission: a percentage of the money actually received for the unit (never more than what the schedule asks),
// so the commission grows with payments and stops at the rate x total due. Pure functions, no database.

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// rate: percent (e.g. 2.5). dibayar / tagihan: rupiah received / due for the unit.
function hakKomisi(rate, dibayar, tagihan) {
  const dasar = Math.min(num(dibayar), num(tagihan));
  return { dasar: Math.round(dasar), hak: Math.round((dasar * num(rate)) / 100) };
}

// Per sales person: earned from their deals, minus what was already paid out.
// deals: [{ sales_id, rate, dibayar, tagihan }], payouts: [{ sales_id, jumlah }]
function ringkas(deals, payouts) {
  const out = new Map();
  const of = (id) => { if (!out.has(id)) out.set(id, { sales_id: id, unit: 0, dasar: 0, hak: 0, sudah: 0, sisa: 0 }); return out.get(id); };
  for (const d of deals) { const x = of(d.sales_id), h = hakKomisi(d.rate, d.dibayar, d.tagihan); x.unit += 1; x.dasar += h.dasar; x.hak += h.hak; }
  for (const p of payouts) of(p.sales_id).sudah += num(p.jumlah);
  for (const x of out.values()) x.sisa = x.hak - x.sudah; // negative = paid out more than earned (e.g. after a cancellation)
  return out;
}

module.exports = { hakKomisi, ringkas };
