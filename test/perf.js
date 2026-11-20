// Mide el costo de la extensión en una página grande que cambia todo el tiempo (como Facebook).
// Uso: node test/perf.js <carpeta-de-la-extensión> [cantidad-de-anuncios]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { makeAd, page } = require('./mock');

const NONE = process.argv[2] === 'none';
const EXT = NONE ? '' : path.resolve(process.argv[2] || path.join(__dirname, '..'));
const N = Number(process.argv[3] || 120);
const FIX = path.join(__dirname, 'fixtures');
const FILLER = Number(process.env.FILLER || 0); // elementos extra por tarjeta (Facebook usa muchos)
const DIGIT_NOISE = !!process.env.DIGIT_NOISE; // cambios que incluyen números largos
const ads = Array.from({ length: N }, (_, i) => makeAd(i, { offset: Math.floor(i / 12) * 100000 }));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
 body{font-family:Arial;margin:0} #results{padding:0 40px}
 .batch{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
 .card{border:1px solid #ddd;border-radius:8px;overflow:hidden}.inner{padding:12px}.btnrow{display:flex}
 .det{flex:1;background:#e4e6eb;padding:7px;text-align:center}.media{height:220px;background:#eee}
</style></head><body><header><input value="curso"></header><div id="ticker"></div>
<div id="results"><div>~${N} resultados</div><div id="batches"></div></div>
<script type="application/json" data-sjs>${JSON.stringify({ x: page(ads, 'C', false, N) })}</script>
<script>
 const ADS=${JSON.stringify(ads)};
 const FILL='<div style="display:none">'+'<div><span><i>x</i></span></div>'.repeat(${FILLER})+'</div>';
 const card=(a)=>'<div class="wrap"><div class="card"><div class="inner"><div><span>Activo</span></div><div><span>Identificador de la biblioteca: '+a.ad_archive_id+'</span></div><div class="btnrow"><div role="button" class="det"><div><span>Ver detalles del anuncio</span></div></div></div></div><div class="inner">'+a.snapshot.body.text+'</div><div class="media"></div>'+FILL+'</div></div>';
 for(let i=0;i<ADS.length;i+=12){const b=document.createElement('div');b.className='batch';b.innerHTML=ADS.slice(i,i+12).map(card).join('');document.getElementById('batches').appendChild(b);}
 // Ruido: Facebook cambia el DOM todo el tiempo (contadores, tooltips, videos).
 const t=document.getElementById('ticker'); let k=0;
 setInterval(()=>{k++; t.textContent='tick '+k; const s=document.createElement('span'); s.textContent='tooltip '+k; document.body.appendChild(s); setTimeout(()=>s.remove(),30);
   document.querySelectorAll('.media').forEach((m,i)=>{ if(i%10===k%10){ m.innerHTML='<i>'+k+'</i>'; } });
   if (${DIGIT_NOISE} && k%20===0){ const d=document.createElement('div'); d.textContent='ref 98765432101234'+k; document.body.appendChild(d); setTimeout(()=>d.remove(),200); } }, 16);
</script></body></html>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-perf-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium', viewport: { width: 1440, height: 900 },
    args: NONE ? [] : [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://www.facebook.com/ads/library/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await ctx.route(/fbcdn\.net/, (r) => r.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(FIX, 'img1.jpg')) }));
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  const tLoad = Date.now();
  await p.goto('https://www.facebook.com/ads/library/?q=curso');
  if (!NONE) await p.waitForFunction((n) => document.querySelectorAll('bap-cardbar').length >= n, N, { timeout: 60000 });
  const readyMs = Date.now() - tLoad;
  await p.waitForTimeout(1000);
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

  // 1) Costo en reposo con la página cambiando (5 s)
  const a = await metric();
  await p.waitForTimeout(5000);
  const b = await metric();
  const idle = { script: b.ScriptDuration - a.ScriptDuration, layout: b.LayoutDuration - a.LayoutDuration, style: b.RecalcStyleDuration - a.RecalcStyleDuration };

  if (NONE) {
    console.log(JSON.stringify({ sinExtension: true, reposo5s_ms: Object.fromEntries(Object.entries(idle).map(([k, v]) => [k, Math.round(v * 1000)])) }));
    return ctx.close();
  }
  // 2) Tiempo de respuesta de un filtro (clic hasta pintar)
  const tbar = p.locator('bap-toolbar');
  const clickMs = async (sel) => {
    const t0 = Date.now();
    await tbar.locator(sel).click();
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return Date.now() - t0;
  };
  const filt = [];
  for (const v of ['message', 'website', 'profile', 'all']) filt.push(await clickMs(`[data-action="dest"][data-value="${v}"]`));
  const sortMs = [await clickMs('[data-action="sort"][data-value="days_desc"]'), await clickMs('[data-action="sort"][data-value="default"]')];

  // 3) ¿La tarjeta completa queda oculta? (incluye el texto con el teléfono de 13 dígitos)
  await tbar.locator('[data-action="dest"][data-value="website"]').click();
  const check = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    const leaks = cards.filter((c) => c.getBoundingClientRect().height > 0 && !c.closest('[data-bap-card]') ).length;
    const visible = cards.filter((c) => c.getBoundingClientRect().height > 0).length;
    const partial = [...document.querySelectorAll('[data-bap-card]')].filter((r) => !r.querySelector('.media')).length;
    return { visible, sinReconocer: leaks, tarjetasIncompletas: partial };
  });

  console.log(JSON.stringify({ anuncios: N, listo_ms: readyMs, reposo5s_ms: Object.fromEntries(Object.entries(idle).map(([k, v]) => [k, Math.round(v * 1000)])), filtro_ms: filt, orden_ms: sortMs, ...check }));
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
