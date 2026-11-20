// Prueba end-to-end: carga la extensión en Chromium y simula la Biblioteca de anuncios.
// Uso: node test/e2e.js [carpeta-de-capturas]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { makeAd, page } = require('./mock');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });

const page1 = Array.from({ length: 12 }, (_, i) => makeAd(i));
const page2 = Array.from({ length: 12 }, (_, i) => makeAd(i, { offset: 100000 }));
const page3 = Array.from({ length: 6 }, (_, i) => makeAd(i + 3, { offset: 200000 }));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Biblioteca de anuncios</title>
<style>body{font-family:Arial;margin:0;background:#fff} .res{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px} .c{border:1px solid #ddd;height:520px;padding:10px}</style></head>
<body><div style="padding:20px;font-size:22px">Biblioteca de anuncios (simulada)</div><div class="res" id="res"></div>
<script type="application/json" data-sjs>${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: page(page1, 'CUR1', true, 30) } }]]] })}</script>
<script>
  const res = document.getElementById('res');
  function addCards(n){ for(let i=0;i<n;i++){ const d=document.createElement('div'); d.className='c'; d.textContent='Anuncio nativo'; res.appendChild(d);} }
  addCards(12);
  let cursor = 'CUR1', loading = false, done = false, useFetch = false;
  window.addEventListener('scroll', () => {
    if (loading || done) return;
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 300) return;
    loading = true;
    const body = 'fb_api_req_friendly_name=AdLibrarySearchPaginationQuery&doc_id=1&variables=' + encodeURIComponent(JSON.stringify({cursor}));
    const done_ = (txt) => { const j = JSON.parse(txt.replace('for (;;);','')); const c = j.data.ad_library_main.search_results_connection; cursor = c.page_info.end_cursor; done = !c.page_info.has_next_page; addCards(c.edges.length); setTimeout(()=>loading=false, 100); };
    if (useFetch) fetch('/api/graphql/', {method:'POST', body, headers:{'content-type':'application/x-www-form-urlencoded'}}).then(r=>r.text()).then(done_);
    else { const x = new XMLHttpRequest(); x.open('POST','/api/graphql/'); x.onload=()=>done_(x.responseText); x.send(body); }
    useFetch = !useFetch;
  });
