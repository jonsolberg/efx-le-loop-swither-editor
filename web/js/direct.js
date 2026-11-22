/*
 * EFX-LE Editor — Direct mode: play the pedal live from an on-screen copy of its panel.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * Uses the EFX-LE's MIDI implementation (manual chapter 6) on its receive channel:
 *   CC#0 (bank select) + Program Change select presets; CC#64–74 switch loops, outputs and function switches.
 * The pedal doesn't report its state over MIDI, so the screen follows the loaded data and your presses.
 * MUTE, TAP, the buffers and the C1–C5 switches can't be reached over MIDI.
 */
(function () {
  'use strict';
  var A, D = null, log = [], logEl = null, unlisten = null;
  var CTL = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'VL', 'OL', 'OR', 'F1', 'F2'];
  var SWIDX = { L1: 0, L2: 1, L3: 2, L4: 3, L5: 4, L6: 5, OL: 6, OR: 7, F1: 8, F2: 9, BI: 10, BM: 11, C1: 12, C2: 13, C3: 14, C4: 15, C5: 16, VL: 17 };
  // what the six switches (1, 2, 3, 4, 5/TAP, ▲) do on each IA page
  var PAGES = {
    ia1: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
    ia2: ['OL', 'OR', 'F1', 'F2', 'BI', 'BM'],
    ia3: ['C1', 'C2', 'C3', 'C4', 'C5', 'VL']
  };

  function E() { return A.E; }
  function h() { return A.h.apply(null, arguments); }

  function opModeFromData() {
    var v = E().util(A.S.img, 0);
    return v === 0 ? { mode: 'preset', set: 0 } : v === 1 ? { mode: 'song', set: 0 } : { mode: 'set', set: v - 2 };
  }
  function channel() { var c = E().midiInCh(A.S.img); return c == null ? 1 : c; }

  function init() {
    var om = opModeFromData();
    D = { page: 'preset', op: om.mode, setNo: om.set, bank: Math.floor(A.S.cur / 5) % 72, slot: null, pending: null, ch: channel(), st: {}, sent: false };
    loadStates(null);
  }

  /** How many "banks" the current operating mode has. */
  function bankCount() { return D.op === 'preset' ? E().util(A.S.img, 4) + 1 : D.op === 'song' ? E().SONGS : E().SET_LEN; }
  /** The preset (0–360) behind switch k in bank b. */
  function presetAt(b, k) {
    if (D.op === 'preset') return b * 5 + k;
    var song = D.op === 'song' ? b : E().setSong(A.S.img, D.setNo, b);
    return E().songPreset(A.S.img, song, k).preset;
  }
  function songAt(b) { return D.op === 'song' ? b : D.op === 'set' ? E().setSong(A.S.img, D.setNo, b) : null; }

  function loadStates(p) {
    var st = {};
    Object.keys(SWIDX).forEach(function (id) { st[id] = p == null ? false : E().sw(A.S.img, p, SWIDX[id]); });
    D.st = st;
  }

  // ------------------------------------------------------------------ MIDI out
  function send(bytes) { try { A.M.send(bytes); return true; } catch (e) { A.toast(e.message, true); return false; } }
  function selectSlot(k) {
    var b = D.pending != null ? D.pending : D.bank;
    var c = D.ch - 1, msg;
    if (D.op === 'preset') { var sp = E().presetSelect(b * 5 + k); msg = [0xB0 | c, 0, sp.bank]; send(msg); send([0xC0 | c, sp.pc]); }
    else { send([0xB0 | c, 0, b]); send([0xC0 | c, k]); }
    D.bank = b; D.pending = null; D.slot = k; D.page = 'preset';
    loadStates(presetAt(b, k));
  }
  function toggle(id) {
    if (!E().LOOP_CC[id]) { A.toast(id + ' can’t be switched over MIDI. Use the pedal itself.', true); return; }
    var on = !D.st[id];
    if (send([0xB0 | (D.ch - 1), E().LOOP_CC[id], on ? 127 : 0])) D.st[id] = on;
  }
  function bankStep(d) {
    var n = bankCount(), b = (D.pending != null ? D.pending : D.bank) + d;
    D.pending = (b + n) % n; D.page = 'preset';
  }

  // ------------------------------------------------------------------ actions from switches and keys
  function press(sw) {   // sw: 0–4 = 1…5/TAP, 'mode', 'down', 'up'
    if (sw === 'mode') { D.page = D.page === 'preset' ? 'ia1' : D.page === 'ia1' ? 'ia2' : D.page === 'ia2' ? 'ia3' : 'ia1'; D.pending = null; }
    else if (sw === 'down') { if (D.page !== 'preset') D.page = 'preset'; else bankStep(-1); }
    else if (sw === 'up') { if (D.page !== 'preset') toggle(PAGES[D.page][5]); else bankStep(1); }
    else if (D.page === 'preset') selectSlot(sw);
    else toggle(PAGES[D.page][sw]);
    redraw();
  }

  // ------------------------------------------------------------------ drawing
  var panel = null, extras = null;
  function lcdText() {
    var S = A.S, b = D.pending != null ? D.pending : D.bank, l1, l2, big = A.pad2(b + 1), sub = '';
    if (D.page !== 'preset') {
      var ids = PAGES[D.page];
      l1 = (D.page.toUpperCase() + ' ' + ids.join('')).slice(0, 12);
      l2 = ids.map(function (id) { return D.st[id] ? id : '..'; }).join('').slice(0, 12);
      return { big: big, sub: D.slot == null ? '' : String(D.slot + 1), l1: l1, l2: l2 };
    }
    if (D.pending != null || D.slot == null) {
      l1 = D.op === 'preset' ? 'BANK ' + A.pad2(b + 1) : E().songTitle(S.img, songAt(b));
      l2 = D.pending != null ? 'SELECT 1-5' : 'PRESS 1-5';
    } else {
      var p = presetAt(D.bank, D.slot);
      l1 = D.op === 'preset' ? E().title(S.img, p) : E().songTitle(S.img, songAt(D.bank));
      sub = String(D.slot + 1);
      l2 = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map(function (id, i) { return D.st[id] ? String(i + 1) : '.'; }).join('') +
        (D.st.OL ? 'L' : '.') + (D.st.OR ? 'R' : '.') + (D.st.F1 ? '1' : '.') + (D.st.F2 ? '2' : '.');
    }
    return { big: big, sub: sub, l1: l1, l2: l2 };
  }

  function ledFor(k) {   // k: 0–4 switches, 5 = ▲
    if (D.page === 'preset') {
      if (k === 5) return '';
      if (D.pending != null) return 'blue blink';
      return D.slot === k ? 'blue' : '';
    }
    return D.st[PAGES[D.page][k]] ? 'blue' : '';
  }

  function swLabel(k) {
    if (D.page === 'preset') return k < 5 ? String(k + 1) : '▲';
    return PAGES[D.page][k];
  }

  function buildPanel() {
    var p = h('div', { class: 'efxpanel' });
    p.appendChild(h('div', { class: 'efxbrand' }, h('span', { class: 'efxname' }, 'EFX·LE'), h('span', { class: 'efxsub' }, 'AUDIO CONTROLLER'), h('span', { class: 'efxmk' }, 'Musicom LAB')));
    p.appendChild(h('div', { class: 'efxlcd', id: 'dLcd' }));
    // top row: MODE, MUTE/▼, ▲
    var top = h('div', { class: 'efxtop' });
    [['mode', 'MODE', 'STORE'], ['down', 'MUTE/▼', 'EXIT'], ['up', '▲', 'UTILITY']].forEach(function (x, i) {
      top.appendChild(h('div', { class: 'efxsw' },
        h('div', { class: 'efxlbl' }, x[1]),
        h('button', { class: 'efxstomp', 'data-sw': x[0], 'aria-label': x[1], onclick: function () { press(x[0]); } }),
        h('div', { class: 'efxsmall' }, h('span', { class: 'led xs', id: 'dLedTop' + i }), ' ', x[2])));
      if (i < 2) top.appendChild(h('div', { class: 'efxjoin' }, h('span', null, i === 0 ? 'TAP' : 'BANK')));
    });
    p.appendChild(top);
    // bottom row: 1–5
    var bot = h('div', { class: 'efxbot' });
    var sub = [['OL', 'C1', 'ORDER ◀'], ['OR', 'C2', 'MIDI ▶'], ['F1', 'C3', 'COPY ▼'], ['F2', 'C4', 'TITLES ▲'], ['BI', 'C5', 'SONGSET']];
    for (var k = 0; k < 5; k++) (function (k) {
      bot.appendChild(h('div', { class: 'efxsw' },
        h('div', { class: 'efxlbl big' }, k === 4 ? '5/TAP' : String(k + 1)),
        h('div', { class: 'efxsmall' }, h('span', { class: 'led', id: 'dLed' + k }), ' ', sub[k][2]),
        h('button', { class: 'efxstomp', 'data-sw': k, 'aria-label': 'Switch ' + (k + 1), onclick: function () { press(k); } }),
        h('div', { class: 'efxfoot' }, h('span', null, 'L' + (k + 1)), h('span', { class: 'r' }, sub[k][0], h('br'), sub[k][1]))));
    })(k);
    p.appendChild(bot);
    p.appendChild(h('div', { class: 'efxl6' }, 'L6', h('br'), h('small', null, 'BM VL')));
    return p;
  }

  function redraw() {
    if (!panel) return;
    var t = lcdText(), lcd = document.getElementById('dLcd');
    lcd.innerHTML = '';
    lcd.appendChild(h('div', { class: 'lcdbig' }, t.big, h('small', null, t.sub)));
    lcd.appendChild(h('div', { class: 'lcdlines' }, h('div', null, pad(t.l1)), h('div', null, pad(t.l2))));
    for (var k = 0; k < 5; k++) document.getElementById('dLed' + k).className = 'led ' + ledFor(k);
    document.getElementById('dLedTop0').className = 'led xs' + (D.page !== 'preset' ? ' red' : '');
    document.getElementById('dLedTop2').className = 'led xs' + (D.page !== 'preset' && D.st[PAGES[D.page][5]] ? ' blue' : '');
    panel.querySelectorAll('.efxstomp').forEach(function (b) {
      var sw = b.dataset.sw, k = sw === 'up' ? 5 : +sw;
      var id = D.page !== 'preset' && (k >= 0 && k <= 5) ? PAGES[D.page][k] : null;
      b.classList.toggle('nomidi', !!id && !E().LOOP_CC[id]);
      b.title = sw === 'mode' ? 'MODE: switch page (preset, IA1 loops, IA2 outputs/functions, IA3 volume loop)' :
        sw === 'down' ? (D.page === 'preset' ? 'Bank down' : 'Back to presets') :
          sw === 'up' ? (D.page === 'preset' ? 'Bank up' : id + (E().LOOP_CC[id] ? '' : ' (not available over MIDI)')) :
            D.page === 'preset' ? 'Preset ' + (k + 1) : id + (E().LOOP_CC[id] ? '' : ' (not available over MIDI)');
    });
    if (extras) drawExtras();
  }
  function pad(s) { s = String(s || ''); while (s.length < 12) s += ' '; return s.slice(0, 12); }

  function drawExtras() {
    extras.innerHTML = '';
    var grid = h('div', { class: 'dtoggles' });
    CTL.forEach(function (id) {
      var on = !!D.st[id];
      grid.appendChild(h('button', { class: 'fxsw small' + (on ? ' on' : ''), onclick: function () { toggle(id); redraw(); }, title: 'CC#' + E().LOOP_CC[id] },
        h('span', { class: 'swled' }), h('span', { class: 'swid' }, id), h('span', { class: 'swnm' }, 'CC#' + E().LOOP_CC[id])));
    });
    extras.appendChild(grid);
  }

  function addLog(d, dir) {
    if (d[0] === 0xF8 || d[0] === 0xFE) return;   // clock and active sensing would flood the list
    var t = new Date(), ts = A.pad2(t.getMinutes()) + ':' + A.pad2(t.getSeconds());
    log.push({ dir: dir, text: ts + '  ' + (dir === 'in' ? '← ' : '→ ') + A.M.describe(d) });
    if (log.length > 300) log.splice(0, log.length - 300);
    if (logEl && document.body.contains(logEl)) drawLog();
  }
  function drawLog() {
    logEl.innerHTML = '';
    var start = Math.max(0, log.length - 150);
    for (var i = log.length - 1; i >= start; i--) logEl.appendChild(h('div', { class: log[i].dir }, log[i].text));
    if (!log.length) logEl.appendChild(h('div', { class: 'note' }, 'Messages to and from the pedal appear here.'));
  }

  function onKey(e) {
    if (A.S.page !== 'direct' || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (!A.M.ready()) return;
    var k = e.key;
    if (k >= '1' && k <= '5') press(+k - 1);
    else if (k === '6') press('up');
    else if (k === 'ArrowRight' || k === 'ArrowUp') press('up');
    else if (k === 'ArrowLeft' || k === 'ArrowDown') press('down');
    else if (k === 'm' || k === 'M') press('mode');
    else if (k === 'Escape') { D.page = 'preset'; D.pending = null; redraw(); }
    else return;
    e.preventDefault();
  }

  window.DIRECT = {
    render: function (m, api) {
      A = api;
      if (!D) { init(); document.addEventListener('keydown', onKey); }
      if (!unlisten) unlisten = A.M.listen(addLog);
      D.ch = D.chUser || channel();
      var ready = A.M.ready();

      // settings strip
      var modeOpts = [{ v: 'preset', t: 'Preset mode' }, { v: 'song', t: 'Song mode' }];
      for (var s = 0; s < 40; s++) modeOpts.push({ v: 'set' + s, t: 'Set ' + (s + 1) });
      m.appendChild(h('div', { class: 'dnote' },
        h('label', { class: 'inl' }, 'Pedal is in ', A.sel(modeOpts, D.op === 'set' ? 'set' + D.setNo : D.op, function (v) {
          if (v.slice(0, 3) === 'set') { D.op = 'set'; D.setNo = +v.slice(3); } else D.op = v;
          D.bank = 0; D.slot = null; D.pending = null; redraw(); A.renderMain();
        })),
        h('label', { class: 'inl' }, 'Its MIDI channel ', A.sel(A.chOpts(), D.ch, function (v) { D.chUser = +v; D.ch = +v; })),
        h('span', { class: 'note' }, 'Set these to match the pedal (Global › Utility › Operating mode and Global › receive channel).')));

      var wrap = h('div', { class: 'efxwrap' });
      panel = buildPanel();
      if (!ready) panel.classList.add('off');
      wrap.appendChild(panel);
      if (!ready) wrap.appendChild(h('div', { class: 'offlabel' }, A.M.access ? 'Choose MIDI out and in above' : h('button', { class: 'primary', onclick: A.connectMidi }, 'Connect MIDI')));
      m.appendChild(wrap);

      var grid = h('div', { class: 'grid' });
      extras = h('div');
      grid.appendChild(A.card('Loops, outputs and function switches', [extras,
        h('p', { class: 'info' }, 'Switch them straight from here, whatever the pedal’s page. The input/movable buffers, C1–C5 and MUTE can’t be switched over MIDI.')]));
      logEl = h('div', { class: 'midilog' });
      grid.appendChild(A.card('MIDI monitor', [h('div', { class: 'btnrow' },
        h('button', { class: 'small', onclick: function () { log = []; drawLog(); } }, 'Clear')), logEl]));
      grid.appendChild(A.card('How it works', [
        h('p', null, 'Preset switches send bank select (CC#0) and a program change, like a MIDI controller would. In song and set mode the bank number is the song.'),
        h('p', null, 'MODE steps through the instant-access pages (IA1 loops, IA2 outputs and functions, IA3 volume loop); MUTE/▼ goes back. The switches send CC#64–74 on the pedal’s channel.'),
        h('p', { class: 'note keyhelp' }, 'Keys: 1–5 switches, 6 or → ▲, ← ▼, M mode, Esc back to presets.')]));
      m.appendChild(grid);
      redraw(); drawLog();
    },
    leave: function () { if (D) { D.pending = null; } }
  };
})();
