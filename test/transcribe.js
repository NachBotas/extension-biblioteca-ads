// Prueba de transcripción: Whisper local real (modelo de Hugging Face) + API estilo OpenAI simulada.
// Uso: node test/transcribe.js [carpeta-de-capturas]
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');
const { makeAd, page } = require('./mock');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  // Servidor local con el video con voz (con CORS, como el CDN de Facebook).
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const f = path.join(FIX, req.url.includes('speech') ? 'speech.mp4' : 'video.mp4');
    res.setHeader('Content-Type', 'video/mp4');
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ads = [0, 2, 4].map((i) => makeAd(i));
  for (const a of ads) a.snapshot.videos = [{ video_hd_url: `${base}/speech.mp4?hd=${a.ad_archive_id}`, video_sd_url: `${base}/speech.mp4?sd=${a.ad_archive_id}`, video_preview_image_url: 'https://scontent.xx.fbcdn.net/test/img1.jpg' }];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>.batch{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:20px}.card{border:1px solid #ddd;padding:12px}.btnrow{display:flex}.det{flex:1;background:#e4e6eb;padding:6px;text-align:center}</style></head><body>
  <div id="r"><div class="batch">${ads.map((a) => `<div class="card"><div><span>Identificador de la biblioteca: ${a.ad_archive_id}</span></div><div class="btnrow"><div role="button" class="det"><span>Ver detalles del anuncio</span></div></div><div>${a.snapshot.page_name}</div></div>`).join('')}</div></div>
  <script type="application/json" data-sjs>${JSON.stringify({ x: page(ads, null, false, 3) })}</script></body></html>`;

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bap-tr-')), {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [])],
  });
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  await ctx.route('https://www.facebook.com/ads/library/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await ctx.route(/fbcdn\.net/, (r) => r.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(FIX, 'img1.jpg')) }));
  // API estilo OpenAI simulada (los servicios reales están bloqueados en este entorno).
  let apiCall = null;
  await ctx.route('https://api.openai.com/**', async (r) => {
    const req = r.request();
    apiCall = { url: req.url(), auth: req.headers()['authorization'], size: (req.postDataBuffer() || Buffer.alloc(0)).length, model: /name="model"\r\n\r\n([^\r]+)/.exec((req.postDataBuffer() || '').toString('latin1'))?.[1] };
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'Texto simulado de la API.' }) });
  });

  const p = await ctx.newPage();
  const logs = [];
  p.on('pageerror', (e) => logs.push('pageerror ' + e.message));
  await p.goto('https://www.facebook.com/ads/library/?q=x');
  await p.waitForFunction(() => document.querySelectorAll('bap-cardbar').length >= 3);
  const bars = p.locator('bap-cardbar');

  // 1) Primera vez: pide elegir cómo transcribir
  await bars.nth(0).locator('[data-action="transcribe"]').click();
  await p.locator('bap-layer .modal form').waitFor();
  await p.screenshot({ path: path.join(OUT, 'tr-1-config.png') });
  console.log('primera vez muestra configuración: sí');

  // 2) API (OpenAI simulada)
  await p.locator('bap-layer .modal input[value="openai"]').check();
  await p.locator('bap-layer .modal input[name="openaiKey"]').fill('sk-test-123');
  await p.locator('bap-layer .modal button[type="submit"]').click();
  await p.locator('bap-layer .modal .tr-text, bap-layer .modal .tr-error').first().waitFor({ timeout: 30000 });
  console.log('API:', (await p.locator('bap-layer .modal .modal-b').textContent()).trim().slice(0, 140), '| pedido:', apiCall);
  await p.keyboard.press('Escape');

  // 3) Local (Whisper real)
  await sw.evaluate(async (model) => {
    const r = await chrome.storage.local.get('bap_settings');
    await chrome.storage.local.set({ bap_settings: Object.assign({}, r.bap_settings, { provider: 'local', localModel: model, language: 'es' }) });
  }, process.env.MODEL || 'base');
  const t0 = Date.now();
  await bars.nth(1).locator('[data-action="transcribe"]').click();
  await p.locator('bap-layer .modal .tr-progress').waitFor();
  let shot = false;
  const seen = new Set();
  while (Date.now() - t0 < 600000) {
    const txt = (await p.locator('bap-layer .modal .modal-b').textContent().catch(() => '')) || '';
    const stage = txt.split('Podés')[0].trim();
    if (stage && !seen.has(stage.slice(0, 30))) { seen.add(stage.slice(0, 30)); console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${stage.slice(0, 110)}`); }
    if (!shot && /modelo de voz/.test(txt)) { await p.screenshot({ path: path.join(OUT, 'tr-2-progreso.png') }); shot = true; }
    if (await p.locator('bap-layer .modal .tr-text, bap-layer .modal .tr-error, bap-layer .modal .empty').count()) break;
    await p.waitForTimeout(1500);
  }
  console.log(`local (${Math.round((Date.now() - t0) / 1000)} s):`, (await p.locator('bap-layer .modal .modal-b').textContent()).trim());
  await p.screenshot({ path: path.join(OUT, 'tr-3-resultado.png') });
  await p.keyboard.press('Escape');
  console.log('botón de la tarjeta:', (await bars.nth(1).locator('[data-action="transcribe"]').textContent()).trim());

  // 4) Segunda vez: el modelo ya está en caché
  const t1 = Date.now();
  await bars.nth(2).locator('[data-action="transcribe"]').click();
  await p.locator('bap-layer .modal .tr-text, bap-layer .modal .tr-error').first().waitFor({ timeout: 300000 });
  console.log(`segunda vez (${Math.round((Date.now() - t1) / 1000)} s):`, (await p.locator('bap-layer .modal .modal-b').textContent()).trim().slice(0, 160));
  await p.keyboard.press('Escape');

  // 5) Excel con transcripciones
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('bap-toolbar [data-action="export"][data-value="xlsx"]').click()]);
  await dl.saveAs(path.join(OUT, 'con-transcripcion.xlsx'));
  console.log('errores de página:', logs.length ? logs : 'ninguno');
  await ctx.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
