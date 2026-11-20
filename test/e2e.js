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
<style>
  body{font-family:Helvetica,Arial;margin:0;background:#fff;color:#1c1e21}
  .fbhead{padding:18px 40px;border-bottom:1px solid #ddd;font-size:20px;font-weight:700}
  .search{padding:16px 40px;display:flex;gap:10px}.search input{width:420px;height:36px;border:1px solid #ccc;border-radius:6px;padding:0 10px}
  #results{padding:0 40px 40px}
  .hdr{font-weight:700;margin:14px 0}
  .batch{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
  .card{border:1px solid #dadde1;border-radius:8px;background:#fff;overflow:hidden}
  .inner{padding:12px 14px 0;font-size:13px;line-height:1.6}
  .btnrow{display:flex;margin-top:8px}
  .det{flex:1;background:#e4e6eb;border-radius:6px;text-align:center;padding:7px;font-weight:600;cursor:pointer}
  .adv{display:flex;align-items:center;gap:8px;padding:12px 14px 6px;border-top:1px solid #ddd;margin-top:12px}
  .adv img{width:32px;height:32px;border-radius:50%}
  .media{background:#eee;height:260px;display:flex;justify-content:center}.media img{height:100%}
  .foot{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#f5f6f7;font-size:12px}
  .foot div{background:#e4e6eb;padding:6px 10px;border-radius:6px;font-weight:600}
</style></head>
<body><div class="fbhead">Biblioteca de anuncios</div>
<div class="search"><input value="curso"><button>Buscar</button></div>
<div id="results"><div class="hdr">~30 resultados</div><div id="batches"></div></div>
<script type="application/json" data-sjs>${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: page(page1, 'CUR1', true, 30) } }]]] })}</script>
<script>
  const PAGE1 = ${JSON.stringify(page1)};
  const fmt = (s) => new Date(s*1000).toLocaleDateString('es-AR',{day:'numeric',month:'short',year:'numeric'});
  function cardHtml(a){ const s=a.snapshot; const m=(s.videos[0]||{}).video_preview_image_url||(s.images[0]||{}).original_image_url||(s.cards[0]||{}).original_image_url||'';
    return '<div class="wrap"><div class="card"><div class="inner">'
     + '<div><span>'+(a.is_active?'Activo':'Inactivo')+'</span></div>'
     + '<div><span>Identificador de la biblioteca: '+a.ad_archive_id+'</span></div>'
     + '<div><span>En circulación desde el '+fmt(a.start_date)+'</span></div>'
     + '<div><span>Plataformas</span></div>'
     + '<div class="btnrow"><div role="button" class="det"><div><span>Ver detalles del anuncio</span></div></div></div></div>'
     + '<div class="adv"><img src="'+s.page_profile_picture_url+'"><b>'+s.page_name+'</b></div>'
     + '<div class="inner">'+s.body.text+'</div>'
     + '<div class="media">'+(m?'<img src="'+m+'">':'')+'</div>'
     + '<div class="foot"><span>'+(s.caption||'')+'</span>'+(s.cta_text?'<div>'+s.cta_text+'</div>':'')+'</div></div></div>'; }
  function addBatch(ads){ const b=document.createElement('div'); b.className='batch'; b.innerHTML=ads.map(cardHtml).join(''); document.getElementById('batches').appendChild(b); }
  addBatch(PAGE1);
  let cursor = 'CUR1', loading = false, done = false, useFetch = false;
  window.addEventListener('scroll', () => {
    if (loading || done) return;
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 300) return;
    loading = true;
    const body = 'fb_api_req_friendly_name=AdLibrarySearchPaginationQuery&doc_id=1&variables=' + encodeURIComponent(JSON.stringify({cursor}));
    const done_ = (txt) => { const j = JSON.parse(txt.replace('for (;;);','')); const c = j.data.ad_library_main.search_results_connection; cursor = c.page_info.end_cursor; done = !c.page_info.has_next_page; addBatch(c.edges.map(e=>e.node.collated_results[0])); setTimeout(()=>loading=false, 100); };
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

  const tbar = p.locator('bap-toolbar');
  const bars = p.locator('bap-cardbar');
  const visibleCards = () => p.evaluate(() => [...document.querySelectorAll('[data-bap-card]')].filter((c) => getComputedStyle(c).display !== 'none').length);
  await tbar.locator('.tbar').waitFor();
  await p.waitForFunction(() => document.querySelectorAll('bap-cardbar').length >= 12);
  console.log('tarjetas con barra:', await bars.count(), '| visibles:', await visibleCards());
  console.log('barra antes de resultados:', await p.evaluate(() => document.querySelector('bap-toolbar').nextElementSibling.className || document.querySelector('bap-toolbar').nextElementSibling.id));
  console.log('barra en tarjeta antes de "Ver detalles":', await p.evaluate(() => { const h = document.querySelector('bap-cardbar'); return h.nextElementSibling && h.nextElementSibling.textContent.trim(); }));
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, '01-integrado.png') });

  await tbar.locator('[data-action="dest"][data-value="message"]').click();
  console.log('mensaje visibles:', await visibleCards());
  await p.screenshot({ path: path.join(OUT, '02-mensaje.png') });
  await tbar.locator('[data-action="dest"][data-value="profile"]').click();
  console.log('perfil visibles:', await visibleCards());
  await tbar.locator('[data-action="dest"][data-value="all"]').click();

  await tbar.locator('[data-action="days"][data-value="30"]').click();
  console.log('30+ días visibles:', await visibleCards());
  await tbar.locator('[data-action="days"][data-value="0"]').click();

  // Ordenar por días: las tarjetas de Facebook se reordenan en la misma página
  await tbar.locator('[data-action="sort"][data-value="days_desc"]').click();
  const orderCheck = () => p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-bap-card]')].filter((c) => getComputedStyle(c).display !== 'none');
    cards.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return cards.slice(0, 6).map((c) => c.querySelector('bap-cardbar').shadowRoot.querySelector('.days').textContent.trim());
  });
  console.log('orden visual por días:', await orderCheck());
  await p.screenshot({ path: path.join(OUT, '03-orden.png') });

  await tbar.locator('[data-action="toggle-adv"]').click();
  await tbar.locator('select[data-filter="cta"]').selectOption('Más información');
  console.log('CTA "Más información" visibles:', await visibleCards());
  await tbar.locator('[data-action="reset-filters"]').click();
  await tbar.locator('[data-action="toggle-adv"]').click();
  await tbar.locator('[data-action="sort"][data-value="default"]').click();
  console.log('grilla aplanada al volver a orden Facebook:', await p.locator('[data-bap-grid]').count());

  // Guardar desde la tarjeta
  await bars.nth(0).locator('[data-action="save"]').click();
  await p.waitForTimeout(300);
  await bars.nth(2).locator('[data-action="save-menu"]').click();
  await p.locator('bap-layer .menu input').fill('Ganadores');
  await p.locator('bap-layer .menu button[type="submit"]').click();
  await p.waitForTimeout(400);
  const saved = await sw.evaluate(async () => Object.values((await chrome.storage.local.get('bap_saved')).bap_saved || {}).map((s) => `${s.id}:${s.folder}`));
  console.log('guardados:', saved);
  console.log('texto botón guardado:', (await bars.nth(2).locator('[data-action="save"]').textContent()).trim());

  // Descargar
  await bars.nth(0).locator('[data-action="download"]').click();
  await p.waitForTimeout(1000);
  console.log('descargas iniciadas:', await sw.evaluate(async () => (await chrome.downloads.search({})).length));

  // Carrusel: botón con menú para elegir qué archivo bajar
  const carrusel = p.locator('bap-cardbar').filter({ has: p.locator('[data-action="download-menu"]') }).first();
  console.log('botón carrusel:', (await carrusel.locator('[data-action="download"]').textContent()).trim());
  await carrusel.locator('[data-action="download-menu"]').click();
  await p.waitForTimeout(300);
  console.log('menú descarga:', (await p.locator('bap-layer .menu .mi').allTextContents()).map((t) => t.trim()));
  await carrusel.scrollIntoViewIfNeeded();
  await p.locator('bap-layer .menu').waitFor();
  await p.screenshot({ path: path.join(OUT, '08-menu-descarga.png') });
  const before = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
  await p.locator('bap-layer .menu .mi[data-i="1"]').click();
  await p.waitForTimeout(800);
  console.log('descargas al elegir 1 archivo:', (await sw.evaluate(async () => (await chrome.downloads.search({})).length)) - before);
  console.log('botones de video simple:', [...new Set((await p.locator('bap-cardbar').evaluateAll((els) => els.map((e) => e.shadowRoot.querySelector('[data-action="download"]').textContent.trim()))))]);

  // Exportar
  const [dl] = await Promise.all([p.waitForEvent('download'), tbar.locator('[data-action="export"][data-value="xlsx"]').click()]);
  await dl.saveAs(path.join(OUT, dl.suggestedFilename()));
  console.log('excel:', dl.suggestedFilename());

  // Selección
  await bars.nth(1).locator('[data-action="select"]').click();
  await bars.nth(3).locator('[data-action="select"]').click();
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, '04-seleccion.png') });
  await p.locator('bap-layer [data-action="sel-clear"]').click();

  // Guardados en panel lateral, misma pestaña
  const pagesBefore = ctx.pages().length;
  await tbar.locator('[data-action="open-drawer"]').click();
  await p.locator('bap-layer .drawer .srow').first().waitFor();
  await p.waitForTimeout(300);
  console.log('panel guardados filas:', await p.locator('bap-layer .srow').count(), '| pestañas nuevas:', ctx.pages().length - pagesBefore);
  await p.screenshot({ path: path.join(OUT, '05-guardados-panel.png') });
  await p.keyboard.press('Escape');

  // Cargar todos
  await tbar.locator('[data-action="load-all"]').click();
  await p.waitForFunction(() => /Cargar todos/.test(document.querySelector('bap-toolbar').shadowRoot.querySelector('[data-ref="loadAllBtn"]').textContent), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  console.log('después de cargar todos:', (await tbar.locator('[data-ref="stats"]').textContent()).replace(/\s+/g, ' '), '| barras:', await bars.count());
  await tbar.locator('[data-action="sort"][data-value="days_desc"]').click();
  console.log('orden con 30 anuncios:', await orderCheck());
  await tbar.locator('[data-action="sort"][data-value="default"]').click();
  await p.evaluate(() => window.scrollTo(0, 2500));
  await p.waitForTimeout(400);
  console.log('pastilla filtros visible al bajar:', await p.locator('bap-layer .pill').isVisible());

  // Página de guardados
  const sp = await ctx.newPage();
  sp.on('pageerror', (e) => errors.push('saved pageerror: ' + e.message));
  await sp.goto(`chrome-extension://${extId}/src/pages/saved.html`);
  await sp.locator('.card').first().waitFor();
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: path.join(OUT, '06-guardados-pagina.png') });
  console.log('cards en guardados:', await sp.locator('.card').count());

  const pp = await ctx.newPage();
  await pp.setViewportSize({ width: 340, height: 420 });
  await pp.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await pp.waitForTimeout(300);
  await pp.screenshot({ path: path.join(OUT, '07-popup.png') });

  console.log('errores:', errors.length ? errors : 'ninguno');
  await ctx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
