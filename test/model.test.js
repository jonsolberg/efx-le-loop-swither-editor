// Tests for web/js/efx.js — run with: node test/model.test.js
'use strict';
var assert = require('assert');
var E = require('../web/js/efx.js');
var n = 0;
function t(name, f) { f(); n++; console.log('ok', n, name); }

var img = E.createDefault();

t('default image has the factory layout', function () {
  assert.strictEqual(E.title(img, 0), '  BK01 PRST1');
  assert.strictEqual(E.title(img, 359), '  BK72 PRST5');
  assert.strictEqual(E.title(img, 360), ' GLOBAL PRST');
  assert.strictEqual(E.songTitle(img, 0), '      SONG01');
  assert.strictEqual(E.songTitle(img, 98), '      SONG99');
  assert.deepStrictEqual(E.pc(img, 0, 0), { ch: 1, num: 1, msb: null, lsb: null });
  assert.deepStrictEqual(E.pc(img, 127, 0), { ch: 1, num: 128, msb: null, lsb: null });
  assert.deepStrictEqual(E.pc(img, 128, 0), { ch: 1, num: null, msb: null, lsb: null });
  assert.deepStrictEqual(E.pc(img, 0, 3), { ch: 4, num: null, msb: null, lsb: null });
  assert.deepStrictEqual(E.cc(img, 0, 0), { ch: 1, num: null, val: 0 });
  assert.deepStrictEqual(E.xpdl(img, 0), { glb: true, ch: 1, num: null, beg: 'OFF', max: 127, min: 0 });
  assert.deepStrictEqual(E.bpm(img, 0), { glb: true, bpm: 120 });
  assert.deepStrictEqual(E.SWITCHES.filter(function (s, i) { return E.sw(img, 0, i); }).map(function (s) { return s.id; }), ['OL', 'OR', 'BI', 'BM']);
  assert.deepStrictEqual(E.songPreset(img, 4, 2), { preset: 0, bpm: 'GLB' });
  assert.strictEqual(E.setSong(img, 3, 7), 7);
  assert.deepStrictEqual(E.gcc(img, 0), { ch: 1, num: null, on: 127, off: 0 });
  assert.strictEqual(E.midiInCh(img), 1);
  assert.strictEqual(E.midiThru(img), false);
  assert.deepStrictEqual(E.UTILITY.map(function (u, i) { return u.opts[E.util(img, i)]; }),
    ['PRESET', 'BI CHANGE', 'BANK DOWN', 'OUT.L/R', '72', 'SEND', 'MTC', '1 BAR', '10 ms', 'LATCHED', 'LATCHED',
     'OUT.L', 'MONO', 'MONO', 'OFF', 'ENABLE', 'NO ASSIGN', 'OFF', 'NO ASSIGN']);
  var r = E.routing(img, 0);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.nodes.map(function (x) { return E.LOOPS[x.a]; }), ['L1', 'L2', 'L3', 'L4', 'BM', 'VL', 'L5', 'L6']);
});

t('.syx export is 70,656 bytes with valid packets and reads back', function () {
  var s = E.toSyx(img);
  assert.strictEqual(s.length, 70656);
  for (var i = 0; i < 512; i++) {
    var o = i * 138;
    assert.deepStrictEqual(Array.from(s.subarray(o, o + 7)), [0xF0, 0, 0x21, 6, 0, 6, 0x7F]);
    assert.strictEqual(s[o + 7] * 128 + s[o + 8], i);
    assert.strictEqual(s[o + 137], 0xF7);
  }
  assert.deepStrictEqual(E.fromSyx(s), img);
  assert.throws(function () { E.fromSyx(s.subarray(0, 138 * 100)); }, /incomplete/);
  assert.throws(function () { E.fromSyx(new Uint8Array(10)); }, /not an EFX-LE/);
});

