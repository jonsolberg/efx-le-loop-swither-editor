/*
 * EFX-LE Editor — the user interface.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 */
(function () {
  'use strict';
  var E = window.EFX, M = window.MIDI;
  var VERSION = '1.0';
  var KEY_SESSION = 'efxle.session', KEY_THEME = 'efxle.theme', KEY_CHANGED = 'efxle.onlyChanged';

  var S = {
    img: E.createDefault(),   // what you are editing
    base: null,               // the data as it is on the pedal (or in the file you opened)
    source: 'new',            // 'new' | 'pedal' | 'file'
    fileName: '',
    page: 'start', cur: 0, song: 0, set: 0,
    sel: null,                // selected routing item {k, part}
    undo: [], redo: [],
    clip: {}                  // copied preset / song / set blocks
  };

  // ------------------------------------------------------------------ tiny DOM helpers
  function $(id) { return document.getElementById(id); }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function sel(opts, value, onchange, props) {
    var s = h('select', props);
    opts.forEach(function (o) {
      var v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o;
      s.appendChild(h('option', { value: String(v), selected: String(v) === String(value) }, t));
    });
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }
  /** Number input; empty = null when allowOff. */
  function num(value, min, max, onchange, allowOff, props) {
    var i = h('input', Object.assign({ type: 'number', min: min, max: max, value: value == null ? '' : value, placeholder: allowOff ? 'OFF' : '' }, props || {}));
    i.addEventListener('change', function () {
      var v = i.value.trim();
      if (v === '' && allowOff) { onchange(null); return; }
      var n = Math.round(Number(v));
      if (!isFinite(n) || v === '') n = value == null ? min : value;
      n = Math.max(min, Math.min(max, n));
      i.value = n; onchange(n);
    });
    return i;
  }
  function chOpts() { var a = []; for (var c = 1; c <= 16; c++) a.push({ v: c, t: 'Ch ' + c }); return a; }
  function toast(msg, err) {
    var t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    $('toasts').appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, err ? 6000 : 3000);
    setTimeout(function () { t.remove(); }, err ? 6600 : 3600);
  }
  function modal(title, body, buttons) {
    var back = h('div', { class: 'modal-back' });
    var box = h('div', { class: 'modal', role: 'dialog' }, h('h2', null, title), h('div', { class: 'modal-body' }, body));
    var row = h('div', { class: 'modal-buttons' });
    function close() { back.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    (buttons || [{ t: 'Close' }]).forEach(function (b) {
      row.appendChild(h('button', { class: b.cls, onclick: function () { if (b.f && b.f() === false) return; close(); } }, b.t));
    });
    box.appendChild(row); back.appendChild(box);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(back);
    return { close: close, box: box };
  }
  function confirmBox(title, text, okText, f, danger) {
    modal(title, h('p', null, text), [{ t: 'Cancel' }, { t: okText, cls: danger ? 'primary danger' : 'primary', f: f }]);
  }
  function progressBox(title, text, onCancel) {
    var bar = h('progress', { max: 100, value: 0, class: 'pbar' }), info = h('p', { class: 'note' }, text);
    var m = modal(title, [info, bar], [{ t: 'Cancel', f: function () { if (onCancel) onCancel(); } }]);
    return { set: function (n, total, t) { bar.value = Math.round(n * 100 / total); if (t) info.textContent = t; }, close: m.close };
  }

  // ------------------------------------------------------------------ edits, undo, dirty state
  function edit(f) {
    var before = S.img.slice();
    f();
    for (var i = 0; i < before.length; i++) if (before[i] !== S.img[i]) {
      S.undo.push(before); if (S.undo.length > 200) S.undo.shift();
      S.redo = [];
      changed();
      return true;
    }
    return false;
  }
  function changed(noRender) { saveSession(); if (!noRender) render(); else { renderStatus(); renderList(); } }
  function undo() { if (!S.undo.length) return; S.redo.push(S.img); S.img = S.undo.pop(); S.sel = null; changed(); }
  function redo() { if (!S.redo.length) return; S.undo.push(S.img); S.img = S.redo.pop(); S.sel = null; changed(); }
  function changedBlocks() { return S.base ? E.changedBlocks(S.base, S.img) : []; }
  function blockDirty(i) {
    if (!S.base) return false;
    for (var k = i * E.BLK; k < i * E.BLK + E.BLK; k++) if (S.base[k] !== S.img[k]) return true;
    return false;
  }

  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i += 4096) s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096)); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  var saveTimer = null;
  function saveSession() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY_SESSION, JSON.stringify({
          img: b64(S.img), base: S.base ? b64(S.base) : null, source: S.source, fileName: S.fileName,
          cur: S.cur, song: S.song, set: S.set
        }));
      } catch (e) { /* storage full or private mode */ }
    }, 400);
  }
  function restoreSession() {
    try {
      var j = JSON.parse(localStorage.getItem(KEY_SESSION) || 'null');
      if (!j || !j.img) return false;
      var img = unb64(j.img);
      if (img.length !== E.BLOCKS * E.BLK) return false;
      S.img = img; S.base = j.base ? unb64(j.base) : null; S.source = j.source || 'new'; S.fileName = j.fileName || '';
      S.cur = j.cur || 0; S.song = j.song || 0; S.set = j.set || 0;
      return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ MIDI bar and status
  function renderMidibar() {
    var bar = $('midibar'); bar.innerHTML = '';
    if (!M.supported()) {
      bar.appendChild(h('span', { class: 'mbwarn' }, 'This browser has no Web MIDI. Use Chrome or Edge to connect to the pedal – you can still open and edit .syx files.'));
      return;
    }
    if (!M.access) {
      bar.appendChild(h('span', { class: 'mblabel' }, 'MIDI'));
      bar.appendChild(h('button', { class: 'small primary', onclick: connectMidi }, 'Connect MIDI'));
      bar.appendChild(h('span', { class: 'note' }, M.error === 'denied' ? 'MIDI was blocked. Allow MIDI and SysEx for this site (the icon in the address bar), then try again.' : 'Allow MIDI with SysEx when the browser asks.'));
      return;
    }
    function picker(label, ports, cur, f, title) {
      var opts = [{ v: '', t: '— none —' }].concat(ports.map(function (p) { return { v: p.id, t: p.name }; }));
      return h('label', { class: 'mbpick', title: title }, h('span', { class: 'mblabel' }, label),
        sel(opts, cur ? cur.id : '', f, { 'aria-label': label }));
    }
    var ins = M.inputs(), outs = M.outputs();
    bar.appendChild(h('span', { class: 'mbdot' + (M.ready() ? ' ok' : '') }));
    bar.appendChild(picker('MIDI out', outs, M.output, M.selectOutput, 'The interface output connected to the EFX-LE’s MIDI IN'));
    bar.appendChild(h('span', { class: 'mbarrow', 'aria-hidden': 'true' }, '→ EFX-LE →'));
    bar.appendChild(picker('MIDI in', ins, M.input, M.selectInput, 'The interface input connected to the EFX-LE’s MIDI OUT/THRU'));
    if (!ins.length && !outs.length) bar.appendChild(h('span', { class: 'note' }, 'No MIDI devices found. Plug in the interface.'));
  }
  function connectMidi() {
    M.init().then(function () { renderMidibar(); renderStatus(); if (S.page === 'start' || S.page === 'direct') renderMain(); },
      function (e) { renderMidibar(); toast(e.message, true); });
  }

  function renderStatus() {
    var b = $('status'), n = changedBlocks().length;
    var src = S.source === 'pedal' ? 'From pedal' : S.source === 'file' ? (S.fileName || 'File') : 'Factory data';
    b.innerHTML = '';
    b.appendChild(h('span', { class: 'dot' + (M.ready() ? ' ok' : '') }));
    b.appendChild(h('span', { class: 'only-wide' }, M.ready() ? 'MIDI ready' : 'No MIDI'));
    b.appendChild(h('span', { class: 'sep only-wide' }, '·'));
    b.appendChild(h('span', { class: 'only-wide srcname' }, src));
    if (S.source !== 'new' && n) b.appendChild(h('span', { class: 'unsaved' }, n + ' changed'));
    $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
    var save = $('btnSave'); save.classList.toggle('attention', S.source === 'pedal' && n > 0);
    var pk = $('pick'); pk.innerHTML = '';
    if (S.page === 'presets') pk.appendChild(h('span', null, h('b', null, E.presetName(S.cur)), ' ' + E.title(S.img, S.cur).trim(), h('span', { class: 'caret' }, '▾')));
    else if (S.page === 'songs') pk.appendChild(h('span', null, h('b', null, 'Song ' + pad2(S.song + 1)), ' ' + E.songTitle(S.img, S.song).trim(), h('span', { class: 'caret' }, '▾')));
    else if (S.page === 'sets') pk.appendChild(h('span', null, h('b', null, 'Set ' + pad2(S.set + 1)), h('span', { class: 'caret' }, '▾')));
    pk.style.visibility = hasList() ? '' : 'hidden';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function statusPop() {
    var n = changedBlocks().length;
    modal('Status', h('div', { class: 'statuspop' },
      h('div', { class: 'srow' }, h('span', { class: 'sicon' }, M.ready() ? '●' : '○'),
        h('div', null, h('b', null, M.ready() ? 'MIDI devices chosen' : 'MIDI not ready'),
          h('small', null, M.access ? ('Out: ' + (M.output ? M.output.name : 'none') + ' · In: ' + (M.input ? M.input.name : 'none')) : 'Press “Connect MIDI” in the bar under the header.'))),
      h('div', { class: 'srow' }, h('span', { class: 'sicon' }, '▣'),
        h('div', null, h('b', null, S.source === 'pedal' ? 'Data loaded from the pedal' : S.source === 'file' ? 'Data from ' + (S.fileName || 'a file') : 'Factory data (nothing loaded)'),
          h('small', null, S.source === 'new' ? 'Load from the pedal or open a .syx file to edit your own data.' :
            n ? n + ' of 512 blocks changed since loading. Save to the pedal to keep them.' : 'No changes since loading.')))
    ));
  }

  // ------------------------------------------------------------------ side list
  function hasList() { return S.page === 'presets' || S.page === 'songs' || S.page === 'sets'; }
  function renderList() {
    var ul = $('list'), f = $('filter').value.trim().toLowerCase();
    document.body.classList.toggle('nolist', !hasList());
    ul.innerHTML = '';
    if (!hasList()) return;
    $('sidetitle').textContent = S.page === 'presets' ? 'Choose preset' : S.page === 'songs' ? 'Choose song' : 'Choose set';
    $('filter').placeholder = S.page === 'presets' ? 'Find preset…' : S.page === 'songs' ? 'Find song…' : 'Find set…';
    var items = [];
    if (S.page === 'presets') for (var p = 0; p <= E.GLOBAL_PRESET; p++) items.push({ i: p, no: E.presetName(p), nm: E.title(S.img, p), dirty: blockDirty(p), on: p === S.cur, bank: p % 5 === 0 });
    if (S.page === 'songs') for (var s = 0; s < E.SONGS; s++) items.push({ i: s, no: pad2(s + 1), nm: E.songTitle(S.img, s), dirty: blockDirty(E.SONG0 + s), on: s === S.song });
    if (S.page === 'sets') for (var t = 0; t < E.SETS; t++) items.push({ i: t, no: pad2(t + 1), nm: 'Set ' + pad2(t + 1) + ' · ' + E.songTitle(S.img, E.setSong(S.img, t, 0)).trim(), dirty: blockDirty(E.SET0 + t), on: t === S.set });
    var frag = document.createDocumentFragment(), selEl = null;
    items.forEach(function (it) {
      if (f && (it.no + ' ' + it.nm).toLowerCase().indexOf(f) < 0) return;
      var li = h('li', { class: (it.on ? 'sel' : '') + (it.dirty ? ' dirty' : '') + (it.bank && !f ? ' bankstart' : ''), onclick: function () { pickItem(it.i); } },
        h('span', { class: 'no' }, it.no), h('span', { class: 'nm' }, String(it.nm).trim()));
      if (it.on) selEl = li;
      frag.appendChild(li);
    });
    ul.appendChild(frag);
    if (selEl) { var r = selEl.offsetTop - ul.scrollTop; if (r < 0 || r > ul.clientHeight - 30) ul.scrollTop = selEl.offsetTop - ul.clientHeight / 2; }
  }
  function pickItem(i) {
    if (S.page === 'presets') { S.cur = i; S.sel = null; }
    else if (S.page === 'songs') S.song = i;
    else S.set = i;
    document.body.classList.remove('show-list');
    saveSession(); render();
  }

  // ------------------------------------------------------------------ pages
  function render() {
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.page === S.page); });
    renderStatus(); renderList(); renderMain();
  }
  function renderMain() {
    var m = $('main'), top = m.scrollTop;
    m.innerHTML = '';
    var pages = { start: pageStart, direct: pageDirect, presets: pagePreset, songs: pageSong, sets: pageSet, global: pageGlobal, help: pageHelp };
    (pages[S.page] || pageStart)(m);
    m.scrollTop = top;
  }
  function go(p) { if (S.page !== p) { S.page = p; $('main').scrollTop = 0; } if (window.DIRECT && p !== 'direct') window.DIRECT.leave(); render(); }

  function card(title, body, cls) { return h('section', { class: 'card ' + (cls || '') }, title ? h('h3', null, title) : null, body); }
  function row(label, ctl, hint) {
    var r = h('div', { class: 'row' });
    var lab = h('label', null, label);
    if (hint) {
      lab.appendChild(h('button', { class: 'ib', type: 'button', title: 'What is this?', onclick: function () { r.classList.toggle('showhint'); } }, 'i'));
    }
    r.appendChild(lab); r.appendChild(h('div', { class: 'ctl' }, ctl));
    if (hint) r.appendChild(h('div', { class: 'hint' }, hint));
    return r;
  }

  // ---------------- Start
  function pageStart(m) {
    var loaded = S.source !== 'new', midiOk = M.ready();
    function step(no, done, title, body) {
      return h('section', { class: 'card step' + (done ? ' done' : '') },
        h('div', { class: 'stephead' }, h('span', { class: 'stepno' }, done ? '✓' : String(no)), h('h3', null, title)), body);
    }
    m.appendChild(h('div', { class: 'start' },
      h('div', { class: 'hero' }, h('h2', null, 'EFX-LE Editor'),
        h('p', null, 'Edit the presets, routing, songs, sets and global settings of your Musicom Lab EFX-LE, or play it live in Direct mode.')),
      step(1, midiOk, 'Connect the pedal', [
        h('p', null, 'Use a USB MIDI interface: its MIDI OUT to the EFX-LE’s MIDI IN, and the EFX-LE’s MIDI OUT/THRU to the interface’s MIDI IN.'),
        !M.supported() ? h('p', { class: 'warn' }, 'This browser has no Web MIDI. Use Chrome or Edge on a computer to talk to the pedal.') :
          !M.access ? h('p', null, h('button', { class: 'primary', onclick: connectMidi }, 'Connect MIDI'), ' ', h('span', { class: 'note' }, 'Allow MIDI with SysEx when the browser asks.')) :
            h('p', null, midiOk ? 'Ready: out to ' + M.output.name + ', in from ' + M.input.name + '.' : 'Choose your interface under MIDI out and MIDI in, in the bar at the top.')
      ]),
      step(2, loaded, 'Get the data', [
        h('p', null, 'Read everything from the pedal (about 70 kB), or open a .syx file saved by this editor, the official editor or the pedal’s SysEx dump.'),
        h('div', { class: 'btnrow' },
          h('button', { class: 'primary', onclick: loadFromPedal }, '⤓ Load from pedal'),
          h('button', { onclick: function () { loadFromPedal(true); } }, 'Wait for dump from pedal'),
          h('button', { onclick: openFile }, 'Open .syx file'),
          h('button', { onclick: newData }, 'Start from factory data')),
        loaded ? h('p', { class: 'note' }, 'Loaded: ' + (S.source === 'pedal' ? 'from the pedal' : S.fileName) + '. ', h('a', { href: '#', onclick: function (e) { e.preventDefault(); saveFile(); } }, 'Save a .syx backup')) : null
      ]),
      step(3, false, 'Edit', h('div', { class: 'datagrid' },
        h('button', { onclick: function () { go('presets'); } }, '☰ Presets and routing'),
        h('button', { onclick: function () { go('songs'); } }, '♫ Songs'),
        h('button', { onclick: function () { go('sets'); } }, '▤ Sets'),
        h('button', { onclick: function () { go('global'); } }, '⚙ Global MIDI and utility'),
        h('button', { onclick: function () { go('direct'); } }, '◉ Direct mode'))),
      step(4, S.source === 'pedal' && !changedBlocks().length && S.undo.length > 0, 'Save', [
        h('p', null, 'Write your changes to the pedal, and keep a .syx file as a backup.'),
        h('div', { class: 'btnrow' }, h('button', { class: 'primary', onclick: saveToPedal }, '⤒ Save to pedal'),
          h('button', { onclick: saveFile }, 'Save .syx file'))
      ])
    ));
  }

  // ---------------- Presets
  var SW_GROUPS = [
    { t: 'Loops (IA1)', ids: [0, 1, 2, 3, 4, 5] },
    { t: 'Outputs, functions, buffers (IA2)', ids: [6, 7, 8, 9, 10, 11] },
    { t: 'MIDI CC switches, volume loop (IA3)', ids: [12, 13, 14, 15, 16, 17] }
  ];
  var LOOP_SW = [0, 1, 2, 3, 4, 5, 17, 11];   // routing item -> switch index (L1–L6, VL, BM)

  function pagePreset(m) {
    var p = S.cur, img = S.img;
    var name = h('input', { class: 'name', maxlength: E.TITLE_LEN, value: E.title(img, p).replace(/\s+$/, ''), spellcheck: 'false', 'aria-label': 'Preset title' });
    var nameTimer = null;
    name.addEventListener('input', function () {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(function () { if (edit(function () { E.setTitle(S.img, p, name.value); })) { /* list refreshed by render */ } }, 500);
    });
    name.addEventListener('change', function () { clearTimeout(nameTimer); edit(function () { E.setTitle(S.img, p, name.value); }); });

    var head = h('div', { class: 'memhead' },
      h('div', { class: 'memtitle' }, h('span', { class: 'big' }, p === E.GLOBAL_PRESET ? 'GLB' : E.presetName(p)), name,
        h('span', { class: 'note only-wide' }, p === E.GLOBAL_PRESET ? 'Global preset – the same in every bank' : 'Bank ' + (Math.floor(p / 5) + 1) + ', preset ' + (p % 5 + 1))),
      h('div', { class: 'tools' },
        h('button', { onclick: function () { stepPreset(-1); }, title: 'Previous preset' }, '‹'),
        h('button', { onclick: function () { stepPreset(1); }, title: 'Next preset' }, '›'),
        h('button', { onclick: presetMenu }, 'Copy / paste ▾')));
    m.appendChild(head);

    var grid = h('div', { class: 'grid' });
    m.appendChild(grid);

    // switches
    var sws = h('div', { class: 'swgroups' });
    SW_GROUPS.forEach(function (g) {
      var box = h('div', { class: 'swgroup' }, h('div', { class: 'swgt' }, g.t));
      var btns = h('div', { class: 'swrow' });
      g.ids.forEach(function (i) {
        var s = E.SWITCHES[i], on = E.sw(img, p, i);
        var midiLoop = i <= 5 && E.gcc(img, i).num != null;
        btns.appendChild(h('button', {
          class: 'fxsw' + (on ? ' on' : '') + (midiLoop ? ' warnsw' : ''), title: s.name + (midiLoop ? ' – this loop has a global MIDI CC, so the EFX-LE keeps it bypassed' : ''),
          'aria-pressed': on ? 'true' : 'false',
          onclick: function () { edit(function () { E.setSw(S.img, p, i, !on); }); }
        }, h('span', { class: 'swled' }), h('span', { class: 'swid' }, s.id), h('span', { class: 'swnm' }, s.name)));
      });
      box.appendChild(btns); sws.appendChild(box);
    });
    grid.appendChild(card('Switches', sws, 'wide'));

    grid.appendChild(routingCard(p));

    // BPM and XPDL
    var b = E.bpm(img, p), x = E.xpdl(img, p);
    function setB(k, v) { edit(function () { var o = E.bpm(S.img, p); o[k] = v; E.setBpm(S.img, p, o); }); }
    function setX(k, v) { edit(function () { var o = E.xpdl(S.img, p); o[k] = v; E.setXpdl(S.img, p, o); }); }
    var begOpts = [{ v: 'OFF', t: 'OFF' }, { v: 'PDL', t: 'PDL (pedal position)' }];
    for (var v = 0; v <= 127; v++) begOpts.push({ v: v, t: String(v) });
    grid.appendChild(card('Tempo', [
      row('BPM from', sel([{ v: 0, t: 'This preset' }, { v: 1, t: 'Global BPM' }], b.glb ? 1 : 0, function (v) { setB('glb', v === '1'); }),
        'Global: the preset keeps the current (tapped) tempo. This preset: the preset sets its own BPM.'),
      row('Preset BPM', num(b.bpm, 40, 209, function (v) { setB('bpm', v); }, true, { disabled: b.glb }), 'Empty = OFF. 40–209 BPM. Sent as MIDI clock and/or on F1, see Global › Utility › Tempo sync.')
    ]));
    grid.appendChild(card('Expression pedal (XPDL)', [
      row('Settings from', sel([{ v: 0, t: 'This preset' }, { v: 1, t: 'Global XPDL' }], x.glb ? 1 : 0, function (v) { setX('glb', v === '1'); }),
        'Global uses the XPDL row on the Global page. This preset uses the values below.'),
      row('Channel', sel(chOpts(), x.ch, function (v) { setX('ch', +v); }, { disabled: x.glb })),
      row('CC#', num(x.num, 0, 127, function (v) { setX('num', v); }, true, { disabled: x.glb }), 'Empty = OFF.'),
      row('Start value', sel(begOpts, x.beg, function (v) { setX('beg', v === 'OFF' || v === 'PDL' ? v : +v); }, { disabled: x.glb }),
        'Sent when the preset is selected. PDL sends the pedal’s current position; OFF sends nothing.'),
      row('Max / min', h('span', { class: 'pair' }, num(x.max, 0, 127, function (v) { setX('max', v); }, false, { disabled: x.glb }), ' / ',
        num(x.min, 0, 127, function (v) { setX('min', v); }, false, { disabled: x.glb })), 'The values sent with the pedal at heel and toe.')
    ]));

    // Program change
    var pcT = h('table', { class: 'mtab' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Channel'), h('th', null, 'Program'), h('th', { title: 'Bank select MSB (CC#0)' }, 'MSB'), h('th', { title: 'Bank select LSB (CC#32)' }, 'LSB'))));
    var pcB = h('tbody');
    for (var i = 0; i < 8; i++) (function (i) {
      var c = E.pc(img, p, i);
      function setP(k, v) { edit(function () { var o = E.pc(S.img, p, i); o[k] = v; E.setPc(S.img, p, i, o); }); }
      pcB.appendChild(h('tr', { class: c.num == null && c.msb == null && c.lsb == null ? 'off' : '' }, h('th', null, 'PC' + (i + 1)),
        h('td', null, sel(chOpts(), c.ch, function (v) { setP('ch', +v); })),
        h('td', null, num(c.num, 1, 128, function (v) { setP('num', v); }, true)),
        h('td', null, num(c.msb, 0, 127, function (v) { setP('msb', v); }, true, { placeholder: '–', title: 'Empty = OFF' })),
        h('td', null, num(c.lsb, 0, 127, function (v) { setP('lsb', v); }, true, { placeholder: '–', title: 'Empty = OFF' }))));
    })(i);
    pcT.appendChild(pcB);
    grid.appendChild(card('Program Change', [pcT, h('p', { class: 'info' }, 'Sent when the preset is selected. Program 1–128; empty (OFF or –) = not sent. Bank MSB/LSB (CC#0/CC#32) are sent before the program change.')]));

    var ccT = h('table', { class: 'mtab' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Channel'), h('th', null, 'CC#'), h('th', null, 'Value'))));
    var ccB = h('tbody');
    for (var j = 0; j < 8; j++) (function (j) {
      var c = E.cc(img, p, j);
      function setC(k, v) { edit(function () { var o = E.cc(S.img, p, j); o[k] = v; E.setCc(S.img, p, j, o); }); }
      ccB.appendChild(h('tr', { class: c.num == null ? 'off' : '' }, h('th', null, 'CC' + (j + 1)),
        h('td', null, sel(chOpts(), c.ch, function (v) { setC('ch', +v); })),
        h('td', null, num(c.num, 0, 127, function (v) { setC('num', v); }, true)),
        h('td', null, num(c.val, 0, 127, function (v) { setC('val', v); }, false))));
    })(j);
    ccT.appendChild(ccB);
    grid.appendChild(card('Control Change', [ccT, h('p', { class: 'info' }, 'Sent when the preset is selected. Empty CC# = OFF.')]));
  }

  function stepPreset(d) { S.cur = (S.cur + d + E.GLOBAL_PRESET + 1) % (E.GLOBAL_PRESET + 1); S.sel = null; saveSession(); render(); }

  function presetOptions() {
    var o = [];
    for (var q = 0; q <= E.GLOBAL_PRESET; q++) o.push({ v: q, t: E.presetName(q) + '  ' + E.title(S.img, q) });
    return o;
  }
  function presetMenu(ev) {
    var p = S.cur;
    menu(ev.currentTarget, [
      { t: 'Copy preset', f: function () { S.clip.preset = E.block(S.img, p); toast('Copied ' + E.presetName(p) + '.'); } },
      { t: 'Paste preset', dis: !S.clip.preset, f: function () { edit(function () { E.setBlock(S.img, p, S.clip.preset); }); toast('Pasted into ' + E.presetName(p) + '.'); } },
      { t: 'Copy to…', f: function () { copyPresetTo(p); } },
      { t: 'Swap with…', f: function () { swapPreset(p); } },
      null,
      { t: 'Copy this routing to all presets…', f: function () {
        confirmBox('Copy routing to all presets', 'Give all 361 presets the loop order, parallel and spill-over settings of ' + E.presetName(p) + '? Titles, switches and MIDI stay as they are.', 'Copy to all', function () {
          edit(function () { E.copyRoutingToAll(S.img, p); }); toast('Routing copied to all presets.');
        });
      } },
      { t: 'Initialise preset', f: function () {
        confirmBox('Initialise preset', 'Reset ' + E.presetName(p) + ' to the factory settings?', 'Initialise', function () { edit(function () { E.setBlock(S.img, p, E.defaultBlock(p)); }); }, true);
      } }
    ]);
  }
  function choosePreset(title, okText, f) {
    var target = S.cur === 0 ? 1 : 0;
    var s = sel(presetOptions(), target, function (v) { target = +v; }, { class: 'wide' });
    modal(title, [h('p', null, 'Preset:'), s], [{ t: 'Cancel' }, { t: okText, cls: 'primary', f: function () { return f(target); } }]);
  }
  function copyPresetTo(p) {
    choosePreset('Copy ' + E.presetName(p) + ' to…', 'Copy', function (t) {
      if (t === p) return false;
      edit(function () { E.setBlock(S.img, t, E.block(S.img, p)); }); toast('Copied to ' + E.presetName(t) + '.');
    });
  }
  function swapPreset(p) {
    choosePreset('Swap ' + E.presetName(p) + ' with…', 'Swap', function (t) {
      if (t === p) return false;
      edit(function () { var a = E.block(S.img, p); E.setBlock(S.img, p, E.block(S.img, t)); E.setBlock(S.img, t, a); }); toast('Swapped with ' + E.presetName(t) + '.');
    });
  }

  function menu(anchor, items) {
    var back = h('div', { class: 'menu-back', onclick: function () { back.remove(); } });
    var mm = h('div', { class: 'menu' });
    items.forEach(function (it) {
      if (!it) { mm.appendChild(h('hr')); return; }
      mm.appendChild(h('button', { disabled: it.dis, onclick: function () { back.remove(); it.f(); } }, it.t));
    });
    back.appendChild(mm); document.body.appendChild(back);
    var r = anchor.getBoundingClientRect(), w = mm.offsetWidth;
    mm.style.top = Math.min(r.bottom + 4, window.innerHeight - mm.offsetHeight - 8) + 'px';
    mm.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  }

  // ---------------- Routing
  function routingCard(p) {
    var r = E.routing(S.img, p), nodes = r.nodes;
    var u = E.util(S.img, 12) === 1, v6 = E.util(S.img, 13) === 1;
    var used = E.mixersUsed(nodes, u, v6);
    var body = h('div', { class: 'routing' });
    if (!r.ok) {
      body.appendChild(h('p', { class: 'warn' }, 'The routing stored in this preset isn’t one the editor understands, so it is left as it is. ',
        h('button', { class: 'small', onclick: function () { edit(function () { E.setRouting(S.img, p, E.defaultRouting()); }); } }, 'Reset routing')));
    }
    var chain = h('div', { class: 'chain' + (r.ok ? '' : ' dim') });
    chain.appendChild(h('div', { class: 'jackbox' }, h('span', { class: 'jk' }, 'IN'), h('span', { class: 'jicon' }, '🎸')));
    function box(a, k, part, extra) {
      var on = a == null ? true : E.sw(S.img, p, LOOP_SW[a]);
      var isSel = S.sel && S.sel.k === k && S.sel.part === part;
      return h('button', {
        class: 'rbox' + (a == null ? ' dry' : '') + (on && a != null ? ' on' : '') + (isSel ? ' sel' : '') + (extra || ''),
        title: a == null ? 'Dry signal (no loop)' : E.SWITCHES[LOOP_SW[a]].name + (on ? ' (on in this preset)' : ' (off in this preset)'),
        onclick: function () { if (!r.ok) return; S.sel = isSel ? null : { k: k, part: part }; renderMain(); }
      }, a == null ? 'DRY' : E.LOOPS[a]);
    }
    nodes.forEach(function (n, k) {
      chain.appendChild(h('span', { class: 'wire' }));
      if (n.mix) {
        chain.appendChild(h('div', { class: 'mixnode' },
          h('div', { class: 'mixpaths' }, box(n.a, k, 'a'), box(n.b, k, 'b')),
          h('span', { class: 'mixer', title: 'Mixer' }, 'MIX')));
      } else {
        var bx = box(n.a, k, 'a', n.spill ? ' spill' : '');
        chain.appendChild(n.spill ? h('div', { class: 'spillnode' }, bx, h('span', { class: 'spilltag', title: 'Spill-over: this loop’s tail rings on into the next preset' }, 'SPILL')) : bx);
      }
    });
    chain.appendChild(h('span', { class: 'wire' }));
    chain.appendChild(h('div', { class: 'jackbox' }, h('span', { class: 'jk' }, 'OUT'), h('span', { class: 'jicon' }, '🔊')));
    body.appendChild(h('div', { class: 'chainwrap' }, chain));

    // toolbar for the selected item
    var tb = h('div', { class: 'rtools' });
    var s = S.sel && nodes[S.sel.k] ? S.sel : null;
    var n = s ? nodes[s.k] : null, item = n ? (s.part === 'b' ? n.b : n.a) : null;
    function apply(f) {
      var ns = nodes.map(function (x) { return Object.assign({}, x); });
      var res = f(ns);
      if (res === false) return;
      var need = E.mixersUsed(ns, u, v6);
      if (need > 2 && need > used) { toast('No more mixers: the EFX-LE has two, shared by parallel loops and spill-over' + (u || v6 ? ' (a stereo return at the end of the chain needs both)' : '') + '.', true); return; }
      edit(function () { E.setRouting(S.img, p, ns); });
    }
    if (!s) tb.appendChild(h('span', { class: 'note' }, r.ok ? 'Click a loop to move it, put it in parallel or set spill-over.' : ''));
    else {
      var label = item == null ? 'Dry input' : E.LOOPS[item];
      tb.appendChild(h('b', { class: 'rsel' }, label));
      tb.appendChild(h('button', { disabled: s.part === 'a' && s.k === 0 || item == null, title: 'Move earlier in the chain', onclick: function () {
        apply(function (ns) {
          if (s.part === 'b') { ns[s.k].b = null; ns.splice(s.k, 0, { a: item, spill: false, mix: false, b: null }); S.sel = { k: s.k, part: 'a' }; return; }
          var t = ns[s.k - 1]; ns[s.k - 1] = ns[s.k]; ns[s.k] = t; S.sel = { k: s.k - 1, part: 'a' };
        });
      } }, '◀ Earlier'));
      tb.appendChild(h('button', { disabled: s.part === 'a' && s.k === nodes.length - 1 || item == null, title: 'Move later in the chain', onclick: function () {
        apply(function (ns) {
          if (s.part === 'b') { ns[s.k].b = null; ns.splice(s.k + 1, 0, { a: item, spill: false, mix: false, b: null }); S.sel = { k: s.k + 1, part: 'a' }; return; }
          var t = ns[s.k + 1]; ns[s.k + 1] = ns[s.k]; ns[s.k] = t; S.sel = { k: s.k + 1, part: 'a' };
        });
      } }, 'Later ▶'));
      if (s.part === 'a' && !n.mix) {
        tb.appendChild(h('button', { class: n.spill ? 'on' : '', disabled: !E.canMix(n.a), title: E.canMix(n.a) ? 'Let this loop’s tail ring on into the next preset (uses a mixer)' : 'The volume loop and the movable buffer can’t spill over',
          onclick: function () { apply(function (ns) { ns[s.k].spill = !ns[s.k].spill; }); } }, 'Spill-over'));
        tb.appendChild(h('button', { disabled: !E.canMix(n.a), title: E.canMix(n.a) ? 'Put this loop in parallel (uses a mixer)' : 'The volume loop and the movable buffer can’t be mixed',
          onclick: function () { apply(function (ns) { ns[s.k].mix = true; ns[s.k].spill = false; ns[s.k].b = null; }); } }, 'Parallel'));
      }
      if (n.mix) {
        var opts = [{ v: '', t: 'Dry signal' }];
        if (n.b != null) opts.push({ v: n.b, t: E.LOOPS[n.b] });
        nodes.forEach(function (o, j) { if (j !== s.k && !o.mix && E.canMix(o.a)) opts.push({ v: o.a, t: E.LOOPS[o.a] }); });
        tb.appendChild(h('label', { class: 'inl' }, 'In parallel with ', sel(opts, n.b == null ? '' : n.b, function (v) {
          apply(function (ns) {
            var cur = ns[s.k], nb = v === '' ? null : +v;
            if (nb === cur.b) return false;
            var old = cur.b;
            if (nb != null) { var j = ns.findIndex(function (o, jj) { return jj !== s.k && !o.mix && o.a === nb; }); if (j >= 0) { ns.splice(j, 1); if (j < s.k) s.k--; } }
            cur.b = nb;
            if (old != null) ns.splice(s.k + 1, 0, { a: old, spill: false, mix: false, b: null });
            S.sel = { k: s.k, part: 'a' };
          });
        })));
        tb.appendChild(h('button', { title: 'Back to a single chain', onclick: function () {
          apply(function (ns) { var cur = ns[s.k], b = cur.b; cur.mix = false; cur.b = null; if (b != null) ns.splice(s.k + 1, 0, { a: b, spill: false, mix: false, b: null }); S.sel = { k: s.k, part: 'a' }; });
        } }, 'Not parallel'));
      }
    }
    tb.appendChild(h('span', { class: 'mixcount' + (used > 2 ? ' over' : '') }, 'Mixers: ' + used + ' of 2'));
    body.appendChild(tb);
    body.appendChild(h('p', { class: 'info' }, 'Lit boxes are loops that are on in this preset. Parallel loops share a mixer (two loops, or one loop and the dry signal); spill-over also uses a mixer. The volume loop and the movable buffer can’t be mixed or spilled.'));
    return card('Routing', body, 'wide');
  }

  // ---------------- Songs
  function pageSong(m) {
    var s = S.song, img = S.img;
    var name = h('input', { class: 'name', maxlength: E.TITLE_LEN, value: E.songTitle(img, s).replace(/\s+$/, ''), spellcheck: 'false', 'aria-label': 'Song title' });
    var tm = null;
    name.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { edit(function () { E.setSongTitle(S.img, s, name.value); }); }, 500); });
    name.addEventListener('change', function () { clearTimeout(tm); edit(function () { E.setSongTitle(S.img, s, name.value); }); });
    m.appendChild(h('div', { class: 'memhead' },
      h('div', { class: 'memtitle' }, h('span', { class: 'big' }, pad2(s + 1)), name),
      h('div', { class: 'tools' },
        h('button', { onclick: function () { S.song = (s + E.SONGS - 1) % E.SONGS; render(); } }, '‹'),
        h('button', { onclick: function () { S.song = (s + 1) % E.SONGS; render(); } }, '›'),
        h('button', { onclick: function (ev) {
          menu(ev.currentTarget, [
            { t: 'Copy song', f: function () { S.clip.song = E.block(S.img, E.SONG0 + s); toast('Copied song ' + (s + 1) + '.'); } },
            { t: 'Paste song', dis: !S.clip.song, f: function () { edit(function () { E.setBlock(S.img, E.SONG0 + s, S.clip.song); }); } },
            { t: 'Initialise song', f: function () { edit(function () { E.setBlock(S.img, E.SONG0 + s, E.defaultBlock(E.SONG0 + s)); }); } }
          ]);
        } }, 'Copy / paste ▾'))));
    var popts = presetOptions();
    var bopts = [{ v: 'GLB', t: 'Global BPM' }, { v: 'PST', t: 'Preset’s BPM' }];
    for (var b = 40; b <= 209; b++) bopts.push({ v: b, t: b + ' BPM' });
    var t = h('table', { class: 'mtab songtab' }, h('thead', null, h('tr', null, h('th', null, 'Switch'), h('th', null, 'Preset'), h('th', null, 'Tempo'))));
    var tb = h('tbody');
    for (var k = 0; k < 5; k++) (function (k) {
      var sp = E.songPreset(img, s, k);
      function setS(key, v) { edit(function () { var o = E.songPreset(S.img, s, k); o[key] = v; E.setSongPreset(S.img, s, k, o); }); }
      tb.appendChild(h('tr', null, h('th', null, String(k + 1)),
        h('td', null, sel(popts, sp.preset, function (v) { setS('preset', +v); }, { class: 'mono' }),
          ' ', h('button', { class: 'small', title: 'Edit this preset', onclick: function () { S.cur = sp.preset; go('presets'); } }, 'Edit')),
        h('td', null, sel(bopts, sp.bpm, function (v) { setS('bpm', v === 'GLB' || v === 'PST' ? v : +v); }))));
    })(k);
    t.appendChild(tb);
    var used = [];
    for (var n = 0; n < E.SETS; n++) for (var q = 0; q < E.SET_LEN; q++) if (E.setSong(img, n, q) === s) { used.push(n + 1); break; }
    m.appendChild(h('div', { class: 'grid' }, card('Presets in this song', [t,
      h('p', { class: 'info' }, 'In SONG mode the five switches select these presets. Any of the 360 presets (or the global preset) can be used.')], 'wide'),
      card('Used in sets', h('p', null, used.length ? used.map(function (x) { return 'Set ' + pad2(x); }).join(', ') : 'Not used in any set.'))));
  }

  // ---------------- Sets
  function pageSet(m) {
    var n = S.set, img = S.img;
    m.appendChild(h('div', { class: 'memhead' },
      h('div', { class: 'memtitle' }, h('span', { class: 'big' }, 'SET ' + pad2(n + 1))),
      h('div', { class: 'tools' },
        h('button', { onclick: function () { S.set = (n + E.SETS - 1) % E.SETS; render(); } }, '‹'),
        h('button', { onclick: function () { S.set = (n + 1) % E.SETS; render(); } }, '›'),
        h('button', { onclick: function (ev) {
          menu(ev.currentTarget, [
            { t: 'Copy set', f: function () { S.clip.set = E.block(S.img, E.SET0 + n); toast('Copied set ' + (n + 1) + '.'); } },
            { t: 'Paste set', dis: !S.clip.set, f: function () { edit(function () { E.setBlock(S.img, E.SET0 + n, S.clip.set); }); } },
            { t: 'Initialise set (songs 1–40)', f: function () { edit(function () { E.setBlock(S.img, E.SET0 + n, E.defaultBlock(E.SET0 + n)); }); } }
          ]);
        } }, 'Copy / paste ▾'))));
    var sopts = [];
    for (var s = 0; s < E.SONGS; s++) sopts.push({ v: s, t: pad2(s + 1) + '  ' + E.songTitle(img, s) });
    var g = h('ol', { class: 'setgrid' });
    for (var k = 0; k < E.SET_LEN; k++) (function (k) {
      var cur = E.setSong(img, n, k);
      g.appendChild(h('li', null, h('span', { class: 'no' }, pad2(k + 1)), sel(sopts, cur, function (v) { edit(function () { E.setSetSong(S.img, n, k, +v); }); }, { class: 'mono' }),
        h('button', { class: 'small', title: 'Edit this song', onclick: function () { S.song = cur; go('songs'); } }, '✎')));
    })(k);
    m.appendChild(h('div', { class: 'grid' }, card('Songs in this set', [g,
      h('p', { class: 'info' }, 'A set plays 40 songs in this order. Choose the set as the operating mode (Global › Utility, SET 1–40) to use it on the pedal.')], 'wide')));
  }

  // ---------------- Global
  var UTIL_HINT = {
    opMode: 'PRESET: banks of five presets. SONG: the 99 songs. SET 1–40: the songs of a set in order.',
    clickless: 'Mutes briefly while switching to reduce pops. BI CHANGE: only when the input buffer changes. ALWAYS ON: on every preset or IA change.',
    holdBank: 'What holding MUTE/▼ for a second does in preset mode.',
    mutePos: 'Where MUTE cuts the signal: the volume loop send, the outputs, or nowhere.',
    maxBank: 'The highest bank you can reach with the bank switches.',
    dupPc: 'Send the preset’s program changes again when you select the same preset.',
    syncWith: 'Where the tap tempo goes: MIDI clock (MTC), function switch 1 (for pedals with an analog tap input), or both.',
    syncTime: 'How long the tempo is sent after a tap or preset change.',
    xpdlRate: 'How often the expression pedal is read and sent.',
    fs1: 'How function switch 1 behaves (amp channel switching etc.).', fs2: 'How function switch 2 behaves.',
    isoOut: 'Which signal goes to the transformer-isolated ISO OUT jack.',
    lp5Rtn: 'Loop 5 has a stereo return (TRS). Choose STEREO for stereo pedals.',
    lp6Rtn: 'Loop 6 is stereo in and out (TRS). Choose STEREO for stereo returns.',
    lp6Split: 'ON for a stereo-in pedal in loop 6 (the left send is split to the right send). OFF for mono-in pedals.',
    globalPreset: 'Pressing the switch of the active preset selects the global preset.',
    muteLoop: 'A loop that is switched on while MUTE is on (a tuner loop, for example).',
    bpmDisplay: 'Show the BPM on the display in preset and IA mode.',
    group: 'C1–C5 switches in a group act like radio buttons: only the CC on value is sent.'
  };
  function pageGlobal(m) {
    var img = S.img, grid = h('div', { class: 'grid' });
    m.appendChild(h('div', { class: 'memhead' }, h('div', { class: 'memtitle' }, h('span', { class: 'big2' }, 'Global settings'))));
    m.appendChild(grid);
    // two compact columns like the pedal's own menu: loops, volume, outputs, functions | buffers, C1–C5, XPDL, mute
    function gtable() {
      return h('table', { class: 'mtab gtab' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Channel'), h('th', null, 'CC#'), h('th', null, 'On'), h('th', null, 'Off'))));
    }
    var t = h('div', { class: 'gcols' }), tabs = [gtable(), gtable()], bodies = [h('tbody'), h('tbody')];
    E.GLOBAL_CC.forEach(function (g, i) {
      var c = E.gcc(img, i);
      function setG(k, v) { edit(function () { var o = E.gcc(S.img, i); o[k] = v; E.setGcc(S.img, i, o); }); }
      bodies[i < 11 ? 0 : 1].appendChild(h('tr', { class: c.num == null ? 'off' : '' }, h('th', { title: g.name }, g.id === 'XPDL' ? 'XPDL' : 'CC.' + g.id, h('small', null, g.name)),
        h('td', null, sel(chOpts(), c.ch, function (v) { setG('ch', +v); })),
        h('td', null, num(c.num, 0, 127, function (v) { setG('num', v); }, true)),
        h('td', null, num(c.on, 0, 127, function (v) { setG('on', v); }, !g.xpdl, { title: g.xpdl ? 'Max value' : 'Value when switched on' })),
        h('td', null, num(c.off, 0, 127, function (v) { setG('off', v); }, !g.xpdl, { title: g.xpdl ? 'Min value' : 'Value when switched off' }))));
    });
    tabs.forEach(function (tt, k) { tt.appendChild(bodies[k]); t.appendChild(tt); });
    grid.appendChild(card('Global MIDI', [t,
      h('p', { class: 'info' }, 'The CC each instant-access switch sends when you turn it on or off (empty = OFF). For XPDL, On and Off are the max and min values. CC.MT is sent when mute turns on/off. If a loop (CC.L1–L6) has a CC#, the EFX-LE keeps that loop bypassed and only sends the CC.')], 'wide'));
    var inOpts = chOpts().concat([{ v: '', t: '-- (none)' }]);
    grid.appendChild(card('MIDI in / out', [
      row('Receive channel', sel(inOpts, E.midiInCh(img) == null ? '' : E.midiInCh(img), function (v) { edit(function () { E.setMidiInCh(S.img, v === '' ? null : +v); }); }),
        'The channel the EFX-LE listens on for program changes and loop CCs (Direct mode uses it).'),
      row('MIDI OUT/THRU jack', sel([{ v: 0, t: 'OUT' }, { v: 1, t: 'THRU' }], E.midiThru(img) ? 1 : 0, function (v) { edit(function () { E.setMidiThru(S.img, v === '1'); }); }),
        'OUT: the jack sends the EFX-LE’s own messages (and its data to the editor). THRU: it passes on what comes into MIDI IN. The editor needs OUT to load from the pedal.')
    ]));
    var u = h('div');
    E.UTILITY.forEach(function (x, i) {
      u.appendChild(row(x.name, sel(x.opts.map(function (o, k) { return { v: k, t: o }; }), E.util(img, i), function (v) { edit(function () { E.setUtil(S.img, i, +v); }); }), UTIL_HINT[x.id]));
    });
    grid.appendChild(card('Utility', u));
  }

  // ---------------- Direct
  function pageDirect(m) { window.DIRECT.render(m, api); }

  // ---------------- Help
  function pageHelp(m) {
    m.appendChild(h('div', { class: 'about' },
      h('h2', null, 'EFX-LE Editor ' + VERSION),
      h('p', null, 'A free editor for the Musicom Lab EFX-LE audio controller. It talks to the pedal over MIDI (SysEx) through a USB MIDI interface.'),
      h('h3', null, 'Loading and saving'),
      h('dl', { class: 'helpdl' },
        h('dt', null, 'Load from pedal'), h('dd', null, 'The editor asks the EFX-LE for its data and receives 512 blocks (70,656 bytes). The pedal’s MIDI OUT/THRU must be set to OUT.'),
        h('dt', null, 'Wait for dump from pedal'), h('dd', null, 'If the pedal doesn’t answer, start the dump on the pedal: hold MODE for 2 s › UTILITY (▲) › MIDI SYSEX DATA › DUMP, press STORE (MODE).'),
        h('dt', null, 'Save to pedal'), h('dd', null, 'Sends the data back, a block every 60 ms (about 30 s for everything). If the pedal doesn’t take it, open UTILITY › MIDI SYSEX DATA on the pedal and choose LOAD first. Keep a .syx backup.'),
        h('dt', null, '.syx files'), h('dd', null, 'The same format as the official EFX-LE editor and the pedal’s dump, so files work both ways.')),
      h('h3', null, 'Interfaces'),
      h('p', null, 'Musicom Lab has tested the Roland UM-ONE and the M-Audio Uno with the EFX-LE. Some cheap interfaces drop long SysEx messages; if loading stops part-way, try another interface.'),
      h('h3', null, 'Keyboard'),
      h('p', null, 'Ctrl+Z / Ctrl+Y: undo / redo. In Direct mode: 1–5 select presets, ← → change bank, M changes the switch page.'),
      h('h3', null, 'Links'),
      h('p', null, h('a', { href: 'https://github.com/jonsolberg/efx-le-loop-swither-editor', target: '_blank', rel: 'noopener' }, 'Source code and issues on GitHub'), ' · ',
        h('a', { href: 'https://jonsolberg.se:8080/music.html', target: '_blank', rel: 'noopener' }, 'More music apps on jonsolberg.se'), ' · ',
        h('a', { href: 'http://musicomlab.com/efx-le.htm', target: '_blank', rel: 'noopener' }, 'EFX-LE at Musicom Lab')),
      h('h3', null, 'Support'),
      h('p', null, 'The editor is free, open source and has no ads. If you find it useful, you can support me on Ko-fi.'),
      h('a', { class: 'kofi', href: 'https://ko-fi.com/jonsolberg', target: '_blank', rel: 'noopener' }, '❤ Support me'),
      h('h3', null, 'Licence'),
      h('p', { class: 'note' }, 'Copyright © 2026 Jon Solberg. Free software under the GNU General Public License v3 or later. Not affiliated with Musicom Lab; EFX-LE is their trademark.')
    ));
  }

  // ------------------------------------------------------------------ load / save
  function setData(img, source, fileName) {
    S.img = img; S.base = img.slice(); S.source = source; S.fileName = fileName || '';
    S.undo = []; S.redo = []; S.sel = null;
    changed();
  }
  function guardDirty(f) {
    if (S.source !== 'new' && changedBlocks().length) {
      confirmBox('Discard changes?', 'You have ' + changedBlocks().length + ' changed blocks that are not saved to the pedal. Load anyway?', 'Discard and load', f, true);
    } else f();
  }
  function needMidi(f) {
    if (!M.supported()) { toast('This browser has no Web MIDI. Use Chrome or Edge.', true); return; }
    (M.access ? Promise.resolve() : M.init().then(renderMidibar)).then(function () {
      if (!M.input || !M.output) { toast('Choose the MIDI out and MIDI in for the EFX-LE in the bar at the top.', true); renderMidibar(); return; }
      f();
    }, function (e) { renderMidibar(); toast(e.message, true); });
  }
  function loadFromPedal(wait) {
    wait = wait === true;
    needMidi(function () {
      guardDirty(function () {
        var pb = progressBox(wait ? 'Waiting for the pedal' : 'Loading from the pedal',
          wait ? 'On the pedal: hold MODE › UTILITY › MIDI SYSEX DATA › DUMP, then STORE.' : 'Asking the EFX-LE for its data…', function () { if (M.busy) M.busy.cancel(); });
        M.load(function (n, t) { pb.set(n, t, 'Received ' + n + ' of ' + t + ' blocks…'); }, wait).then(function (img) {
          pb.close(); setData(img, 'pedal'); toast('Loaded all data from the EFX-LE.');
          if (S.page === 'start') go('presets');
        }, function (e) { pb.close(); if (e.message !== 'Cancelled.') toast(e.message, true); });
      });
    });
  }
  function saveToPedal() {
    needMidi(function () {
      var changedList = changedBlocks();
      var onlyChanged = S.source === 'pedal' && localStorage.getItem(KEY_CHANGED) === '1';
      var cb = h('input', { type: 'checkbox', checked: onlyChanged, disabled: S.source !== 'pedal' });
      var body = [
        h('p', null, S.source === 'pedal' && !changedList.length ? 'Nothing has changed since loading. You can still send everything.' :
          'This writes the editor’s data into the EFX-LE and replaces what is in the pedal.'),
        h('label', { class: 'inl' }, cb, ' Only send the ' + changedList.length + ' changed blocks (faster)'),
        S.source !== 'pedal' ? h('p', { class: 'note' }, 'All 512 blocks are sent, because the data didn’t come from this pedal.') : null,
        h('p', { class: 'note' }, 'If the pedal doesn’t take the data, open UTILITY › MIDI SYSEX DATA › LOAD on the pedal first.')
      ];
      modal('Save to pedal', body, [{ t: 'Cancel' }, { t: 'Send', cls: 'primary', f: function () {
        var only = cb.checked && S.source === 'pedal';
        try { localStorage.setItem(KEY_CHANGED, only ? '1' : '0'); } catch (e) { /* ignore */ }
        var blocks = only ? changedList : null;
        if (only && !blocks.length) { toast('Nothing to send.'); return; }
        var total = blocks ? blocks.length : E.BLOCKS;
        var pb = progressBox('Saving to the pedal', 'Sending…', function () { if (M.busy) M.busy.cancel(); });
        M.save(S.img, blocks, function (n, t) { pb.set(n, t, 'Sent ' + n + ' of ' + t + ' blocks (' + Math.ceil((t - n) * 0.06) + ' s left)…'); }).then(function () {
          pb.close(); S.base = S.img.slice(); if (S.source === 'new') S.source = 'pedal';
          changed(); toast('Sent ' + total + ' blocks to the EFX-LE.');
        }, function (e) { pb.close(); toast(e.message, true); });
      } }]);
    });
  }
  function openFile() { guardDirty(function () { $('fileinput').value = ''; $('fileinput').click(); }); }
  function readFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try { setData(E.fromSyx(new Uint8Array(fr.result)), 'file', file.name); toast('Opened ' + file.name + '.'); if (S.page === 'start') go('presets'); }
      catch (e) { toast(file.name + ': ' + e.message, true); }
    };
    fr.readAsArrayBuffer(file);
  }
  function saveFile() {
    var d = new Date(), name = 'EFX-LE ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '.syx';
    var url = URL.createObjectURL(new Blob([E.toSyx(S.img)], { type: 'application/octet-stream' }));
    var a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    if (S.source === 'file') { S.base = S.img.slice(); S.fileName = name; changed(); }
    toast('Saved ' + name + '.');
  }
  function newData() {
    guardDirty(function () {
      confirmBox('Factory data', 'Start from the EFX-LE’s factory settings? The editor’s current data is replaced (the pedal isn’t changed).', 'Start', function () {
        setData(E.createDefault(), 'new'); S.base = null; changed();
      });
    });
  }

  function moreMenu(ev) {
    menu(ev.currentTarget, [
      { t: 'Open .syx file…', f: openFile },
      { t: 'Save .syx file', f: saveFile },
      { t: 'Wait for dump from pedal', f: function () { loadFromPedal(true); } },
      { t: 'Start from factory data…', f: newData },
      null,
      { t: 'Theme: ' + themeName(), f: cycleTheme },
      { t: 'Help', f: function () { go('help'); } }
    ]);
  }
  function themeName() { var t = localStorage.getItem(KEY_THEME); return t === 'dark' ? 'dark' : t === 'light' ? 'light' : 'automatic'; }
  function applyTheme() { var t = localStorage.getItem(KEY_THEME); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
  function cycleTheme() {
    var t = themeName(), n = t === 'automatic' ? 'dark' : t === 'dark' ? 'light' : null;
    try { if (n) localStorage.setItem(KEY_THEME, n); else localStorage.removeItem(KEY_THEME); } catch (e) { /* ignore */ }
    applyTheme(); toast('Theme: ' + themeName());
  }

  // ------------------------------------------------------------------ API for Direct mode
  var api = {
    E: E, M: M, S: S, h: h, sel: sel, toast: toast, card: card, row: row, chOpts: chOpts, go: go,
    connectMidi: connectMidi, needMidi: needMidi, renderMain: function () { renderMain(); }, pad2: pad2
  };

  // ------------------------------------------------------------------ start up
  function init() {
    applyTheme();
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.page); }); });
    $('btnLoad').addEventListener('click', function () { loadFromPedal(false); });
    $('btnSave').addEventListener('click', saveToPedal);
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnMore').addEventListener('click', moreMenu);
    $('status').addEventListener('click', statusPop);
    $('pick').addEventListener('click', function () { document.body.classList.add('show-list'); });
    $('btnCloseList').addEventListener('click', function () { document.body.classList.remove('show-list'); });
    $('filter').addEventListener('input', renderList);
    $('fileinput').addEventListener('change', function () { if (this.files[0]) readFile(this.files[0]); });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === 'z' && !e.shiftKey && tag !== 'input') { e.preventDefault(); undo(); }
        else if ((e.key === 'y' || (e.key === 'z' && e.shiftKey)) && tag !== 'input') { e.preventDefault(); redo(); }
      }
    });
    // drop a .syx file anywhere
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer.files[0]; if (f) guardDirty(function () { readFile(f); }); });
    window.addEventListener('beforeunload', function (e) { if (S.source === 'pedal' && changedBlocks().length) { e.preventDefault(); e.returnValue = ''; } });

    M.onchange = function () { renderMidibar(); renderStatus(); if (S.page === 'direct' || S.page === 'start') renderMain(); };
    var restored = restoreSession();
    if (location.hash.length > 1) S.page = location.hash.slice(1);
    renderMidibar(); render();
    if (restored && S.source !== 'new') toast('Your last session is restored.');
    // Connect quietly if the browser has already allowed MIDI for this site
    if (M.supported() && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'midi', sysex: true }).then(function (st) { if (st.state === 'granted') connectMidi(); }, function () {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
