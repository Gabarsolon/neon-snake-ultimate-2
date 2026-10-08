#!/usr/bin/env node
// Headless checks for Neon Snake: console errors, game invariants, screenshots, frame pacing.
// node test/harness.mjs [--quick] [--only=name1,name2] [--quiet]
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, ascii, patch, maxBox, meanLuma, meanDiff, stripes } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const shots = path.join(here, 'shots');
const CHROME = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const QUICK = process.argv.includes('--quick');
const QUIET = process.argv.includes('--quiet');
const ONLY = new Set(((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || '').split(',').filter(Boolean));

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };

// ── the page under test: index.html with the outer iife unwrapped ──────────
function buildPage() {
  const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const open = "(() => {\n'use strict';\n";
  if (!src.includes(open)) throw new Error('iife opener not found');
  const page = src.replace(open, '').replace(/\}\)\(\);\s*<\/script>/, '</script>');
  fs.writeFileSync(path.join(here, 'page.html'), page);
  return page.length;
}

const BOOTSTRAP = `
window.__realRAF = window.requestAnimationFrame.bind(window);
window.__rafQ = []; window.__t = 0;
window.requestAnimationFrame = (cb) => { window.__rafQ.push(cb); return window.__rafQ.length; };
window.__pump = (dt = 1000 / 60) => { window.__t += dt; const q = window.__rafQ; window.__rafQ = []; for (const cb of q) cb(window.__t); };
window.__live = () => { window.requestAnimationFrame = window.__realRAF; };
(() => { let s = 0x2f6e2b1; Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
try { localStorage.clear(); } catch (e) {}   // settings must not leak from one scene into the next
// device metrics alone never make pointer:coarse match, and the game reads it once at boot
if (/[?&]coarse=1/.test(location.search)) {
  const rm = window.matchMedia.bind(window);
  window.matchMedia = (q) => /pointer:\\s*coarse/.test(q)
    ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
    : rm(q);
}
`;

