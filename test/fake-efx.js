// A pretend EFX-LE behind a pretend USB MIDI interface, for testing the editor in a browser without the pedal.
// Injected before the page loads (see test/browser_test.py). window.__efx holds what the pedal received.
(function () {
  'use strict';
  var inPort, outPort, listeners = [];
  var pedal = window.__efx = { img: null, received: [], blocks: {}, cc: [], pc: [] };

  function makeImage() {
    var E = window.EFX, img = E.createDefault();
    var names = ['Clean', 'Crunch', 'Lead', 'Ambient', 'Solo boost', 'Funk', 'Rhythm', 'Big verb', 'Fuzz', 'Acoustic'];
    for (var p = 0; p < 40; p++) E.setTitle(img, p, names[p % names.length] + (p >= 10 ? ' ' + (Math.floor(p / 10) + 1) : ''));
    E.setSw(img, 0, 0, true); E.setSw(img, 0, 2, true);
    E.setSw(img, 1, 1, true); E.setSw(img, 1, 3, true); E.setSw(img, 1, 8, true);
    E.setSw(img, 2, 1, true); E.setSw(img, 2, 4, true); E.setSw(img, 2, 5, true);
    E.setRouting(img, 3, [{ a: 0, spill: false, mix: false, b: null }, { a: 1, spill: false, mix: false, b: null },
      { a: 7, spill: false, mix: false, b: null }, { a: 2, spill: false, mix: false, b: null }, { a: 3, spill: false, mix: false, b: null },
      { a: 6, spill: false, mix: false, b: null }, { a: 4, spill: false, mix: true, b: 5 }]);
    E.setSw(img, 3, 4, true); E.setSw(img, 3, 5, true); E.setSw(img, 3, 0, true);
    E.setPc(img, 0, 1, { ch: 2, num: 12, msb: 0, lsb: null }); E.setCc(img, 0, 0, { ch: 3, num: 69, val: 127 });
    ['Intro', 'Wonderwall', 'Hey Joe', 'Purple Rain', 'Encore'].forEach(function (s, i) { E.setSongTitle(img, i, s); });
    E.setSongPreset(img, 1, 0, { preset: 1, bpm: 96 }); E.setSongPreset(img, 1, 1, { preset: 2, bpm: 'PST' }); E.setSongPreset(img, 1, 2, { preset: 7, bpm: 'GLB' });
    E.setMidiInCh(img, 2);
    return img;
  }

  function deliver(bytes, delay) {
    setTimeout(function () {
      var ev = { data: new Uint8Array(bytes), timeStamp: performance.now() };
      if (inPort.onmidimessage) inPort.onmidimessage(ev);
    }, delay);
  }

  inPort = { id: 'in-1', name: 'UM-ONE', manufacturer: 'Roland', type: 'input', state: 'connected', connection: 'open', onmidimessage: null };
  var synthOut = { id: 'out-0', name: 'Microsoft GS Wavetable Synth', type: 'output', state: 'connected', send: function () {} };
  outPort = {
    id: 'out-1', name: 'UM-ONE', manufacturer: 'Roland', type: 'output', state: 'connected', connection: 'open',
    send: function (data) {
      var d = Array.from(data);
      pedal.received.push(d);
      var E = window.EFX;
      if (!pedal.img) pedal.img = makeImage();
      if (d.length === 8 && d.every(function (b, i) { return b === E.REQUEST[i]; })) {
        // answer with all 512 blocks, a few per millisecond like a real 31,250 baud link would not (fast for tests)
        for (var i = 0; i < E.BLOCKS; i++) deliver(E.packet(pedal.img, i), 5 + Math.floor(i / 8));
        return;
      }
      var p = E.parsePacket(new Uint8Array(d));
      if (p) { pedal.img.set(p.data, p.index * E.BLK); pedal.blocks[p.index] = (pedal.blocks[p.index] || 0) + 1; return; }
      if ((d[0] & 0xF0) === 0xB0) pedal.cc.push([(d[0] & 15) + 1, d[1], d[2]]);
      if ((d[0] & 0xF0) === 0xC0) pedal.pc.push([(d[0] & 15) + 1, d[1]]);
    }
  };
  var access = {
    sysexEnabled: true, onstatechange: null,
    inputs: new Map([['in-1', inPort]]),
    outputs: new Map([['out-0', synthOut], ['out-1', outPort]])
  };
  navigator.requestMIDIAccess = function (opts) { return Promise.resolve(access); };
  pedal.access = access;
})();
