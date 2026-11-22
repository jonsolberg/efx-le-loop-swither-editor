/*
 * EFX-LE Editor — data model and SysEx protocol for the Musicom Lab EFX-LE.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * The EFX-LE keeps its user data as 512 blocks of 128 seven-bit bytes. A dump is 512 SysEx
 * messages of 138 bytes: F0 00 21 06 00 06 7F <block hi> <block lo> <128 data bytes> F7.
 * The format was worked out from Musicom Lab's EFX-LE Editor V1.41.
 *
 * Everything here works on a Uint8Array(65536) "image" (block * 128 + offset), so bytes the
 * editor doesn't know about are always kept as they are.
 */
(function (root) {
  'use strict';

  var BLOCKS = 512, BLK = 128, PKT = 138, SYX_SIZE = BLOCKS * PKT;   // 70,656 bytes
  var HEADER = [0xF0, 0x00, 0x21, 0x06, 0x00, 0x06, 0x7F];
  var REQUEST = [0xF0, 0x00, 0x21, 0x06, 0x00, 0x06, 0x10, 0xF7];    // "send me your data"

  var PRESETS = 360, GLOBAL_PRESET = 360, SONG0 = 361, SONGS = 99, SET0 = 460, SETS = 40, SET_LEN = 40;
  var GMIDI = 510, UTIL = 511;

  // offsets inside a preset block
  var P = { SW: 0, ROW0: 8, ROW1: 20, XPDL: 40, BPMF: 46, BPM: 47, PC: 48, CC: 80, TITLE: 104 };
  var TITLE_LEN = 12;

  /** The 18 switches of a preset, in the order of the IA1/IA2/IA3 pages (byte = i / 6, bit = i % 6). */
  var SWITCHES = [
    { id: 'L1', name: 'Loop 1' }, { id: 'L2', name: 'Loop 2' }, { id: 'L3', name: 'Loop 3' },
    { id: 'L4', name: 'Loop 4' }, { id: 'L5', name: 'Loop 5' }, { id: 'L6', name: 'Loop 6' },
    { id: 'OL', name: 'Output L' }, { id: 'OR', name: 'Output R' }, { id: 'F1', name: 'Function 1' },
    { id: 'F2', name: 'Function 2' }, { id: 'BI', name: 'Input buffer' }, { id: 'BM', name: 'Movable buffer' },
    { id: 'C1', name: 'MIDI CC 1' }, { id: 'C2', name: 'MIDI CC 2' }, { id: 'C3', name: 'MIDI CC 3' },
    { id: 'C4', name: 'MIDI CC 4' }, { id: 'C5', name: 'MIDI CC 5' }, { id: 'VL', name: 'Volume loop' }
  ];

  /** Routing items: low nibble of the routing bytes. */
  var LOOPS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'VL', 'BM'];
  var R_END = 12, R_NONE = 15, R_DRY = 11, F_SPILL = 0x10, F_MIX = 0x60;

  /** Global MIDI CC rows (block 510, 4 bytes each). */
  var GLOBAL_CC = [
    { id: 'L1', name: 'Loop 1' }, { id: 'L2', name: 'Loop 2' }, { id: 'L3', name: 'Loop 3' },
    { id: 'L4', name: 'Loop 4' }, { id: 'L5', name: 'Loop 5' }, { id: 'L6', name: 'Loop 6' },
    { id: 'VL', name: 'Volume loop' }, { id: 'OL', name: 'Output L' }, { id: 'OR', name: 'Output R' },
    { id: 'F1', name: 'Function 1' }, { id: 'F2', name: 'Function 2' }, { id: 'BI', name: 'Input buffer' },
    { id: 'BM', name: 'Movable buffer' }, { id: 'C1', name: 'C1' }, { id: 'C2', name: 'C2' }, { id: 'C3', name: 'C3' },
    { id: 'C4', name: 'C4' }, { id: 'C5', name: 'C5' }, { id: 'XPDL', name: 'Expression pedal', xpdl: true },
    { id: 'MT', name: 'Mute' }
  ];

  function range(a, b, f) { var r = []; for (var i = a; i <= b; i++) r.push(f ? f(i) : String(i)); return r; }

  /** Utility settings (block 511, byte i = index into the option list). */
  var UTILITY = [
    { id: 'opMode', name: 'Operating mode', opts: ['PRESET', 'SONG'].concat(range(1, 40, function (i) { return 'SET ' + i; })) },
    { id: 'clickless', name: 'Click-less', opts: ['OFF', 'BI CHANGE', 'ALWAYS ON'] },
    { id: 'holdBank', name: 'Hold "BANK DOWN"', opts: ['MUTE', 'BANK DOWN'] },
    { id: 'mutePos', name: 'Mute position', opts: ['VL.SEND', 'OUT.L/R', 'NO ASSIGN'] },
    { id: 'maxBank', name: 'Max bank number', opts: range(1, 72) },
    { id: 'dupPc', name: 'Duplicate PC', opts: ['NOT SEND', 'SEND'] },
    { id: 'syncWith', name: 'Tempo sync with', opts: ['OFF', 'MTC', 'F1', 'MTC+F1'] },
    { id: 'syncTime', name: 'Tempo sync time', opts: ['1 BAR', '2 BARS', 'CONTINUE'] },
    { id: 'xpdlRate', name: 'XPDL rate', opts: range(1, 50, function (i) { return i + ' ms'; }) },
    { id: 'fs1', name: 'Function switch 1', opts: ['LATCHED', 'MOMENTARY', 'REV LATCH'] },
    { id: 'fs2', name: 'Function switch 2', opts: ['LATCHED', 'MOMENTARY', 'REV LATCH'] },
    { id: 'isoOut', name: 'ISO-OUT source', opts: ['VL.SEND', 'OUT.L', 'OUT.R', 'POST.VL'] },
    { id: 'lp5Rtn', name: 'Loop 5 return', opts: ['MONO', 'STEREO'] },
    { id: 'lp6Rtn', name: 'Loop 6 return', opts: ['MONO', 'STEREO'] },
    { id: 'lp6Split', name: 'Loop 6 send R split', opts: ['OFF', 'ON'] },
    { id: 'globalPreset', name: 'Global preset', opts: ['DISABLE', 'ENABLE'] },
    { id: 'muteLoop', name: 'Mute → loop on', opts: ['NO ASSIGN', 'LOOP1', 'LOOP2', 'LOOP3', 'LOOP4', 'LOOP5', 'LOOP6'] },
    { id: 'bpmDisplay', name: 'BPM display', opts: ['OFF', 'ON'] },
    { id: 'group', name: 'Group select', opts: ['NO ASSIGN', 'C1 TO C2', 'C1 TO C3', 'C1 TO C4', 'C1 TO C5'] }
  ];

  // ------------------------------------------------------------------ raw access
  function at(blk, off) { return blk * BLK + off; }
  function get(img, blk, off) { return img[at(blk, off)]; }
  function set(img, blk, off, v) { img[at(blk, off)] = v & 0x7F; }
  function bit(v, b) { return (v >> b) & 1; }

  // ------------------------------------------------------------------ factory data (as the official editor's File › New)
  function defaultBlock(i) {
    var d = new Uint8Array(BLK), k;
    if (i <= GLOBAL_PRESET) {
      d[1] = 51;                                     // OL, OR, BI, BM on
      [0, 1, 2, 3, 7, 6, 4, 5].forEach(function (v, j) { d[P.ROW0 + j] = v; });   // L1 L2 L3 L4 BM VL L5 L6
      for (k = 0; k < 8; k++) d[P.ROW1 + k] = R_NONE;
      d[40] = 1; d[41] = 48; d[44] = 127;            // XPDL: global
      d[46] = 2; d[47] = 120;                        // BPM: global, 120
      for (k = 0; k < 8; k++) {                      // PC k on channel k+1; PC1 = preset number (presets 1–128)
        d[P.PC + k] = (i < 128 && k === 0) ? (k + 96) : (k + 112);
        d[P.PC + 8 + k] = (i < 128 && k === 0) ? i % 128 : 0;
        d[P.CC + k] = 16;                            // CC off, channel 1
      }
      var t = i === GLOBAL_PRESET ? ' GLOBAL PRST' : '  BK' + pad2(Math.floor(i / 5) + 1) + ' PRST' + (i % 5 + 1);
      for (k = 0; k < TITLE_LEN; k++) d[P.TITLE + k] = t.charCodeAt(k);
    } else if (i < SET0) {
      for (k = 0; k < 5; k++) { d[k * 8 + 2] = 1; d[k * 8 + 3] = 83; }   // preset 1, BPM = GLB (211)
      var s = '      SONG' + pad2(i - GLOBAL_PRESET);
      for (k = 0; k < TITLE_LEN; k++) d[48 + k] = s.charCodeAt(k);
    } else if (i < SET0 + SETS) {
      for (k = 0; k < BLK; k++) d[k] = k;
    } else if (i === GMIDI) {
      for (k = 0; k < 20; k++) { d[k * 4] = 16; d[k * 4 + 2] = 127; }
    } else if (i === UTIL) {
      [0, 1, 1, 1, 71, 1, 1, 0, 9, 0, 0, 1, 0, 0, 0, 1].forEach(function (v, j) { d[j] = v; });
    }
    return d;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function createDefault() {
    var img = new Uint8Array(BLOCKS * BLK);
    for (var i = 0; i < BLOCKS; i++) img.set(defaultBlock(i), i * BLK);
    return img;
  }

  // ------------------------------------------------------------------ SysEx packets and .syx files
  function packet(img, i) {
    var p = new Uint8Array(PKT);
    p.set(HEADER, 0); p[7] = i >> 7; p[8] = i & 0x7F;
    p.set(img.subarray(i * BLK, i * BLK + BLK), 9);
    p[PKT - 1] = 0xF7;
    return p;
  }

  /** Returns {index, data} for one EFX-LE data message, or null if it isn't one. */
  function parsePacket(msg) {
    if (!msg || msg.length !== PKT || msg[PKT - 1] !== 0xF7) return null;
    for (var k = 0; k < HEADER.length; k++) if (msg[k] !== HEADER[k]) return null;
    var i = msg[7] * 128 + msg[8];
    if (i >= BLOCKS) return null;
    return { index: i, data: msg.subarray ? msg.subarray(9, 9 + BLK) : msg.slice(9, 9 + BLK) };
  }

  function toSyx(img) {
    var out = new Uint8Array(SYX_SIZE);
    for (var i = 0; i < BLOCKS; i++) out.set(packet(img, i), i * PKT);
    return out;
  }

  /** Splits a byte stream into SysEx messages (F0 … F7). */
  function splitSysex(bytes) {
    var msgs = [], start = -1;
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xF0) start = i;
      else if (bytes[i] === 0xF7 && start >= 0) { msgs.push(bytes.subarray(start, i + 1)); start = -1; }
    }
    return msgs;
  }

  /** Reads a .syx file (or any capture of a dump). Throws an Error with a readable message. */
  function fromSyx(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var img = new Uint8Array(BLOCKS * BLK), seen = new Uint8Array(BLOCKS), n = 0;
    splitSysex(bytes).forEach(function (m) {
      var p = parsePacket(m);
      if (!p) return;
      for (var k = 0; k < BLK; k++) if (p.data[k] > 127) throw new Error('Invalid data in block ' + p.index + '.');
      img.set(p.data, p.index * BLK);
      if (!seen[p.index]) { seen[p.index] = 1; n++; }
    });
    if (n === 0) throw new Error('This is not an EFX-LE data file.');
    if (n < BLOCKS) throw new Error('The file is incomplete: ' + n + ' of ' + BLOCKS + ' blocks.');
    return img;
  }

  // ------------------------------------------------------------------ text
  function getText(img, blk, off) {
    var s = '';
    for (var k = 0; k < TITLE_LEN; k++) { var c = get(img, blk, off + k); s += (c > 31 && c < 126) ? String.fromCharCode(c) : ' '; }
    return s;
  }
  function cleanText(s) {
    s = String(s || '');
    var out = '';
    for (var k = 0; k < TITLE_LEN; k++) {
      var c = k < s.length ? s.charCodeAt(k) : 32;
      out += (c < 32 || c > 125) ? ' ' : String.fromCharCode(c);
    }
    return out;
  }
  function setText(img, blk, off, s) {
    s = cleanText(s);
    for (var k = 0; k < TITLE_LEN; k++) set(img, blk, off + k, s.charCodeAt(k));
  }

  // ------------------------------------------------------------------ presets
  function presetName(p) {
    if (p === GLOBAL_PRESET) return 'GLOBAL';
    return pad2(Math.floor(p / 5) + 1) + '-' + (p % 5 + 1);
  }
  function title(img, p) { return getText(img, p, P.TITLE); }
  function setTitle(img, p, s) { setText(img, p, P.TITLE, s); }

  function sw(img, p, i) { return bit(get(img, p, P.SW + Math.floor(i / 6)), i % 6) === 1; }
  function setSw(img, p, i, on) {
    var o = P.SW + Math.floor(i / 6), v = get(img, p, o), m = 1 << (i % 6);
    set(img, p, o, on ? (v | m) : (v & ~m));
  }

  // 7-bit storage of values 0–255: low 7 bits in the value byte, bit 7 as a flag in a "control" byte.
  function big(ctrl, flagBit, v) { return v + (bit(ctrl, flagBit) ? 128 : 0); }

  /** Program Change i (0–7): ch 1–16, num 1–128 or null (OFF), msb/lsb 0–127 or null. */
  function pc(img, p, i) {
    var c = get(img, p, P.PC + i);
    var num = big(c, 4, get(img, p, P.PC + 8 + i)), msb = big(c, 5, get(img, p, P.PC + 16 + i)), lsb = big(c, 6, get(img, p, P.PC + 24 + i));
    return { ch: (c & 15) + 1, num: num >= 128 ? null : num + 1, msb: msb >= 128 ? null : msb, lsb: lsb >= 128 ? null : lsb };
  }
  function setPc(img, p, i, v) {
    var num = v.num == null ? 128 : v.num - 1, msb = v.msb == null ? 128 : v.msb, lsb = v.lsb == null ? 128 : v.lsb;
    set(img, p, P.PC + i, ((v.ch - 1) & 15) | (num >= 128 ? 16 : 0) | (msb >= 128 ? 32 : 0) | (lsb >= 128 ? 64 : 0));
    set(img, p, P.PC + 8 + i, num); set(img, p, P.PC + 16 + i, msb); set(img, p, P.PC + 24 + i, lsb);
  }

  /** Control Change i (0–7): ch 1–16, num 0–127 or null (OFF), val 0–127. */
  function cc(img, p, i) {
    var c = get(img, p, P.CC + i), num = big(c, 4, get(img, p, P.CC + 8 + i));
    return { ch: (c & 15) + 1, num: num >= 128 ? null : num, val: get(img, p, P.CC + 16 + i) };
  }
  function setCc(img, p, i, v) {
    var num = v.num == null ? 128 : v.num;
    set(img, p, P.CC + i, ((v.ch - 1) & 15) | (num >= 128 ? 16 : 0));
    set(img, p, P.CC + 8 + i, num); set(img, p, P.CC + 16 + i, v.val);
  }

  /** XPDL: glb (use the global XPDL), ch, num (null = OFF), beg (0–127, 'OFF' or 'PDL'), max, min. */
  function xpdl(img, p) {
    var c = get(img, p, P.XPDL + 1), num = big(c, 4, get(img, p, P.XPDL + 2)), beg = big(c, 5, get(img, p, P.XPDL + 3));
    return {
      glb: get(img, p, P.XPDL) >= 1, ch: (c & 15) + 1, num: num >= 128 ? null : num,
      beg: beg === 128 ? 'OFF' : beg === 129 ? 'PDL' : beg, max: get(img, p, P.XPDL + 4), min: get(img, p, P.XPDL + 5)
    };
  }
  function setXpdl(img, p, v) {
    var num = v.num == null ? 128 : v.num, beg = v.beg === 'OFF' ? 128 : v.beg === 'PDL' ? 129 : v.beg;
    set(img, p, P.XPDL, v.glb ? 1 : 0);
    set(img, p, P.XPDL + 1, ((v.ch - 1) & 15) | (num >= 128 ? 16 : 0) | (beg >= 128 ? 32 : 0));
    set(img, p, P.XPDL + 2, num); set(img, p, P.XPDL + 3, beg); set(img, p, P.XPDL + 4, v.max); set(img, p, P.XPDL + 5, v.min);
  }

  /** Preset BPM: glb (use the global BPM), bpm 40–209 or null (OFF). */
  function bpm(img, p) {
    var f = get(img, p, P.BPMF), v = big(f, 0, get(img, p, P.BPM));
    return { glb: bit(f, 1) === 1, bpm: (v < 40 || v > 209) ? null : v };
  }
  function setBpm(img, p, v) {
    var b = v.bpm == null ? 210 : v.bpm;
    set(img, p, P.BPMF, (v.glb ? 2 : 0) | (b >= 128 ? 1 : 0));
    set(img, p, P.BPM, b);
  }

  // ------------------------------------------------------------------ routing
  /*
   * Two rows of 8 columns (bytes 8–15 and 20–27). The signal runs through the columns from left to right.
   * Top row: loop number (0–7 = L1–L6, VL, BM), +0x10 = spill-over, +0x60 = mixer; 12 = end.
   * Bottom row: 15 = nothing; under a mixer column: the loop in parallel, or 11 = the dry signal.
   * As a list: [{a: loop, spill: bool, mix: bool, b: loop or null (dry)}].
   */
  function routing(img, p) {
    var nodes = [], seen = {}, ok = true;
    for (var c = 0; c < 8; c++) {
      var t = get(img, p, P.ROW0 + c), u = get(img, p, P.ROW1 + c), a = t & 15;
      if (a === R_END) break;
      var mix = (t & F_MIX) === F_MIX, spill = !mix && (t & F_SPILL) === F_SPILL;
      if (a > 7 || ((t & F_MIX) && !mix) || (mix && (t & F_SPILL))) { ok = false; break; }
      var n = { a: a, spill: spill, mix: mix, b: null };
      if (mix) { if (u === R_DRY) n.b = null; else if (u <= 7) n.b = u; else { ok = false; break; } }
      nodes.push(n);
      [n.a, n.b].forEach(function (x) { if (x == null) return; if (seen[x]) ok = false; seen[x] = 1; });
    }
    for (var k = 0; k < 8; k++) if (!seen[k]) ok = false;
    return { ok: ok, nodes: ok ? nodes : defaultRouting() };
  }
  function defaultRouting() { return [0, 1, 2, 3, 7, 6, 4, 5].map(function (a) { return { a: a, spill: false, mix: false, b: null }; }); }

  function setRouting(img, p, nodes) {
    for (var c = 0; c < 8; c++) {
      var n = nodes[c], t = R_END, u = R_NONE;
      if (n) {
        t = n.a | (n.mix ? F_MIX : 0) | (!n.mix && n.spill ? F_SPILL : 0);
        if (n.mix) u = n.b == null ? R_DRY : n.b;
      }
      set(img, p, P.ROW0 + c, t); set(img, p, P.ROW1 + c, u);
    }
  }

  function canMix(a) { return a >= 0 && a <= 5; }   // the volume loop and the movable buffer can't be mixed or spilled

  /**
   * How many of the two internal mixers a routing uses. Parallel blocks and spill-over each use one; a stereo
   * return (loop 5/6 set to STEREO) at the end of the chain needs a second mixer channel.
   */
  function mixersUsed(nodes, lp5Stereo, lp6Stereo) {
    function stereo(x) { return (x === 4 && lp5Stereo) || (x === 5 && lp6Stereo); }
    var used = 0;
    nodes.forEach(function (n, k) {
      if (!n.mix && !n.spill) return;
      used++;
      var st = stereo(n.a) || (n.mix && stereo(n.b));
      if (!st) return;
      for (var j = k + 1; j < nodes.length; j++) if (!stereo(nodes[j].a) || nodes[j].mix) return;
      used++;
    });
    return used;
  }

  // ------------------------------------------------------------------ songs and sets
  function songBlock(s) { return SONG0 + s; }
  function songTitle(img, s) { return getText(img, songBlock(s), 48); }
  function setSongTitle(img, s, t) { setText(img, songBlock(s), 48, t); }
  /** Song s, preset k (0–4): preset 0–360, bpm 40–209, 'PST' or 'GLB'. */
  function songPreset(img, s, k) {
    var b = songBlock(s), pr = get(img, b, k * 8) * 128 + get(img, b, k * 8 + 1), v = get(img, b, k * 8 + 2) * 128 + get(img, b, k * 8 + 3);
    return { preset: Math.min(pr, GLOBAL_PRESET), bpm: v === 210 ? 'PST' : v === 211 ? 'GLB' : (v >= 40 && v <= 209 ? v : 'GLB') };
  }
  function setSongPreset(img, s, k, v) {
    var b = songBlock(s), bp = v.bpm === 'PST' ? 210 : v.bpm === 'GLB' ? 211 : v.bpm;
    set(img, b, k * 8, v.preset >> 7); set(img, b, k * 8 + 1, v.preset & 127);
    set(img, b, k * 8 + 2, bp >> 7); set(img, b, k * 8 + 3, bp & 127);
  }
  function setSong(img, n, k) { return Math.min(get(img, SET0 + n, k), SONGS - 1); }
  function setSetSong(img, n, k, s) { set(img, SET0 + n, k, s); }

  // ------------------------------------------------------------------ global MIDI and utility
  /** Global CC row i: ch 1–16, num, on, off (0–127 or null = OFF). For XPDL, on = max and off = min. */
  function gcc(img, i) {
    var c = get(img, GMIDI, i * 4);
    function v(k, b) { var x = big(c, b, get(img, GMIDI, i * 4 + k)); return x >= 128 ? null : x; }
    return { ch: (c & 15) + 1, num: v(1, 4), on: v(2, 5), off: v(3, 6) };
  }
  function setGcc(img, i, x) {
    function r(v) { return v == null ? 128 : v; }
    var n = r(x.num), on = r(x.on), off = r(x.off);
    set(img, GMIDI, i * 4, ((x.ch - 1) & 15) | (n >= 128 ? 16 : 0) | (on >= 128 ? 32 : 0) | (off >= 128 ? 64 : 0));
    set(img, GMIDI, i * 4 + 1, n); set(img, GMIDI, i * 4 + 2, on); set(img, GMIDI, i * 4 + 3, off);
  }
  /** MIDI receive channel 1–16, or null ("--"). */
  function midiInCh(img) { var v = get(img, GMIDI, 120); return v >= 16 ? null : v + 1; }
  function setMidiInCh(img, ch) { set(img, GMIDI, 120, ch == null ? 16 : ch - 1); }
  function midiThru(img) { return get(img, GMIDI, 121) === 1; }
  function setMidiThru(img, on) { set(img, GMIDI, 121, on ? 1 : 0); }
  function util(img, i) { var v = get(img, UTIL, i); return v < UTILITY[i].opts.length ? v : 0; }
  function setUtil(img, i, v) { set(img, UTIL, i, v); }

  // ------------------------------------------------------------------ blocks
  function block(img, i) { return img.slice(i * BLK, i * BLK + BLK); }
  function setBlock(img, i, data) { img.set(data, i * BLK); }
  function copyRoutingToAll(img, from) {
    for (var p = 0; p <= GLOBAL_PRESET; p++) if (p !== from) img.set(img.subarray(at(from, 8), at(from, 32)), at(p, 8));
  }
  /** Blocks that differ between two images. */
  function changedBlocks(a, b) {
    var out = [];
    for (var i = 0; i < BLOCKS; i++) {
      for (var k = i * BLK; k < i * BLK + BLK; k++) if (a[k] !== b[k]) { out.push(i); break; }
    }
    return out;
  }

  // ------------------------------------------------------------------ MIDI control (manual chapter 6)
  var LOOP_CC = { L1: 64, L2: 65, L3: 66, L4: 67, L5: 68, L6: 69, VL: 70, OL: 71, OR: 72, F1: 73, F2: 74 };
  /** Bank select (CC#0) and Program Change for preset p (0–359) in preset mode. */
  function presetSelect(p) { return { bank: p >> 7, pc: p & 127 }; }

  var EFX = {
    BLOCKS: BLOCKS, BLK: BLK, PKT: PKT, SYX_SIZE: SYX_SIZE, HEADER: HEADER, REQUEST: REQUEST,
    PRESETS: PRESETS, GLOBAL_PRESET: GLOBAL_PRESET, SONG0: SONG0, SONGS: SONGS, SET0: SET0, SETS: SETS, SET_LEN: SET_LEN,
    GMIDI: GMIDI, UTIL: UTIL, P: P, TITLE_LEN: TITLE_LEN,
    SWITCHES: SWITCHES, LOOPS: LOOPS, GLOBAL_CC: GLOBAL_CC, UTILITY: UTILITY, LOOP_CC: LOOP_CC,
    get: get, set: set, createDefault: createDefault, defaultBlock: defaultBlock,
    packet: packet, parsePacket: parsePacket, toSyx: toSyx, fromSyx: fromSyx, splitSysex: splitSysex,
    cleanText: cleanText, presetName: presetName, title: title, setTitle: setTitle, sw: sw, setSw: setSw,
    pc: pc, setPc: setPc, cc: cc, setCc: setCc, xpdl: xpdl, setXpdl: setXpdl, bpm: bpm, setBpm: setBpm,
    routing: routing, setRouting: setRouting, defaultRouting: defaultRouting, canMix: canMix, mixersUsed: mixersUsed,
    songTitle: songTitle, setSongTitle: setSongTitle, songPreset: songPreset, setSongPreset: setSongPreset,
    setSong: setSong, setSetSong: setSetSong,
    gcc: gcc, setGcc: setGcc, midiInCh: midiInCh, setMidiInCh: setMidiInCh, midiThru: midiThru, setMidiThru: setMidiThru,
    util: util, setUtil: setUtil, block: block, setBlock: setBlock, copyRoutingToAll: copyRoutingToAll,
    changedBlocks: changedBlocks, presetSelect: presetSelect
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = EFX; else root.EFX = EFX;
})(this);