t('values above 127 use the flag bits', function () {
  var m = E.createDefault();
  E.setPc(m, 5, 2, { ch: 16, num: 128, msb: 127, lsb: null });
  assert.deepStrictEqual(E.pc(m, 5, 2), { ch: 16, num: 128, msb: 127, lsb: null });
  assert.strictEqual(E.get(m, 5, 48 + 2), 15 | 64);       // num 128 is stored as 127 (no flag), lsb OFF flag
  E.setPc(m, 5, 2, { ch: 3, num: null, msb: null, lsb: 0 });
  assert.deepStrictEqual(E.pc(m, 5, 2), { ch: 3, num: null, msb: null, lsb: 0 });
  E.setCc(m, 5, 7, { ch: 9, num: 64, val: 127 });
  assert.deepStrictEqual(E.cc(m, 5, 7), { ch: 9, num: 64, val: 127 });
  E.setXpdl(m, 5, { glb: false, ch: 2, num: 11, beg: 'PDL', max: 100, min: 5 });
  assert.deepStrictEqual(E.xpdl(m, 5), { glb: false, ch: 2, num: 11, beg: 'PDL', max: 100, min: 5 });
  E.setXpdl(m, 5, { glb: false, ch: 2, num: 11, beg: 64, max: 100, min: 5 });
  assert.strictEqual(E.xpdl(m, 5).beg, 64);
  [40, 127, 128, 209, null].forEach(function (b) {
    E.setBpm(m, 5, { glb: false, bpm: b });
    assert.deepStrictEqual(E.bpm(m, 5), { glb: false, bpm: b });
  });
  E.setSongPreset(m, 10, 4, { preset: 360, bpm: 200 });
  assert.deepStrictEqual(E.songPreset(m, 10, 4), { preset: 360, bpm: 200 });
  E.setSongPreset(m, 10, 4, { preset: 200, bpm: 'PST' });
  assert.deepStrictEqual(E.songPreset(m, 10, 4), { preset: 200, bpm: 'PST' });
  E.setGcc(m, 19, { ch: 5, num: null, on: 100, off: null });
  assert.deepStrictEqual(E.gcc(m, 19), { ch: 5, num: null, on: 100, off: null });
  E.setMidiInCh(m, null); assert.strictEqual(E.midiInCh(m), null);
  E.setMidiInCh(m, 16); assert.strictEqual(E.midiInCh(m), 16);
  for (var k = 0; k < m.length; k++) assert.ok(m[k] < 128, 'byte ' + k + ' is 7-bit');
});

t('switches and titles', function () {
  var m = E.createDefault();
  E.setSw(m, 7, 17, true); E.setSw(m, 7, 6, false);
  assert.ok(E.sw(m, 7, 17)); assert.ok(!E.sw(m, 7, 6)); assert.ok(E.sw(m, 7, 7));
  E.setTitle(m, 7, 'Crunch ÅÄ{}~verylong');
  assert.strictEqual(E.title(m, 7), 'Crunch   {} ');
  E.setTitle(m, 7, 'abc'); assert.strictEqual(E.title(m, 7), 'abc         ');
});

t('routing: parallel, dry mix and spill-over round-trip', function () {
  var m = E.createDefault();
  var nodes = [
    { a: 0, spill: false, mix: false, b: null }, { a: 1, spill: true, mix: false, b: null },
    { a: 5, spill: false, mix: true, b: 4 }, { a: 7, spill: false, mix: false, b: null },
    { a: 2, spill: false, mix: true, b: null }, { a: 3, spill: false, mix: false, b: null },
    { a: 6, spill: false, mix: false, b: null }
  ];
  E.setRouting(m, 3, nodes);
  assert.deepStrictEqual(Array.from(m.subarray(3 * 128 + 8, 3 * 128 + 16)), [0, 17, 101, 7, 98, 3, 6, 12]);
  assert.deepStrictEqual(Array.from(m.subarray(3 * 128 + 20, 3 * 128 + 28)), [15, 15, 4, 15, 11, 15, 15, 15]);
  var r = E.routing(m, 3);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.nodes, nodes);
  assert.strictEqual(E.mixersUsed(nodes, false, false), 3);
});

t('routing: broken data is reported, not guessed', function () {
  var m = E.createDefault();
  E.set(m, 9, 8 + 3, 0);   // L1 twice, L4 missing
  assert.ok(!E.routing(m, 9).ok);
});

t('mixers: stereo return at the end of the chain needs a second mixer', function () {
  var tail = [0, 1, 2, 3, 7, 6].map(function (a) { return { a: a, spill: false, mix: false, b: null }; });
  var nodes = tail.concat([{ a: 4, spill: false, mix: false, b: null }, { a: 5, spill: true, mix: false, b: null }]);
  assert.strictEqual(E.mixersUsed(nodes, false, false), 1);
  assert.strictEqual(E.mixersUsed(nodes, false, true), 2);
  nodes[6].spill = true;   // L5 spill with stereo return, followed by stereo L6
  assert.strictEqual(E.mixersUsed(nodes, true, true), 4);
});

t('copy routing to all presets and changed blocks', function () {
  var m = E.createDefault(), o = m.slice();
  E.setRouting(m, 0, [{ a: 7, spill: false, mix: false, b: null }].concat([0, 1, 2, 3, 6, 4, 5].map(function (a) { return { a: a, spill: false, mix: false, b: null }; })));
  E.copyRoutingToAll(m, 0);
  assert.strictEqual(E.routing(m, 360).nodes[0].a, 7);
  assert.strictEqual(E.changedBlocks(o, m).length, 361);
  assert.strictEqual(E.title(m, 200), E.title(o, 200));
});

t('preset select message', function () {
  assert.deepStrictEqual(E.presetSelect(0), { bank: 0, pc: 0 });
  assert.deepStrictEqual(E.presetSelect(127), { bank: 0, pc: 127 });   // BANK26 P3 = PC 128
  assert.deepStrictEqual(E.presetSelect(128), { bank: 1, pc: 0 });     // BANK26 P4
  assert.deepStrictEqual(E.presetSelect(359), { bank: 2, pc: 103 });   // BANK72 P5 = PC 104
});

console.log('\nAll ' + n + ' tests passed.');
