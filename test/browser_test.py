"""End-to-end test of the editor in Chrome with a pretend EFX-LE (test/fake-efx.js).

Run from the repository root:  python3 test/browser_test.py [--shots]
--shots also writes the README screenshots to docs/.
"""
import http.server, os, socketserver, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = '--shots' in sys.argv
OUT = os.path.join(ROOT, 'test', 'out')
os.makedirs(OUT, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=os.path.join(ROOT, 'web'), **k)

    def log_message(self, *a):
        pass


srv = socketserver.TCPServer(('127.0.0.1', 0), Quiet)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{port}/'
fake = open(os.path.join(ROOT, 'test', 'fake-efx.js')).read()
errors = []


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('ok -', msg)


def shot(page, name, full=False):
    path = os.path.join(OUT, name + '.png')
    page.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
    page.screenshot(path=path, full_page=full)
    return path


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 1280, 'height': 820}, device_scale_factor=1, color_scheme='dark')
    ctx.add_init_script(fake)
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector('.hero')
    if SHOTS:
        page.click('.midibar button:has-text("Connect MIDI")')
        page.wait_for_selector('.mbpick')
        shot(page, 'start')
    else:
        page.click('.midibar button:has-text("Connect MIDI")')

    # devices: the interface is picked automatically, the software synth is not
    out_sel = page.locator('.mbpick select').nth(0)
    check(out_sel.input_value() == 'out-1', 'MIDI out picks the interface, not the software synth')
    check(page.locator('.mbpick select').nth(1).input_value() == 'in-1', 'MIDI in picked')

    # load
    page.click('#btnLoad')
    page.wait_for_function("document.querySelector('#status').textContent.includes('From pedal')", timeout=15000)
    check(page.evaluate("EFX.title(window.__efx.img, 1)") == 'Crunch      ', 'pedal image has test titles')
    page.wait_for_selector('#list li')
    check('Crunch' in page.locator('#list li').nth(1).inner_text(), 'preset list shows titles from the pedal')

    # edit preset 1: title, a switch, PC
    page.locator('#list li').nth(0).click()
    page.fill('input.name', 'My Clean')
    page.press('input.name', 'Tab')
    page.click('button.fxsw:has-text("L4")')
    page.locator('table.mtab').first.locator('tbody tr').nth(2).locator('input').nth(0).fill('77')
    page.locator('table.mtab').first.locator('tbody tr').nth(2).locator('input').nth(0).press('Tab')
    check('My Clean' in page.locator('#list li').nth(0).inner_text(), 'title edit shows in the list')
    check('changed' in page.locator('#status').inner_text(), 'status shows changed blocks')

    # routing: put L5 parallel with L6, then spill L1
    page.locator('button.rbox', has_text='L5').click()
    page.click('.rtools button:has-text("Parallel")')
    page.locator('.rtools select').select_option(label='L6')
    check(page.locator('.mixnode').count() == 1, 'parallel block drawn')
    page.locator('button.rbox', has_text='L1').click()
    page.click('.rtools button:has-text("Spill-over")')
    check(page.locator('.spilltag').count() == 1, 'spill-over drawn')
    check('2 of 2' in page.locator('.mixcount').inner_text(), 'two mixers in use')
    # a third mixer is refused
    page.locator('button.rbox', has_text='L2').click()
    page.click('.rtools button:has-text("Spill-over")')
    page.wait_for_selector('.toast.err')
    check('No more mixers' in page.locator('.toast.err').inner_text(), 'a third mixer is refused')
    if SHOTS:
        page.locator('button.rbox', has_text='L5').click()
        page.evaluate("document.querySelector('main').scrollTop = 0")
        shot(page, 'presets')

    # undo / redo
    page.click('#btnUndo')
    check(page.locator('.spilltag').count() == 0, 'undo removes the spill-over')
    page.click('#btnRedo')
    check(page.locator('.spilltag').count() == 1, 'redo puts it back')

    # songs and sets
    page.click('nav.tabs button[data-page=songs]')
    page.locator('#list li').nth(1).click()
    check(page.locator('input.name').input_value() == 'Wonderwall', 'song title shown')
    page.locator('table.songtab tbody tr').nth(3).locator('select').nth(0).select_option('3')
    page.locator('table.songtab tbody tr').nth(3).locator('select').nth(1).select_option('140')
    if SHOTS:
        shot(page, 'songs')
    page.click('nav.tabs button[data-page=sets]')
    page.locator('.setgrid li').nth(0).locator('select').select_option('4')

    # global
    page.click('nav.tabs button[data-page=global]')
    page.locator('.gtab tbody tr').nth(19).locator('input').nth(0).fill('20')
    page.locator('.gtab tbody tr').nth(19).locator('input').nth(0).press('Tab')
    if SHOTS:
        page.evaluate("document.querySelector('main').scrollTop = 0")
        shot(page, 'global')
        shot(page, 'global-full', full=True)

    # save to pedal: only changed blocks
    page.click('#btnSave')
    page.check('.modal input[type=checkbox]')
    page.click('.modal button:has-text("Send")')
    page.wait_for_function("!document.querySelector('#status').textContent.includes('changed')", timeout=20000)
    res = page.evaluate("""() => {
      const E = EFX, m = window.__efx.img;
      return { title: E.title(m, 0), l4: E.sw(m, 0, 3), pc3: E.pc(m, 0, 2), r: E.routing(m, 0), song: E.songPreset(m, 1, 3),
               set0: E.setSong(m, 0, 0), mt: E.gcc(m, 19), blocks: Object.keys(window.__efx.blocks).map(Number).sort((a, b) => a - b) };
    }""")
    check(res['title'] == 'My Clean    ', 'pedal got the new title')
    check(res['l4'] is True, 'pedal got the switch')
    check(res['pc3']['num'] == 77, 'pedal got the program change')
    nodes = res['r']['nodes']
    check(res['r']['ok'] and any(n['mix'] and n['a'] == 4 and n['b'] == 5 for n in nodes) and nodes[0]['spill'], 'pedal got the routing')
    check(res['song'] == {'preset': 3, 'bpm': 140}, 'pedal got the song preset')
    check(res['set0'] == 4, 'pedal got the set')
    check(res['mt']['num'] == 20, 'pedal got the global CC')
    check(res['blocks'] == [0, 362, 460, 510], 'only the changed blocks were sent: %s' % res['blocks'])

    # .syx download round trip
    with page.expect_download() as dl:
        page.click('#btnMore')
        page.click('.menu button:has-text("Save .syx file")')
    path = dl.value.path()
    check(os.path.getsize(path) == 70656, '.syx file is 70,656 bytes')

    # direct mode
    page.click('nav.tabs button[data-page=direct]')
    page.wait_for_selector('.efxpanel')
    page.click('.efxbot .efxstomp >> nth=1')
    pcs = page.evaluate('window.__efx.pc')
    ccs = page.evaluate('window.__efx.cc')
    check(pcs[-1:] == [[2, 1]] and ccs[-1:] == [[2, 0, 0]], 'preset switch 2 sends CC#0 0 + PC 2 on the pedal channel (2): %s %s' % (pcs[-3:], ccs[-3:]))
    check('Crunch' in page.locator('.efxlcd').inner_text(), 'LCD shows the preset title')
    page.click('.efxtop .efxstomp >> nth=0')       # MODE -> IA1
    page.click('.efxbot .efxstomp >> nth=2')       # L3
    check(page.evaluate('window.__efx.cc')[-1] == [2, 66, 127], 'IA1 switch 3 sends CC#66 = 127')
    page.keyboard.press('ArrowRight')             # bank up from IA -> toggles L6 (▲)
    page.keyboard.press('Escape')
    page.keyboard.press('ArrowRight')
    page.keyboard.press('ArrowRight')
    page.keyboard.press('5')
    check(page.evaluate('window.__efx.pc')[-1] == [2, 14], 'bank 3 preset 5 = PC 15 via keyboard')
    if SHOTS:
        page.click('.efxbot .efxstomp >> nth=0')
        page.evaluate("document.querySelector('main').scrollTop = 0")
        shot(page, 'direct')

    # light theme + phone layout
    if SHOTS:
        page.click('nav.tabs button[data-page=presets]')
        page.locator('#list li').nth(3).click()
        mob = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme='light', is_mobile=True, has_touch=True)
        mob.add_init_script(fake)
        mp = mob.new_page()
        mp.goto(URL + '#presets')
        mp.wait_for_selector('#main .memhead')
        shot(mp, 'phone-presets')
        mp.click('nav.tabs button[data-page=direct]')
        shot(mp, 'phone-direct')

    browser.close()

real_errors = [e for e in errors if 'favicon' not in e]
check(not real_errors, 'no errors in the console: %s' % real_errors)
print('\nAll browser checks passed.')