// ── chrome + cdp ───────────────────────────────────────────────────────────
async function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function serve(port) {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    const file = path.join(here, name === '/' ? 'page.html' : decodeURIComponent(name.slice(1)));
    if (!file.startsWith(here) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
function cdp(ws) {
  let id = 0; const pending = new Map(), listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) for (const f of listeners) f(m);
  };
  return {
    on: (f) => listeners.push(f),
    send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); }),
  };
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  console.log('page:', buildPage(), 'bytes');
  const port = await freePort();
  const server = await serve(port);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + (port + 1), '--user-data-dir=' + profile,
    '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900', '--force-device-scale-factor=2', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', (d) => { chromeLog += d; });

  // wait for devtools
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await fetch(`http://127.0.0.1:${port + 1}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch (e) {}
  }
  if (!target) { console.error('no devtools target\n' + chromeLog.slice(-2000)); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const c = cdp(ws);
  const errors = [], requests = [];
  const NOISE = /navigator\.vibrate|user hasn't tapped|favicon/i;
  const errs = () => errors.filter((e) => !NOISE.test(e));
  c.on(async (m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') console.log('  page warn: ' + m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Network.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP });

  const evalx = async (expression) => {
    const p = c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    p.catch(() => {});                                   // a late failure after the race must not crash node
    const r = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('evalx timeout after 90s: ' + String(expression).slice(0, 90))), 90000)),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const ms = (t, label) => { const d = Date.now() - t; if (d > 300) console.log(`    · ${label} ${d}ms`); return Date.now(); };
  const go = async (device) => {
    let t = Date.now();
    errors.length = 0;
    await c.send('Emulation.setDeviceMetricsOverride', { width: device.w, height: device.h, deviceScaleFactor: device.dpr, mobile: !!device.mobile });
    t = ms(t, 'metrics');
    const url = `http://127.0.0.1:${port}/?r=${Math.random()}${device.coarse ? '&coarse=1' : ''}`;
    await c.send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) {   // the context dies mid-navigation, so keep trying
      try { if (await evalx(`location.href.startsWith(${JSON.stringify('http://127.0.0.1:' + port + '/')}) && document.readyState === 'complete' && typeof fx === 'object'`)) break; } catch (e) {}
      await new Promise((r) => setTimeout(r, 50));
    }
    ms(t, 'navigate+ready');
    t = Date.now();
    try { await evalx('audio.unlock()'); } catch (e) {}   // start the scheduler so its exceptions surface as errors
    await settle(8);
    ms(t, 'settle');
  };
  const settle = async (n = 4) => drive(n, null);
  const shot = async (name) => {
    const t = Date.now();
    // the player sees the gl canvas when it is on; read that, and render in the same task
    // (a drawing buffer is blank once it has been composited)
    const url = await evalx(`(() => { const g = document.getElementById('g');
      const cv = g && getComputedStyle(g).display !== 'none' ? g : document.getElementById('c');
      __pump(); return cv.toDataURL('image/png'); })()`);
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    fs.writeFileSync(path.join(shots, name + '.png'), buf);
    const img = decodePNG(buf);
    if (Date.now() - t > 500) console.log(`    · shot ${name} ${Date.now() - t}ms`);
    console.log(`  shot ${name}.png ${img.w}x${img.h} luma=${meanLuma(img).toFixed(1)}`);
    if (!QUIET) console.log(ascii(img).split('\n').map((l) => '  |' + l + '|').join('\n'));
    return img;
  };
  // a real page capture (dom included) — for what only css draws: overlays, digit reels, big numbers
  const pageShot = async (name, clip) => {
    const t = Date.now();
    const r = await c.send('Page.captureScreenshot', { format: 'png', clip });
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(path.join(shots, name + '.png'), buf);
    const img = decodePNG(buf);
    if (Date.now() - t > 500) console.log(`    · page shot ${name} ${Date.now() - t}ms`);
    console.log(`  page ${name}.png ${img.w}x${img.h} luma=${meanLuma(img).toFixed(1)}`);
    if (!QUIET) console.log(ascii(img).split('\n').map((l) => '  |' + l + '|').join('\n'));
    return img;
  };
  // one round trip for the whole loop: each pass runs the frame hook, then the game's own frame
  const drive = async (n, frame) => {
    const t = Date.now();
    await evalx(`(() => { for (let i = 0; i < ${n}; i++) {\n${frame || ''}\n; __pump(); } return 1; })()`);
    ms(t, 'drive ' + n);
  };
  const AI = `if (typeof G !== 'undefined' && G && G.alive) { G.queue.length = 0; const d = aiChoose(G); if (d) G.queue.push(d); }`;

  // readbacks are slow under swiftshader (≈6.5s per megapixel + a few seconds of warm-up per page),
  // so most scenes shoot small and only the hero frames go retina
  const DESK = { w: 960, h: 600, dpr: 1 };
  const HI = process.env.DEV === 'small' ? DESK : { w: 1440, h: 900, dpr: 2 };
  const PHONE = { w: 390, h: 844, dpr: 3, mobile: true, coarse: true };
  const scenes = [];

  // ── the checks ─────────────────────────────────────────────────────────
  scenes.push(['boot', async () => {
    await go(HI);
    const env = await evalx('({ ok: fx.ok, snake: fx.snakeOk, mode, w: canvas.width, h: canvas.height, cw: innerWidth, ch: innerHeight, dpr: devicePixelRatio, gl: document.body.classList.contains("gl"), hdr: fx.hdr })');
    console.log('  fx.ok=' + env.ok, 'snakeOk=' + env.snake, 'hdr=' + env.hdr, 'canvas=' + env.w + 'x' + env.h, 'mode=' + env.mode);
    ok(env.ok === true, 'webgl available');
    ok(env.snake === true, 'gpu snake program built');
    ok(env.hdr === true, 'half-float targets');
    ok(env.w === env.cw * env.dpr && env.h === env.ch * env.dpr, 'canvas is css × dpr (' + env.w + 'x' + env.h + ')');
    const ext = requests.filter((u) => !u.startsWith(location0(port)) && !u.startsWith('data:'));
    ok(ext.length === 0, 'no external requests' + (ext.length ? ': ' + ext.join(', ') : ''));
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  scenes.push(['menu', async () => {
    await go(HI);
    await settle(30);
    const before = await evalx(`(() => {
      const st = getComputedStyle(document.getElementById('menu'));
      return { mode, visible: st.visibility === 'visible', modeAttr: document.body.dataset.mode,
        play: !!document.getElementById('btnPlay'), best: document.getElementById('menuBest').textContent,
        chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent.trim()) };
    })()`);
    console.log('  ' + JSON.stringify(before));
    await shot('menu');
    ok(before.mode === 'menu' && before.modeAttr === 'menu', 'boots into the menu, body marked');
    ok(before.visible, 'menu overlay is on screen');
    ok(before.play, 'PLAY button present');
    ok(before.chips.length === 5, 'five setting chips: ' + before.chips.join(' | '));
    await evalx('document.getElementById("btnPlay").click()');
    await settle(6);
    const after = await evalx('({ mode, overlay: getComputedStyle(document.getElementById("menu")).visibility })');
    console.log('  after click ' + JSON.stringify(after));
    ok(after.mode === 'playing', 'PLAY button starts a game');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['play', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(QUICK ? 90 : 300, AI);
    const s = await evalx('({ mode, len: P.snake.length, score: P.score, alive: P.alive, pn: PN, ok: fx.snakeOk })');
    console.log('  ' + JSON.stringify(s));
    ok(s.mode === 'playing', 'game is running');
    ok(s.pn >= 2, 'path has samples (PN=' + s.pn + ')');
    const au = await evalx('audio.clock()');
    console.log('  audio ' + JSON.stringify(au));
    ok(au.state === 'running' && au.steps > 0, 'music scheduler running (' + au.steps + ' steps, key +' + au.key + ')');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
    const bad = await evalx(`(() => {
      const g = P, out = [];
      const seen = new Set();
      for (const c of g.snake) { const k = c.x + ',' + c.y; if (seen.has(k)) out.push('dup ' + k); seen.add(k); if (c.x < 0 || c.x >= g.cols || c.y < 0 || c.y >= g.rows) out.push('oob ' + k); }
      if (g.food && !g.pending && seen.has(g.food.x + ',' + g.food.y)) out.push('food on snake');
      if (g.bonus && !g.pending && seen.has(g.bonus.x + ',' + g.bonus.y)) out.push('bonus on snake');
      for (let i = 0; i < PN; i++) if (!isFinite(PX[i]) || !isFinite(PY[i]) || !isFinite(PR[i]) || PR[i] < 0) { out.push('bad sample ' + i); break; }
      for (let i = 1; i < PN; i++) if (PS[i] <= PS[i - 1]) { out.push('arc not rising at ' + i); break; }
      if (g.snake.length < 2) out.push('snake too short');
      if (!(g.score >= 0)) out.push('score not a number');
      return out;
    })()`);
    ok(bad.length === 0, 'invariants' + (bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''));
    await shot('play');
    const geo = await evalx('(() => { const s = snakeGeo(P); if (!s) return "null"; const r = s.runs[0]; return { n: s.n, runs: s.runs.length, head: r.head, cnt: r.cnt, eye: s.eyeOn, dy: s.dy }; })()');
    console.log('  geo ' + JSON.stringify(geo));
    ok(geo !== 'null' && geo.head === true && geo.cnt >= 4, 'tube geometry built for the head run');
    ok(geo.eye === true, 'eye punch enabled while alive');
    const od = await evalx('({ n: document.getElementById("score").children.length, s: Math.round(shownScore) })');
    ok(od.n === String(od.s).length, 'score odometer shows every digit (' + od.s + ' → ' + od.n + ' reels)');
  }]);

  scenes.push(['pixels', async () => {
    // what the frame actually looks like: orientation, snake brightness, eyes showing through
    await go(DESK);
    await evalx('startGame()');
    await drive(120, AI);
    await evalx('G.food = { x: 1, y: 1, born: G.time, golden: false };');
    await drive(4, AI);
    const geo = await evalx(`(() => {
      const z = 1 + punch + camZ;
      const tx = (bx + bw / 2) * (1 - z) + shX + camX, ty = (by + bh / 2) * (1 - z) + shY + camY;
      const m = (x, y) => [(x * z + tx) * dpr, (y * z + ty) * dpr];
      const s = snakeGeo(P);
      const body = [];
      for (const i of [~~(PN * 0.4), ~~(PN * 0.62), ~~(PN * 0.88)]) body.push(m(bx + (PX[i] + 0.5) * cell, by + (PY[i] + 0.5) * cell));
      return { body, food: m(cellX(1), cellY(1)), eye: m(s.eye[0], s.eye[1]), eyeR: Math.max(4, cell * dpr * 0.3), size: [canvas.width, canvas.height] };
    })()`);
    const img = await shot('pixels');
    const onC = await evalx('(() => { __pump(); const c = document.getElementById("c"); return c.toDataURL("image/png"); })()');
    const sceneImg = decodePNG(Buffer.from(onC.slice(onC.indexOf(',') + 1), 'base64'));
    const bg = patch(img, 8, 8, 3).reduce((a, b) => a + b, 0) / 3;
    const foodL = maxBox(img, geo.food[0], geo.food[1], 4);
    const mirL = maxBox(img, geo.food[0], img.h - geo.food[1], 4);
    const bodyL = geo.body.map((p) => maxBox(img, p[0], p[1], 2));
    const bodyC = geo.body.map((p) => maxBox(sceneImg, p[0], p[1], 2));
    const eyeL = maxBox(img, geo.eye[0], geo.eye[1], geo.eyeR);
    console.log(`  bg=${bg.toFixed(1)} food=${foodL.toFixed(1)} mirror=${mirL.toFixed(1)} body(gl)=${bodyL.map((v) => v.toFixed(0)).join('/')} body(scene)=${bodyC.map((v) => v.toFixed(0)).join('/')} eye=${eyeL.toFixed(0)}`);
    ok(img.w === geo.size[0] && img.h === geo.size[1], 'screenshot matches the canvas');
    ok(foodL > 80, 'food is bright where it sits (' + foodL.toFixed(0) + ')');
    ok(mirL < 100, 'nothing at the mirrored spot, so the frame is not flipped (' + mirL.toFixed(0) + ')');
    ok(Math.min(...bodyL) > bg + 25, 'gl tube is lit along the body (' + bodyL.map((v) => v.toFixed(0)).join('/') + ' vs bg ' + bg.toFixed(0) + ')');
    ok(eyeL > 150, 'eye shows through the punch (' + eyeL.toFixed(0) + ')');
    await evalx('fx.snakeOk = false');
    await drive(3, AI);
    const img2 = await shot('pixels-2dfallback');
    const bodyL2 = geo.body.map((p) => maxBox(img2, p[0], p[1], 2));
    console.log('  2d fallback body=' + bodyL2.map((v) => v.toFixed(0)).join('/'));
    ok(Math.min(...bodyL2) > bg + 25, '2d capsule tube fallback still draws');
    await evalx('fx.snakeOk = true');
    await drive(3, AI);
    const img3 = await shot('pixels-glb');
    ok(Math.min(...geo.body.map((p) => maxBox(img3, p[0], p[1], 2))) > bg + 25, 'back on the gl tube after the toggle');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  scenes.push(['overdrive', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(60, AI);
    await evalx('boostHeld = true; P.energy = 100');
    await drive(70, AI + '; boostHeld = true; P.energy = 100');
    const b = await evalx('({ boost: P.boosting, fx: boostFx, energy: P.energy })');
    console.log('  ' + JSON.stringify(b));
    ok(b.boost === true, 'overdrive engaged');
    await shot('overdrive');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['golden', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(40, AI + '; if (G.food) G.food.golden = true;');
    await drive(20, AI + '; if (G.food) G.food.golden = true;');
    const st = await evalx('({ imp, gold: !!(G.food && G.food.golden), combo: G.combo, spawned: G.spawned })');
    console.log('  ' + JSON.stringify(st));
    await shot('golden');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['nova', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(30, AI);
    await evalx('G.bonusIn = 1; G.pending = null; resolveEat(G)');   // bonus only rolls on after a real eat
    await drive(10, AI);
    const st = await evalx('({ has: !!G.bonus, novas: G.novas, spawned: G.spawned })');
    console.log('  ' + JSON.stringify(st));
    await shot('nova');
    ok(st.has === true, 'nova spawned');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['death', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(80, AI);
    await evalx('die(P, false)');
    await drive(26, null);
    await shot('dissolve');
    const mid = await evalx('({ dissolve: G.dissolve, alive: G.alive, mode })');
    await drive(90, null);
    await shot('gameover');
    const end = await evalx('({ mode, alive: G.alive, done: G.done })');
    const ov = await evalx(`(() => { const st = getComputedStyle(document.getElementById('over'));
      return { vis: st.visibility, title: document.getElementById('overTitle').textContent, again: !!document.getElementById('btnAgain'), modeAttr: document.body.dataset.mode }; })()`);
    console.log('  mid ' + JSON.stringify(mid), 'end ' + JSON.stringify(end), 'over ' + JSON.stringify(ov));
    ok(mid.dissolve > 0 && mid.alive === false, 'snake dissolving (dissolve=' + mid.dissolve.toFixed(2) + ')');
    ok(end.mode === 'over', 'reached the game over screen');
    ok(ov.vis === 'visible' && ov.again && ov.modeAttr === 'over', 'game over overlay up with a PLAY AGAIN button');
    const od = await evalx(`(() => { const slots = (id) => { const el = document.getElementById(id);
      return el.children.length > 0 && [...el.children].every((d) => d.className === 'd' && d.firstChild.children.length === 10); };
      return { score: slots('score'), fin: slots('final'), n: document.getElementById('score').children.length }; })()`);
    ok(od.score && od.fin, 'score and final are odometer reels (' + JSON.stringify(od) + ')');
    await new Promise((r) => setTimeout(r, 900));   // let the panel and the count-up settle
    const fr = await evalx("(() => { const b = document.getElementById('final').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()");
    const dom = await pageShot('dom-over', { x: Math.max(0, fr[0] - 40), y: Math.max(0, fr[1] - 40), width: fr[2] + 80, height: fr[3] + 80, scale: 1 });
    const paint = maxBox(dom, dom.w >> 1, dom.h >> 1, Math.round(Math.min(dom.w, dom.h) * 0.35));
    ok(paint > 140, 'the final score paints on screen (' + paint.toFixed(0) + ')');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  scenes.push(['themes', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(80, AI);
    for (const th of await evalx('THEMES.map(t => t.id)')) {
      await evalx(`opts.theme = THEMES.find(t => t.id === ${JSON.stringify(th)}); paintSettings();`);
      await drive(35, AI);
      await shot('theme-' + th);
    }
    await evalx('opts.theme = THEMES[0]; paintSettings()');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  scenes.push(['portal', async () => {
    await go(DESK);
    await evalx('opts.portal = true; store.set("walls", "portal"); startGame(); buildPath(G)');
    await drive(40, AI);
    // lay the body out in a straight line aimed at the left wall, then let it walk through
    await evalx(`(() => { const g = P, y = (g.rows >> 1) - 1;
      for (let i = 0; i < g.snake.length; i++) { g.snake[i].x = 1 + i; g.snake[i].y = y; }
      g.queue.length = 0; g.dir = { x: -1, y: 0 }; g.prevTail = null; return 1; })()`);
    const watch = await evalx(`(() => { const out = [];
      for (let i = 0; i < 44; i++) { __pump(); out.push(runs.length / 4); }
      return { out, max: Math.max(...out), hx: P.snake[0].x, cols: P.cols, alive: P.alive, len: P.snake.length,
        runs: runs.length / 4, portal: opts.portal }; })()`);
    console.log('  runs per frame [' + watch.out.join(',') + ']');
    await shot('portal');
    const geo = await evalx('(() => { const s = snakeGeo(P); return { n: s ? s.n : 0, runs: s ? s.runs.length : 0, globalRuns: runs.length / 4 }; })()');
    console.log('  ' + JSON.stringify(watch) + '  geo ' + JSON.stringify(geo));
    ok(watch.alive === true, 'snake still alive after crossing');
    ok(watch.hx > watch.cols / 2, 'head wrapped to the far side (x=' + watch.hx + ' of ' + watch.cols + ')');
    ok(watch.max >= 2, 'crossing split the tube (max ' + watch.max + ' runs)');
    ok(watch.out.every((v) => v >= 1), 'never an empty run list');
    ok(geo.runs === geo.globalRuns, 'geometry mirrors the split (' + geo.runs + '/' + geo.globalRuns + ')');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['crt', async () => {
    await go(DESK);
    await evalx('opts.crt = false; startGame()');
    await drive(90, AI);
    // same game state, two renders — so the only thing that can differ is the crt pass itself
    const pair = await evalx(`(() => {
      const g = document.getElementById('g'), c = document.getElementById('c');
      const pick = () => ((g && getComputedStyle(g).display !== 'none') ? g : c);
      opts.crt = false; render(); const a = pick().toDataURL('image/png');
      opts.crt = true; render(); const b = pick().toDataURL('image/png');
      opts.crt = false; render();
      opts.crt = true; render(); const cScene = c.toDataURL('image/png');
      opts.crt = false; render();
      return { ids: [g ? 'g:' + g.width + 'x' + g.height : null, c ? 'c:' + c.width + 'x' + c.height : null],
        gl: document.body.classList.contains('gl'), ok: fx.ok, snakeOk: fx.snakeOk, a, b, cScene };
    })()`);
    console.log('  ' + JSON.stringify({ ids: pair.ids, gl: pair.gl, ok: pair.ok, snakeOk: pair.snakeOk }));
    const buf = (s) => Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
    fs.writeFileSync(path.join(shots, 'crt-off.png'), buf(pair.a));
    fs.writeFileSync(path.join(shots, 'crt-on.png'), buf(pair.b));
    const off = decodePNG(buf(pair.a)), on = decodePNG(buf(pair.b));
    const d = meanDiff(off, on), s0 = stripes(off), s1 = stripes(on);
    console.log(`  Δ=${d.toFixed(2)}  stripes off=${s0.toFixed(2)} on=${s1.toFixed(2)}`);
    ok(d > 0.7, 'crt pass visibly changes the frame (Δ' + d.toFixed(2) + ')');
    ok(s1 > s0 * 1.5, 'crt adds scanline striping (' + s0.toFixed(2) + ' → ' + s1.toFixed(2) + ')');
    await evalx('document.getElementById("optCrt").click()');
    const st = await evalx('({ crt: opts.crt, cls: document.body.classList.contains("crt-on"), saved: store.get("crt", "0") })');
    console.log('  ' + JSON.stringify(st));
    ok(st.crt === true && st.cls && st.saved === '1', 'CRT chip turns it on and saves it');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['solid', async () => {
    await go(DESK);
    await evalx('opts.portal = false; store.set("walls", "solid"); startGame(); buildPath(G)');
    await drive(90, AI);
    const st = await evalx('({ runs: runs.length / 4, portal: opts.portal })');
    ok(st.runs === 1, 'one continuous run with solid walls');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['phone', async () => {
    await go(PHONE);
    await evalx('startGame()');
    await drive(140, AI);
    const st = await evalx(`(() => {
      const keys = getComputedStyle(document.querySelector('.keys.touch'));
      const meter = getComputedStyle(document.querySelector('.meter'));
      return { w: W, h: H, dpr, cell, mode, coarse, bodyCoarse: document.body.classList.contains('coarse'),
        keysShown: keys.display !== 'none', meterHidden: meter.display === 'none' || meter.opacity === '0', deck: deckH };
    })()`);
    console.log('  ' + JSON.stringify(st));
    await shot('phone');
    ok(st.mode === 'playing', 'runs at phone size');
    ok(st.coarse === true && st.bodyCoarse, 'touch layout engaged at boot');
    ok(st.keysShown && st.meterHidden, 'touch key hints shown, desktop meter hidden');
    ok(st.deck > 0, 'touch deck sized (' + st.deck + 'px)');
    ok(errs().length === 0, 'no console errors');
  }]);

  scenes.push(['reduced', async () => {
    // reduced motion is read once at boot, so the page is emulated before it loads
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await go(DESK);
    const st = await evalx('({ calm, mode })');
    await evalx('startGame()');
    await drive(90, AI);
    await shot('reduced');
    ok(st.calm === true, 'reduced motion honoured');
    ok(errs().length === 0, 'no console errors');
    await c.send('Emulation.setEmulatedMedia', { features: [] });
  }]);

  scenes.push(['pacing', async () => {
    await go(DESK);
    await evalx('startGame()');
    await drive(40, AI);
    await evalx('__live()');
    // let the real raf loop run on its own for a couple of seconds
    await new Promise((r) => setTimeout(r, QUICK ? 1500 : 3000));
    const p = await evalx('({ cost: +cost.toFixed(2), pace: +pace.toFixed(4), quality, slowFor: +slowFor.toFixed(2), renderer: fx.renderer })');
    const soft = /swiftshader|llvmpipe|software/i.test(p.renderer || '');
    console.log('  ' + JSON.stringify(p) + (soft ? '   (software rendering: timing not representative)' : ''));
    ok(soft || p.cost < 8, 'js+gl under 8ms per frame (' + p.cost + 'ms)');
    ok(soft || p.pace < 0.02, 'frame pacing near vsync (' + (p.pace * 1000).toFixed(1) + 'ms)');
    ok(soft || p.quality > 0.5, 'quality scaler did not downscale (' + p.quality + ')');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  scenes.push(['audio', async () => {
    await go(DESK);
    await evalx('startGame(); audio.heat(5)');
    await drive(30, AI + '; G.combo = 5; audio.heat(5)');
    const a = await evalx('audio.clock()');
    await new Promise((r) => setTimeout(r, 900));
    const b = await evalx('audio.clock()');
    // jump into the break bar (cycle 7, bar 3): kick and bass drop, lead answers, riser into the key turn
    await evalx('audio.clock(7 * 64 + 3 * 16)');
    await new Promise((r) => setTimeout(r, 1400));
    const c = await evalx('audio.clock()');
    // two steps before the next key turn (cycle 8, bar 0)
    await evalx('audio.clock(8 * 64 - 2)');
    await new Promise((r) => setTimeout(r, 900));
    const d = await evalx('audio.clock()');
    console.log('  ' + JSON.stringify({ a, b, c, d }));
    ok(a.state === 'running', 'audio context running');
    ok(b.steps > a.steps, 'scheduler keeps stepping (' + a.steps + ' → ' + b.steps + ')');
    ok(c.steps >= 7 * 64 + 3 * 16 && c.steps < 8 * 64, 'break bar plays (' + (c.steps - (7 * 64 + 3 * 16)) + ' steps in)');
    ok(d.key === -1, 'key turns at the phrase boundary (key ' + d.key + ')');
    ok(errs().length === 0, 'no console errors' + (errs().length ? ': ' + errs()[0] : ''));
  }]);

  for (const [name, fn] of scenes) {
    if (ONLY.size && !ONLY.has(name)) continue;
    console.log('\n— ' + name);
    const t = Date.now();
    try { await fn(); } catch (e) { failed++; console.log('  FAIL ' + (e.stack || e.message)); }
    console.log('  (' + (Date.now() - t) + 'ms)');
  }

  ws.close(); chrome.kill(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const location0 = (port) => `http://127.0.0.1:${port}/`;
main().catch((e) => { console.error(e); process.exit(1); });
