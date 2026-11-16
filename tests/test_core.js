// コア部分のNodeテスト: node tests/test_core.js <ab1フォルダ> <出力フォルダ>
const fs = require('fs'), path = require('path');
const src = ['sanger_assembler.html', 'index.html'].map(f => path.join(__dirname, '..', f)).find(f => fs.existsSync(f));   // 公開版は index.html
const html = fs.readFileSync(src, 'utf8');
const a = html.indexOf('<script id="core">') + '<script id="core">'.length, b = html.indexOf('</script>', a);
const m = { exports: {} };
new Function('module', html.slice(a, b))(m);
const SA = m.exports;
const dir = process.argv[2], outDir = process.argv[3];
let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log('  FAIL: ' + msg); } };

function load(files) {
  const S = SA.newState();
  for (const f of files) { const r = SA.readFromAbif(new Uint8Array(fs.readFileSync(path.join(dir, f))), f); S.reads[r.id] = r; S.free.push(r.id); }
  return S;
}
function check(S, tag) {
  for (const cg of S.contigs) {
    ok(cg.cons.length === cg.width, tag + ': cons長≠width ' + cg.name);
    const used = new Uint8Array(cg.width);
    for (const id of cg.members) {
      const r = S.reads[id]; ok(r.contig === cg.id, tag + ': contig不整合');
      ok(r.cols.length === r.seq.length, tag + ': cols長 ' + r.name);
      for (let i = 0; i < r.cols.length; i++) { used[r.cols[i]] = 1; if (i && r.cols[i] <= r.cols[i - 1]) { ok(false, tag + ': cols非単調 ' + r.name); break; } }
      ok(r.cols[0] >= 0 && r.cols[r.cols.length - 1] < cg.width, tag + ': cols範囲外 ' + r.name);
    }
    ok(used.every(x => x), tag + ': 空カラムあり ' + cg.name);
  }
  for (const id in S.reads) { const r = S.reads[id], n = r.seq.length; ok(r.qual.length === n && r.pos.length === n && r.ed.length === n, tag + ': 配列長不整合 ' + r.name); ok(r.clipL + r.clipR < n, tag + ': clip'); if (!r.contig) ok(r.cols === null, tag + ': 未結合なのにcols'); }
}
function report(S) {
  for (const cg of S.contigs) {
    console.log(`  ${cg.name}: width=${cg.width} consensus=${cg.cons.replace(/-/g, '').length}bp gapcols=${(cg.cons.match(/-/g) || []).length}`);
    for (const id of cg.members) {
      const r = S.reads[id]; let mm = 0, len = 0;
      for (let i = r.clipL; i < r.seq.length - r.clipR; i++) { len++; const c = cg.cons[r.cols[i]]; if (c !== '-' && c !== r.seq[i]) mm++; }
      console.log(`    ${SA.dispName(r).padEnd(18)} cols ${r.cols[r.clipL]}-${r.cols[r.seq.length - r.clipR - 1]}  used=${len}  mismatch=${mm}`);
    }
  }
  console.log('  未結合: ' + S.free.map(id => S.reads[id].name).join(', '));
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.ab1')).sort();
console.log('files:', files.join(' '));
let S = load(files);
for (const id of S.free) { const r = S.reads[id]; console.log(`  ${r.name.padEnd(12)} n=${r.seq.length} trace=${r.tn} trim=${r.clipL}/${r.clipR} meanQ=${(r.qual.reduce((x, y) => x + y, 0) / r.seq.length).toFixed(1)}`); }

for (const [name, opt] of [['strict', { minOverlap: 50, minIdent: 0.97 }], ['normal', { minOverlap: 30, minIdent: 0.92 }], ['loose', { minOverlap: 20, minIdent: 0.80 }]]) {
  S = load(files); const t = Date.now(); const res = SA.assemble(S, null, opt);
  console.log(`\n[${name}] ${res.msg} (${Date.now() - t} ms)`); check(S, name); report(S);
}

// ---- 以降は normal の結果で編集テスト ----
S = load(files); SA.assemble(S, null, { minOverlap: 30, minIdent: 0.92 });
if (S.contigs.length) {
  const cg = S.contigs[0], id = cg.members[0], others = cg.members.slice(1).map(x => S.reads[x].seq);
  const r = () => S.reads[id]; const seq0 = r().seq, i = r().clipL + 100, consLen0 = cg.cons.replace(/-/g, '').length;
  const posBefore = r().pos[i + 5];
  SA.editReplace(S, id, i, i, seq0[i] === 'A' ? 'C' : 'A'); check(S, 'replace'); ok(r().seq.length === seq0.length && r().ed[i] === 1, 'replace');
  SA.editInsert(S, id, i, 'G', 'L'); check(S, 'insert'); ok(r().seq.length === seq0.length + 1 && r().seq[i] === 'G' && r().pos[i + 6] === posBefore, 'insert: 後続のピーク位置がずれた');
  ok(r().pos[i] > r().pos[i - 1] && r().pos[i] < r().pos[i + 1], 'insert: 挿入塩基のピーク位置');
  SA.editDelete(S, id, i, i); check(S, 'delete'); ok(r().seq.length === seq0.length && r().pos[i + 5] === posBefore, 'delete');
  SA.editDelete(S, id, i + 10, i + 14); check(S, 'delete5'); ok(r().seq.length === seq0.length - 5, 'delete5');
  ok(cg.members.slice(1).every((x, k) => S.reads[x].seq === others[k]), '他配列が変化');
  console.log(`\n編集後: width=${cg.width} cons=${cg.cons.replace(/-/g, '').length}bp (元 ${consLen0}bp)`);
  // 位置調整: ギャップを入れる→詰めるで元に戻る。他配列と塩基は不変
  {
    const snap = JSON.stringify(SA.serialize(S)), j = r().clipL + 200, c0 = r().cols[j], s0 = r().seq, oc = cg.members.slice(1).map(x => Array.from(S.reads[x].cols));
    ok(SA.shiftCols(S, id, j, 1), 'shift+1'); check(S, 'shift+1'); ok(r().seq === s0 && r().cols[j] - r().cols[j - 1] >= 2, 'shift+1: ギャップが入らない');
    ok(cg.members.slice(1).every((x, k) => S.reads[x].cols.every((c, q) => c === oc[k][q])), 'shift+1: 他配列が動いた');
    ok(SA.shiftCols(S, id, j, -1), 'shift-1'); check(S, 'shift-1'); ok(r().cols[j] === c0, 'shift-1: 位置が戻らない');
    ok(JSON.stringify(SA.serialize(S)) === snap, 'shift±1で不一致');
    // ギャップを2つ空け、右側ではなく左側のカラムを指定して塩基を入れる
    SA.shiftCols(S, id, j, 1); SA.shiftCols(S, id, j, 1); const g = r().cols[j - 1] + 1;
    SA.editInsert(S, id, j, 'T', 'L', g); check(S, 'gap入力'); ok(r().cols[j] === g && r().seq[j] === 'T' && r().cols[j + 1] === g + 2, 'gap入力: 指定カラムに入らない');
    SA.editDelete(S, id, j, j); SA.shiftCols(S, id, j, -1); SA.shiftCols(S, id, j, -1); ok(r().seq === s0 && r().cols[j] === c0, 'gap入力の後始末');
    SA.shiftCols(S, id, 0, -1); check(S, 'shift先頭-1'); SA.shiftCols(S, id, 0, 1); check(S, 'shift先頭+1');
  }
  // 逆相補2回で元に戻る
  const before = JSON.stringify(SA.serialize(S)); SA.flipContig(S, cg); check(S, 'flip'); ok(S.reads[id].rc === true, 'rcフラグ'); SA.flipContig(S, cg);
  ok(JSON.stringify(SA.serialize(S)) === before, 'flip×2で不一致');
  // コンティグから外す→選択アセンブルで戻す
  const last = cg.members[cg.members.length - 1]; SA.removeFromContig(S, [last]); check(S, 'remove');
  const res = SA.assemble(S, [last, cg.members[0]], { minOverlap: 30, minIdent: 0.92 }); check(S, 'reassemble-sel');
  console.log('選択アセンブル: ' + res.msg + ' → ' + S.contigs.map(c => c.name + '(' + c.members.length + ')').join(' '));
  ok(S.reads[last].contig === cg.id, '既存コンティグへ統合されない');
  // 保存→復元
  const json = JSON.stringify(SA.serialize(S)); const S2 = SA.deserialize(JSON.parse(json));
  ok(JSON.stringify(SA.serialize(S2)) === json, 'serialize往復'); ok(!!S2.reads[id].tr && S2.reads[id].tr.n === S.reads[id].tr.n, '波形復元');
  console.log('project json: ' + (json.length / 1e6).toFixed(2) + ' MB');
  // ab1 書き出し（編集あり・順向き と 逆相補）
  fs.mkdirSync(outDir, { recursive: true });
  const fwd = S.reads[id]; fs.writeFileSync(path.join(outDir, 'edited_fwd.ab1'), SA.exportAb1(fwd)); fs.writeFileSync(path.join(outDir, 'edited_fwd.txt'), fwd.seq);
  const fr = S.reads[S.free[0]] || S.reads[cg.members[1]]; const cp = { ...fr }; SA.rcRead(cp);
  const rcName = 'edited_rc_v2';   // 旧 edited_rc.ab1 はピーク位置重複あり（ATGCで警告）
  fs.writeFileSync(path.join(outDir, rcName + '.ab1'), SA.exportAb1(cp)); fs.writeFileSync(path.join(outDir, rcName + '.txt'), cp.seq);
  for (const f of ['edited_fwd.ab1', rcName + '.ab1']) {
    const e = SA.parseAbif(new Uint8Array(fs.readFileSync(path.join(outDir, f)))).get('PLOC', 1), dv = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    let strict = true; for (let k = 1; k < e.n; k++) if (dv.getUint16(k * 2) <= dv.getUint16(k * 2 - 2)) strict = false;
    ok(strict, f + ': ピーク位置が厳密増加でない');
  }
  const back = SA.readFromAbif(new Uint8Array(fs.readFileSync(path.join(outDir, 'edited_fwd.ab1'))), 'x.ab1');
  ok(back.seq === fwd.seq, 'ab1再読込: 配列'); ok(back.qual.every((q, k) => q === fwd.qual[k]), 'ab1再読込: 品質'); ok(back.pos.every((p, k) => Math.abs(p - fwd.pos[k]) <= 1), 'ab1再読込: ピーク位置');
  const back2 = SA.readFromAbif(new Uint8Array(fs.readFileSync(path.join(outDir, rcName + '.ab1'))), 'y.ab1'), t1 = SA.traces(cp);
  ok(back2.seq === cp.seq && back2.tr.A.every((v, k) => v === t1.A[k]) && back2.tr.G.every((v, k) => v === t1.G[k]), 'ab1(RC)再読込');
}
console.log(fail ? `\n${fail} 件 FAIL` : '\n全テスト OK');
process.exit(fail ? 1 : 0);