</script></body></html>`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
  });
  const errors = [];
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  console.log('extension id', extId);

  await ctx.route('https://www.facebook.com/ads/library/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route('https://www.facebook.com/api/graphql/**', (r) => {
    const body = r.request().postData() || '';
    const vars = JSON.parse(decodeURIComponent(/variables=([^&]*)/.exec(body)[1]));
    const res = vars.cursor === 'CUR1' ? page(page2, 'CUR2', true, 30) : page(page3, 'CUR3', false, 30);
    r.fulfill({ status: 200, contentType: 'application/json', body: 'for (;;);' + JSON.stringify(res) });
  });
  await ctx.route(/fbcdn\.net/, (r) => {
    const u = new URL(r.request().url());
    const file = path.join(FIX, path.basename(u.pathname));
    r.fulfill({ status: 200, contentType: file.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', body: fs.readFileSync(file) });
  });

  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await p.goto('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AR&q=curso');

  const host = p.locator('#bap-root');
  await host.locator('.launcher').waitFor();
  await p.waitForFunction(() => /12/.test(document.querySelector('#bap-root').shadowRoot.querySelector('.launcher').textContent));
  await p.screenshot({ path: path.join(OUT, '00-launcher.png') });

  await host.locator('.launcher').click();
  await host.locator('.card').first().waitFor();
  const count = async () => host.locator('.grid .card').count();
  console.log('cards after open:', await count());
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, '01-panel.png') });

  // Filtro por destino: Mensaje
  await host.locator('[data-action="dest"][data-value="message"]').click();
  console.log('mensaje:', await count());
  await p.screenshot({ path: path.join(OUT, '02-mensaje.png') });
  await host.locator('[data-action="dest"][data-value="profile"]').click();
  console.log('perfil:', await count());
  await host.locator('[data-action="dest"][data-value="website"]').click();
  console.log('web:', await count());
  await host.locator('[data-action="dest"][data-value="all"]').click();

  // Días 30+ y orden por días
  await host.locator('[data-action="days"][data-value="30"]').click();
  console.log('30+ días:', await count());
  await host.locator('[data-action="sort"][data-value="days_desc"]').click();
  const firstDays = await host.locator('.grid .card .days').first().textContent();
  console.log('primer anuncio ordenado por días:', firstDays.trim());
  await host.locator('[data-action="days"][data-value="0"]').click();

  // Filtros avanzados
  await host.locator('[data-action="toggle-adv"]').click();
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, '03-filtros.png') });
  await host.locator('select[data-filter="cta"]').selectOption('Más información');
  console.log('CTA "Más información":', await count());
  await host.locator('[data-action="reset-filters"]').click();
  await host.locator('[data-action="toggle-adv"]').click();
  await host.locator('[data-action="sort"][data-value="default"]').click();

  // Guardar
  await host.locator('.grid .card [data-action="save"]').first().click();
  await p.waitForTimeout(400);
  await host.locator('.grid .card').nth(2).locator('[data-action="save-menu"]').click();
  await host.locator('.menu input').fill('Ganadores');
  await host.locator('.menu button[type="submit"]').click();
  await p.waitForTimeout(400);
  const saved = await sw.evaluate(async () => Object.values((await chrome.storage.local.get('bap_saved')).bap_saved || {}).map((s) => `${s.id}:${s.folder}`));
  console.log('guardados:', saved);

  // Reproducir video
  await host.locator('.grid .card [data-action="play"]').first().click();
  await p.waitForTimeout(500);
  console.log('video tags:', await host.locator('.grid video').count());

  // Descargar
  await host.locator('.grid .card [data-action="download"]').first().click();
  await p.waitForTimeout(1200);
  const dls = await sw.evaluate(async () => (await chrome.downloads.search({})).map((d) => d.filename.split('/').slice(-3).join('/') + ' [' + d.state + ']'));
  console.log('descargas:', dls);

  // Exportar Excel
  const [dl] = await Promise.all([p.waitForEvent('download'), host.locator('[data-action="export"][data-value="xlsx"]').click()]);
  const xlsx = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(xlsx);
  console.log('excel:', xlsx);

  // Selección
  await host.locator('.grid .card [data-action="select"]').nth(0).click();
  await host.locator('.grid .card [data-action="select"]').nth(1).click();
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, '04-seleccion.png') });
  await host.locator('[data-action="sel-clear"]').click();

  // Cargar todos (scroll en la página de Facebook debajo)
  await host.locator('[data-action="load-all"]').click();
  await p.waitForFunction(() => /Cargar todos/.test(document.querySelector('#bap-root').shadowRoot.querySelector('[data-ref="loadAllBtn"]').textContent), null, { timeout: 30000 });
  console.log('después de cargar todos:', await host.locator('[data-ref="stats"]').textContent());

  // Página de guardados
  const sp = await ctx.newPage();
  sp.on('pageerror', (e) => errors.push('saved pageerror: ' + e.message));
  await sp.goto(`chrome-extension://${extId}/src/pages/saved.html`);
  await sp.locator('.card').first().waitFor();
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: path.join(OUT, '05-guardados.png') });
  console.log('cards en guardados:', await sp.locator('.card').count());

  const pp = await ctx.newPage();
  await pp.setViewportSize({ width: 340, height: 420 });
  await pp.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await pp.waitForTimeout(300);
  await pp.screenshot({ path: path.join(OUT, '06-popup.png') });

  console.log('errores:', errors.length ? errors : 'ninguno');
  await ctx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
