/*
 * EFX-LE Editor — Web MIDI: choosing devices, loading from and saving to the pedal.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * The EFX-LE has a 5-pin MIDI IN and a MIDI OUT/THRU jack, so it is reached through a USB MIDI interface.
 * People often have several interfaces, so the input and output are chosen explicitly and remembered by name.
 */
(function (root) {
  'use strict';
  var E = root.EFX;
  var KEY_IN = 'efxle.midiIn', KEY_OUT = 'efxle.midiOut';
  var GAP_MS = 60;            // pause between blocks, as the official editor
  var FIRST_MS = 6000, NEXT_MS = 3000, WAIT_MS = 120000;

  var M = {
    access: null, error: null, input: null, output: null,
    listeners: [],            // function(msg Uint8Array, dir 'in'|'out')
    onchange: null,           // devices or selection changed
    busy: null                // current transfer {cancel()}
  };

  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  M.supported = function () { return !!(navigator.requestMIDIAccess); };

  M.init = function () {
    if (M.access) return Promise.resolve(M.access);
    if (!M.supported()) { M.error = 'nomidi'; return Promise.reject(new Error('This browser has no Web MIDI. Use Chrome or Edge.')); }
    return navigator.requestMIDIAccess({ sysex: true }).then(function (acc) {
      M.access = acc; M.error = null;
      acc.onstatechange = function () { autoPick(); changed(); };
      autoPick(); changed();
      return acc;
    }, function (e) {
      M.error = 'denied';
      throw new Error('MIDI access was not allowed (' + (e && e.message || e) + '). Allow MIDI and SysEx for this site in the browser settings.');
    });
  };

  function list(map) { var a = []; if (map) map.forEach(function (p) { a.push(p); }); return a; }
  M.inputs = function () { return list(M.access && M.access.inputs); };
  M.outputs = function () { return list(M.access && M.access.outputs); };

  // a likely MIDI interface: skip software synths and loopback ports
  function guess(ports) {
    var good = ports.filter(function (p) { return !/wavetable|synth|through|thru port|loopmidi|rtpmidi|session/i.test(p.name); });
    var lab = good.filter(function (p) { return /um-one|uno|midisport|usb midi|midi interface|um-1|mio|efx/i.test(p.name); });
    return (lab[0] || (good.length === 1 ? good[0] : null));
  }

  function autoPick() {
    var ins = M.inputs(), outs = M.outputs();
    function find(ports, name) { for (var i = 0; i < ports.length; i++) if (ports[i].name === name) return ports[i]; return null; }
    var inName = recall(KEY_IN), outName = recall(KEY_OUT);
    var inp = inName === '-' ? null : (inName ? find(ins, inName) : guess(ins));
    var out = outName === '-' ? null : (outName ? find(outs, outName) : guess(outs));
    if (!inp && inName && inName !== '-' && M.input && find(ins, M.input.name)) inp = M.input;
    setInput(inp); M.output = out;
  }

  function setInput(p) {
    if (M.input === p) return;
    if (M.input) M.input.onmidimessage = null;
    M.input = p;
    if (p) p.onmidimessage = function (ev) { emit(ev.data, 'in'); };
  }

  M.selectInput = function (id) {
    var p = M.inputs().filter(function (x) { return x.id === id; })[0] || null;
    store(KEY_IN, p ? p.name : '-'); setInput(p); changed();
  };
  M.selectOutput = function (id) {
    var p = M.outputs().filter(function (x) { return x.id === id; })[0] || null;
    store(KEY_OUT, p ? p.name : '-'); M.output = p; changed();
  };

  function changed() { if (M.onchange) M.onchange(); }
  function emit(data, dir) { for (var i = 0; i < M.listeners.length; i++) { try { M.listeners[i](data, dir); } catch (e) { console.error(e); } } }
  M.listen = function (f) { M.listeners.push(f); return function () { M.listeners = M.listeners.filter(function (x) { return x !== f; }); }; };

  M.ready = function () { return !!(M.input && M.output); };

  M.send = function (bytes) {
    if (!M.output) throw new Error('Choose the MIDI output that goes to the EFX-LE.');
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    M.output.send(data);
    emit(data, 'out');
  };

  /**
   * Reads all 512 blocks. With waitForPedal the editor doesn't ask; it waits for the dump started on the pedal
   * (UTILITY › MIDI SYSEX DATA › DUMP). onProgress(received, 512).
   */
  M.load = function (onProgress, waitForPedal) {
    if (!M.input) return Promise.reject(new Error('Choose the MIDI input that comes from the EFX-LE.'));
    if (!waitForPedal && !M.output) return Promise.reject(new Error('Choose the MIDI output that goes to the EFX-LE.'));
    return new Promise(function (resolve, reject) {
      var img = new Uint8Array(E.BLOCKS * E.BLK), seen = new Uint8Array(E.BLOCKS), n = 0, timer = null, done = false;
      var stop = M.listen(function (msg, dir) {
        if (dir !== 'in') return;
        var p = E.parsePacket(msg);
        if (!p) return;
        img.set(p.data, p.index * E.BLK);
        if (!seen[p.index]) { seen[p.index] = 1; n++; }
        if (onProgress) onProgress(n, E.BLOCKS);
        if (n === E.BLOCKS) finish(null);
        else arm(NEXT_MS);
      });
      function arm(ms) { clearTimeout(timer); timer = setTimeout(function () {
        finish(new Error(n === 0
          ? (waitForPedal ? 'No data came from the pedal.' : 'The EFX-LE didn\'t answer. Check the MIDI cables and the chosen devices, and that the pedal\'s MIDI OUT/THRU is set to OUT. You can also start the dump on the pedal (UTILITY › MIDI SYSEX DATA) and use “Wait for dump from pedal”.')
          : 'The data stopped after ' + n + ' of ' + E.BLOCKS + ' blocks. Try again.'));
      }, ms); }
      function finish(err) {
        if (done) return; done = true; clearTimeout(timer); stop(); M.busy = null;
        if (err) reject(err); else resolve(img);
      }
      M.busy = { cancel: function () { finish(new Error('Cancelled.')); } };
      arm(waitForPedal ? WAIT_MS : FIRST_MS);
      if (!waitForPedal) { try { M.send(E.REQUEST); } catch (e) { finish(e); } }
    });
  };

  /** Sends the given blocks (default: all) with a short pause between them. onProgress(sent, total). */
  M.save = function (img, blocks, onProgress) {
    if (!M.output) return Promise.reject(new Error('Choose the MIDI output that goes to the EFX-LE.'));
    blocks = blocks || Array.from({ length: E.BLOCKS }, function (_, i) { return i; });
    return new Promise(function (resolve, reject) {
      var k = 0, cancelled = false, timer = null;
      M.busy = { cancel: function () { cancelled = true; clearTimeout(timer); M.busy = null; reject(new Error('Cancelled after ' + k + ' of ' + blocks.length + ' blocks. The pedal may now hold a mix of old and new data.')); } };
      (function next() {
        if (cancelled) return;
        if (k >= blocks.length) { M.busy = null; resolve(k); return; }
        try { M.send(E.packet(img, blocks[k])); } catch (e) { M.busy = null; reject(e); return; }
        k++;
        if (onProgress) onProgress(k, blocks.length);
        timer = setTimeout(next, GAP_MS);
      })();
    });
  };

  /** Short text for the MIDI monitor. */
  M.describe = function (d) {
    var s = d[0], t = s & 0xF0, ch = (s & 15) + 1;
    if (s === 0xF0) {
      var p = E.parsePacket(d);
      if (p) return 'SysEx EFX-LE data, block ' + p.index;
      if (d.length === E.REQUEST.length && d.every(function (b, i) { return b === E.REQUEST[i]; })) return 'SysEx EFX-LE data request';
      return 'SysEx, ' + d.length + ' bytes';
    }
    if (t === 0xC0) return 'Ch ' + ch + '  Program Change ' + (d[1] + 1);
    if (t === 0xB0) return 'Ch ' + ch + '  CC#' + d[1] + ' = ' + d[2];
    if (t === 0x90) return 'Ch ' + ch + '  Note on ' + d[1] + ' vel ' + d[2];
    if (t === 0x80) return 'Ch ' + ch + '  Note off ' + d[1];
    if (s === 0xF8) return 'Clock';
    if (s === 0xFA) return 'Start'; if (s === 0xFC) return 'Stop';
    return Array.from(d).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); }).join(' ');
  };

  root.MIDI = M;
})(this);
