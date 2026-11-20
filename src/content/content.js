/*
 * Content script (mundo aislado).
 * Se integra DENTRO de la página de la Biblioteca de anuncios:
 *  - una barra de filtros arriba de los resultados,
 *  - botones en cada tarjeta nativa de Facebook (días, destino, guardar, descargar),
 *  - filtros y orden aplicados sobre las mismas tarjetas,
 *  - "Guardados" como panel lateral en la misma ventana.
 * Si no logra reconocer las tarjetas de Facebook, ofrece una vista en grilla como respaldo.
 */
(function () {
  if (window.__BAP_CS__) return;
  window.__BAP_CS__ = true;

  const BAP = window.BAP;
  const { icon, esc } = BAP;
  const PAGE_SIZE = 60;
  const LOAD_ALL_CAP = 3000;
  const LONG_NUM = /\d{13,20}/g;
  const DETAILS_RE = /^(ver (los )?detalles del (anuncio|resumen)|see (ad|summary) details|ver detalhes do an[uú]ncio|ver resumo|voir les d[ée]tails|details anzeigen|anzeigendetails ansehen|vedi dettagli)/i;

  const state = {
    ads: new Map(),
    total: null,
    hasNext: null,
    filters: BAP.defaultFilters(),
    sort: 'default',
    selected: new Set(),
    saved: {},
    folders: ['General'],
    prefs: { lastFolder: 'General' },
    loading: false,
    autoLoading: false,
    view: [],
    viewIds: new Set(),
    advOpen: false,
    mode: 'native', // 'native' | 'fallback'
    overlayOpen: false,
    renderLimit: PAGE_SIZE,
    drawerOpen: false,
    drawerFolder: '__all',
    drawerText: '',
    searchKey: '',
  };

  const native = { cards: new Map(), grid: null, flat: new Set(), ordered: new Set(), version: 0, flatVersion: -1, tbVersion: -1 };
  const overlayCards = new Map();
  let css = '';
  let sheet = null;
  let tb = null; // barra de herramientas
  let layer = null; // capa fija: panel lateral, menús, toasts, selección, respaldo
  let menu = null;

  // ======================= Entrada de datos =======================

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'BAP_HOOK') return;
    const { type, payload } = ev.data;
    if (type === 'reset') {
      const key = searchKey();
      if (key === state.searchKey) return; // Facebook volvió a pedir la misma búsqueda: no borrar nada
      state.searchKey = key;
      resetAds();
    }
    else if (type === 'ads') ingest(payload || {});
  });
  state.searchKey = searchKey();
  window.postMessage({ source: 'BAP_CS', type: 'hello' }, location.origin);

  function ingest(payload) {
    const now = Date.now();
    let added = 0;
    for (const raw of payload.ads || []) {
      try {
        const ad = BAP.normalize(raw, now);
        if (!state.ads.has(ad.id)) {
          state.ads.set(ad.id, ad);
          added++;
        }
      } catch (e) {
        console.debug('[BAP] no se pudo leer un anuncio', e);
      }
    }
    if (payload.meta) {
      if (payload.meta.count != null) state.total = payload.meta.count;
      if (payload.meta.hasNext != null) state.hasNext = payload.meta.hasNext;
    }
    if (added) {
      scheduleScan(true);
      scheduleRender();
    } else scheduleRender();
  }

  function searchKey() {
    const p = new URLSearchParams(location.search);
    p.delete('id');
    p.sort();
    return location.pathname + '?' + p.toString();
  }

  function resetAds() {
    clearNative();
    state.ads.clear();
    state.selected.clear();
    state.total = null;
    state.hasNext = null;
    state.renderLimit = PAGE_SIZE;
    overlayCards.clear();
    scheduleRender();
  }

  // ======================= Guardados =======================

  async function loadStorage() {
    try {
      const { saved, folders, prefs } = await BAP.storage.load();
      state.saved = saved;
      state.folders = folders;
      state.prefs = Object.assign(state.prefs, prefs);
      if (prefs.filters) state.filters = Object.assign(BAP.defaultFilters(), prefs.filters, { text: '' });
      if (prefs.sort) state.sort = prefs.sort;
    } catch (e) {
      console.warn('[BAP] storage', e);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const k = BAP.STORAGE_KEYS;
    if (changes[k.saved]) {
      const prev = state.saved;
      state.saved = changes[k.saved].newValue || {};
      const ids = new Set([...Object.keys(prev), ...Object.keys(state.saved)]);
      for (const id of ids) if ((prev[id] || {}).folder !== (state.saved[id] || {}).folder) refreshSaved(id);
      if (state.drawerOpen) renderDrawer();
      scheduleRender();
    }
    if (changes[k.folders]) state.folders = changes[k.folders].newValue || ['General'];
  });

  let prefsTimer = null;
  function persistPrefs() {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      const filters = Object.assign({}, state.filters, { text: '' });
      BAP.storage.setPrefs(Object.assign({}, state.prefs, { filters, sort: state.sort })).catch(() => {});
    }, 400);
  }

  async function saveAds(ads, folder) {
    folder = folder || state.prefs.lastFolder || 'General';
    const recs = ads.map((ad) => {
      const prev = state.saved[ad.id];
      const rec = BAP.toSaved(ad, folder);
      if (prev) {
        rec.note = prev.note || '';
        rec.savedAt = prev.savedAt || rec.savedAt;
        rec.thumbData = prev.thumbData || '';
      }
      return rec;
    });
    if (!state.folders.includes(folder)) {
      state.folders.push(folder);
      await BAP.storage.setFolders(state.folders);
    }
    state.prefs.lastFolder = folder;
    persistPrefs();
    await BAP.storage.upsert(recs);
    toast(ads.length > 1 ? `${ads.length} anuncios guardados en “${folder}”` : `Guardado en “${folder}”`, false, { label: 'Ver guardados', fn: () => openDrawer(true) });
    for (const rec of recs) {
      if (rec.thumbData || !rec.thumb) continue;
      chrome.runtime
        .sendMessage({ type: 'thumb', url: rec.thumb })
        .then((r) => r && r.ok && BAP.storage.patch(rec.id, { thumbData: r.dataUrl }))
        .catch(() => {});
    }
  }

  async function unsave(ids) {
    await BAP.storage.remove(ids);
    toast(ids.length > 1 ? `${ids.length} anuncios quitados de guardados` : 'Quitado de guardados');
  }

  // ======================= Descargas / exportación =======================

  async function downloadAds(ads, only) {
    const items = ads.flatMap((ad) => BAP.downloadItems(ad, only));
    if (!items.length) return toast('No hay archivos para descargar', true);
    if (items.length > 25 && !confirm(`Se van a descargar ${items.length} archivos. ¿Continuar?`)) return;
    toast(items.length > 1 ? `Descargando ${items.length} archivos…` : 'Descargando…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'download', items });
      if (r && r.failed) toast(`${r.failed} archivo(s) no se pudieron descargar. Si el anuncio es viejo, el link venció: recargá la búsqueda.`, true);
    } catch (e) {
      toast('Error al descargar. Recargá la página e intentá de nuevo.', true);
    }
  }

  function exportAds(ads, format, opts = {}) {
    if (!ads.length) return toast('No hay anuncios para exportar', true);
    BAP.exportAds(ads, format, Object.assign({ prefix: 'biblioteca-anuncios' }, opts));
    toast(`Exportados ${ads.length} anuncios a ${format === 'csv' ? 'CSV' : 'Excel'}`);
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg || 'Copiado');
  }

  // ======================= Cargar más =======================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(200);
    }
    return fn();
  }

  // Hacer scroll al final dispara la carga de más resultados de Facebook.
  async function loadMore() {
    if (state.loading) return false;
    state.loading = true;
    updateLoadButtons();
    const before = state.ads.size;
    const h = document.documentElement.scrollHeight;
    window.scrollTo(0, Math.max(0, h - window.innerHeight - 600));
    await sleep(120);
    window.scrollTo(0, document.documentElement.scrollHeight);
    let ok = await waitFor(() => state.ads.size > before, 6000);
    if (!ok) {
      window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight * 2));
      await sleep(200);
      window.scrollTo(0, document.documentElement.scrollHeight);
      ok = await waitFor(() => state.ads.size > before, 4000);
    }
    state.loading = false;
    updateLoadButtons();
    return ok;
  }

  async function loadAll() {
    if (state.autoLoading) return;
    state.autoLoading = true;
    updateLoadButtons();
    let misses = 0;
    while (state.autoLoading && state.ads.size < LOAD_ALL_CAP) {
      if (state.hasNext === false) break;
      const ok = await loadMore();
      misses = ok ? 0 : misses + 1;
      if (misses >= 2) break;
      await sleep(300);
    }
    const stopped = !state.autoLoading;
    state.autoLoading = false;
    updateLoadButtons();
    if (!state.overlayOpen && tb) tb.host.scrollIntoView({ block: 'start', behavior: 'smooth' });
    toast(stopped ? `Carga detenida · ${state.ads.size} anuncios` : `Listo · ${state.ads.size} anuncios cargados`);
  }

  // ======================= Estilos =======================

  const PAGE_CSS = `
    [data-bap-hide] { display: none !important; }
    /* Las tarjetas fuera de pantalla no se dibujan hasta que hace falta: listas largas mucho más livianas. */
    [data-bap-card] { content-visibility: auto; contain-intrinsic-size: auto 900px; }
    [data-bap-flat] { display: contents !important; }
    [data-bap-grid] {
      display: grid !important; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)) !important;
      gap: 16px !important; align-items: start !important;
    }
    [data-bap-grid] > :not([data-bap-card]):not([data-bap-flat]),
    [data-bap-flat] > :not([data-bap-card]):not([data-bap-flat]) { grid-column: 1 / -1 !important; }
    [data-bap-grid] > [data-bap-card], [data-bap-flat] > [data-bap-card] {
      width: auto !important; max-width: none !important; min-width: 0 !important; margin: 0 !important; flex: none !important;
    }
    bap-toolbar, bap-cardbar, bap-layer { all: initial !important; display: block !important; }
    bap-toolbar { margin: 0 0 16px !important; width: 100% !important; }
  `;

  async function loadCss() {
    try {
      const files = ['src/shared/ui.css', 'src/content/panel.css'];
      const texts = await Promise.all(files.map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text())));
      css = texts.join('\n');
    } catch (e) {
      console.warn('[BAP] css', e);
    }
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
    } catch (e) {
      sheet = null;
    }
    const st = document.createElement('style');
    st.id = 'bap-page-css';
    st.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function makeShadow(host) {
    const root = host.attachShadow({ mode: 'open' });
    let adopted = false;
    if (sheet) {
      try {
        root.adoptedStyleSheets = [sheet];
        adopted = true;
      } catch (e) {
        adopted = false;
      }
    }
    if (!adopted) {
      const st = document.createElement('style');
      st.textContent = css;
      root.appendChild(st);
    }
    return root;
  }

  // ======================= Barra de herramientas =======================

  function buildToolbar() {
    const host = document.createElement('bap-toolbar');
    const root = makeShadow(host);
    const wrap = document.createElement('div');
    wrap.className = 'bap tbar';
    wrap.innerHTML = `
      <div class="tb-row">
        <div class="brand"><span class="logo">${icon('library', 16)}</span>${esc(BAP.APP_NAME)}</div>
        <div class="stats" data-ref="stats"></div>
        <div class="spacer"></div>
        <label class="search">${icon('search', 15)}<input class="input" type="search" placeholder="Buscar en estos resultados…" data-ref="search"></label>
        <button class="btn" data-action="open-drawer">${icon('bookmark', 15)}Guardados <span class="filter-count" data-ref="savedN">0</span></button>
        <button class="btn" data-action="close-overlay" data-ref="closeBtn" hidden>${icon('x', 15)}Cerrar</button>
      </div>
      <div class="tb-row">
        <button class="btn" data-action="toggle-adv" data-ref="advBtn">${icon('filter', 14)}Filtros <span class="filter-count" data-ref="filterN" hidden>0</span></button>
        <div class="seg" data-ref="daysSeg">
          <span class="seg-label">${icon('clock', 13)}Días activo</span>
          <button data-action="days" data-value="0">Todos</button>
          <button data-action="days" data-value="7">7+</button>
          <button data-action="days" data-value="30">30+</button>
          <button data-action="days" data-value="60">60+</button>
          <button data-action="days" data-value="90">90+</button>
          <input class="input input-num" type="number" min="0" placeholder="≥ días" data-ref="minDays" title="Mínimo de días activo">
        </div>
        <div class="seg" data-ref="sortSeg"><span class="seg-label">${icon('sort', 13)}Ordenar por</span>
          ${BAP.SORTS.map((s) => `<button data-action="sort" data-value="${s.key}" ${s.key === 'reach' ? 'data-reach="1" hidden' : ''}>${esc({ default: 'Facebook', days_desc: 'Más días', days_asc: 'Menos días' }[s.key] || s.label)}</button>`).join('')}
        </div>
      </div>
      <div class="tb-row">
        <button class="chip" data-action="status-active" data-ref="activeChip">${icon('checkCircle', 13)}Solo activos</button>
        <button class="btn btn-soft" data-action="download-all" data-ref="dlAll">${icon('download', 15)}Descargar todo</button>
        <button class="btn" data-action="export" data-value="xlsx">${icon('sheet', 15)}Exportar Excel</button>
        <button class="btn" data-action="export" data-value="csv">CSV</button>
        <button class="btn btn-ghost" data-action="select-all" data-ref="selAll">Seleccionar todos</button>
        <div class="spacer"></div>
        <button class="btn btn-gold" data-action="load-all" data-ref="loadAllBtn">${icon('refresh', 15)}Cargar todos</button>
      </div>
      <div class="dest-row" data-ref="destRow"></div>
      <div class="adv" data-ref="adv" hidden></div>`;
    root.appendChild(wrap);
    const refs = { host, root };
    root.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));

    root.addEventListener('click', (e) => {
      e.stopPropagation();
      onToolbarClick(e);
    });
    root.addEventListener('change', onToolbarChange);
    refs.search.addEventListener(
      'input',
      debounce(() => {
        state.filters.text = refs.search.value.trim();
        afterFilterChange(false);
      }, 200)
    );
    refs.minDays.addEventListener('change', () => {
      state.filters.minDays = Math.max(0, Number(refs.minDays.value) || 0);
      afterFilterChange();
    });
    // Evita que los atajos de teclado de Facebook capturen lo que se escribe.
    ['keydown', 'keyup', 'keypress'].forEach((t) => root.addEventListener(t, stopKeys));

    // Pastilla flotante "Filtros" cuando la barra queda fuera de la vista.
    new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (layer) layer.pill.hidden = visible || state.mode !== 'native' || !native.cards.size || !host.isConnected || state.overlayOpen;
    }).observe(host);
    return refs;
  }

  function onToolbarChange(e) {
    const t = e.target;
    const key = t.dataset && t.dataset.filter;
    if (!key) return;
    if (key === 'maxDays') state.filters.maxDays = t.value === '' ? null : Math.max(0, Number(t.value));
    else if (key === 'minCopies') state.filters.minCopies = Math.max(1, Number(t.value) || 1);
    else state.filters[key] = t.value;
    afterFilterChange();
  }

  function onToolbarClick(e) {
    const btn = e.target.closest('[data-action]');
    closeMenu();
    if (!btn) return;
    const action = btn.dataset.action;
    const value = btn.dataset.value;
    const f = state.filters;
    switch (action) {
      case 'open-drawer':
        return openDrawer(true);
      case 'close-overlay':
        return setOverlay(false);
      case 'toggle-adv':
        state.advOpen = !state.advOpen;
        tb.adv.hidden = !state.advOpen;
        if (state.advOpen) renderAdvanced();
        return updateToolbar();
      case 'dest':
        f.dest = f.dest === value && value !== 'all' ? 'all' : value;
        if (f.dest !== 'message' && f.dest !== 'all') f.channel = 'all';
        return afterFilterChange();
      case 'days':
        f.minDays = Number(value);
        tb.minDays.value = '';
        return afterFilterChange();
      case 'sort':
        state.sort = value;
        return afterFilterChange();
      case 'status-active':
        f.status = f.status === 'active' ? 'all' : 'active';
        return afterFilterChange();
      case 'media':
      case 'platform':
      case 'status':
        f[action] = value;
        return afterFilterChange();
      case 'savedOnly':
        f.savedOnly = value === 'true';
        return afterFilterChange();
      case 'reset-filters':
        state.filters = BAP.defaultFilters();
        tb.search.value = '';
        return afterFilterChange();
      case 'load-all':
        return loadAll();
      case 'stop-load':
        state.autoLoading = false;
        return updateLoadButtons();
      case 'download-all':
        return downloadAds(state.view);
      case 'export':
        return exportAds(state.view, value);
      case 'select-all': {
        const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
        state.view.forEach((a) => (allSel ? state.selected.delete(a.id) : state.selected.add(a.id)));
        return render();
      }
    }
  }

  function afterFilterChange(scrollTop = true) {
    state.renderLimit = PAGE_SIZE;
    persistPrefs();
    render();
    if (!scrollTop) return;
    if (state.overlayOpen) layer.overlay.scrollTo({ top: 0 });
    else if (tb && tb.host.isConnected) {
      const r = tb.host.getBoundingClientRect();
      if (r.top < 0) tb.host.scrollIntoView({ block: 'start' });
    }
  }

  // ======================= Render =======================

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // En la página se trabaja solo con los anuncios que están a la vista (sus tarjetas);
  // en la vista de respaldo, con todo lo cargado.
  let baseCache = null;
  function baseAds() {
    if (baseCache) return baseCache;
    if (native.cards.size && !state.overlayOpen) {
      baseCache = [];
      for (const id of native.cards.keys()) {
        const ad = state.ads.get(id);
        if (ad) baseCache.push(ad);
      }
    } else baseCache = [...state.ads.values()];
    return baseCache;
  }

  function filteredExcept(key) {
    const f = Object.assign({}, state.filters, { [key]: BAP.defaultFilters()[key] });
    return baseAds().filter((ad) => BAP.matches(ad, f, state.saved));
  }

  function computeView() {
    baseCache = null;
    const list = baseAds().filter((ad) => BAP.matches(ad, state.filters, state.saved));
    state.view = BAP.sortAds(list, state.sort);
    state.viewIds = new Set(state.view.map((a) => a.id));
  }

  function render() {
    if (!tb) return;
    computeView();
    updateStats();
    updateToolbar();
    updateDestChips();
    if (state.advOpen) renderAdvanced();
    updateLoadButtons();
    updateSelbar();
    applyNative();
    if (state.overlayOpen) renderOverlayGrid();
    updateFallback();
  }

  function updateStats() {
    const parts = [];
    if (state.total != null) parts.push(`<span>~<b>${BAP.fmtNum(state.total)}</b> resultados</span>`);
    parts.push(`<span><b>${baseAds().length}</b> en la página</span>`);
    parts.push(`<span><b>${state.view.length}</b> visibles con filtros</span>`);
    tb.stats.innerHTML = parts.join('<span class="dot"></span>');
    tb.savedN.textContent = Object.keys(state.saved).length;
    if (layer) layer.pill.querySelector('[data-ref="pillN"]').textContent = state.view.length;
  }

  function activeFilterCount() {
    const f = state.filters;
    const d = BAP.defaultFilters();
    let n = 0;
    for (const k of ['cta', 'channel', 'media', 'platform', 'savedOnly']) if (f[k] !== d[k]) n++;
    if (f.status === 'inactive') n++;
    if (f.maxDays != null && f.maxDays !== '') n++;
    if (f.minCopies > 1) n++;
    return n;
  }

  function updateToolbar() {
    const f = state.filters;
    tb.daysSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.value) === Number(f.minDays)));
    if (tb.root.activeElement !== tb.minDays) tb.minDays.value = [0, 7, 30, 60, 90].includes(Number(f.minDays)) ? '' : f.minDays || '';
    tb.sortSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === state.sort));
    const rb = tb.sortSeg.querySelector('[data-reach]');
    if (rb) rb.hidden = !baseAds().some((a) => a.reach != null);
    tb.activeChip.classList.toggle('on', f.status === 'active');
    const n = activeFilterCount();
    tb.filterN.hidden = !n;
    tb.filterN.textContent = n;
    tb.advBtn.classList.toggle('active-filter', state.advOpen || n > 0);
    const files = state.view.reduce((s, a) => s + (a.media || []).length, 0);
    tb.dlAll.innerHTML = `${icon('download', 15)}Descargar todo <span class="filter-count">${files}</span>`;
    tb.dlAll.disabled = !files;
    const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
    tb.selAll.textContent = allSel ? 'Quitar selección' : 'Seleccionar todos';
    if (tb.root.activeElement !== tb.search && tb.search.value !== f.text) tb.search.value = f.text;
  }

  function updateDestChips() {
    const base = filteredExcept('dest');
    const counts = { all: base.length };
    for (const a of base) counts[a.dest] = (counts[a.dest] || 0) + 1;
    const f = state.filters;
    const chip = (key, label, ic) =>
      `<button class="chip ${f.dest === key ? 'on' : ''} ${!counts[key] && key !== 'all' ? 'zero' : ''}" data-action="dest" data-value="${key}">${ic ? icon(ic, 14) : ''}${esc(label)}<span class="count">${counts[key] || 0}</span></button>`;
    tb.destRow.innerHTML = `<span class="lbl">Destino del botón</span>` + chip('all', 'Todos', 'grid') + BAP.DESTINATIONS.map((d) => chip(d.key, d.label, d.icon)).join('');
  }

  function optionCounts(list, getter) {
    const m = new Map();
    for (const a of list) {
      const v = getter(a);
      if (v == null) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderAdvanced() {
    const f = state.filters;
    const ctaOpts = optionCounts(filteredExcept('cta'), (a) => a.ctaText || '(sin botón)');
    const chanOpts = optionCounts(filteredExcept('channel'), (a) => a.channel);
    const mediaCounts = Object.fromEntries(optionCounts(filteredExcept('media'), (a) => a.mediaType));
    const platCounts = new Map();
    for (const a of filteredExcept('platform')) for (const p of a.platforms || []) platCounts.set(p, (platCounts.get(p) || 0) + 1);
    const chips = (action, items, cur) =>
      `<div class="chips">${items
        .map(([v, label, n]) => `<button class="chip ${cur === v ? 'on' : ''}" data-action="${action}" data-value="${esc(v)}">${esc(label)}${n != null ? `<span class="count">${n}</span>` : ''}</button>`)
        .join('')}</div>`;
    tb.adv.innerHTML = `
      <label class="field"><span>Texto del botón (CTA)</span>
        <select class="select" data-filter="cta">
          <option value="all">Todos los botones</option>
          ${ctaOpts.map(([v, n]) => `<option value="${esc(v)}" ${f.cta === v ? 'selected' : ''}>${esc(v)} (${n})</option>`).join('')}
        </select></label>
      <label class="field"><span>Canal / destino exacto</span>
        <select class="select" data-filter="channel">
          <option value="all">Todos</option>
          ${chanOpts.slice(0, 80).map(([v, n]) => `<option value="${esc(v)}" ${f.channel === v ? 'selected' : ''}>${esc(v)} (${n})</option>`).join('')}
        </select></label>
      <div class="field"><span>Formato</span>${chips('media', [['all', 'Todos'], ['video', 'Video', mediaCounts.video || 0], ['image', 'Imagen', mediaCounts.image || 0], ['carousel', 'Carrusel', mediaCounts.carousel || 0]], f.media)}</div>
      <div class="field"><span>Plataforma</span>${chips('platform', [['all', 'Todas'], ...[...platCounts.entries()].map(([p, n]) => [p, BAP.PLATFORM_LABELS[p] || p, n])], f.platform)}</div>
      <div class="field"><span>Estado</span>${chips('status', [['all', 'Todos'], ['active', 'Activos'], ['inactive', 'Inactivos']], f.status)}</div>
      <label class="field" style="min-width:110px"><span>Máx. días</span><input class="input" type="number" min="0" data-filter="maxDays" value="${f.maxDays ?? ''}" placeholder="Sin límite"></label>
      <label class="field" style="min-width:110px"><span>Mín. versiones</span><input class="input" type="number" min="1" data-filter="minCopies" value="${f.minCopies > 1 ? f.minCopies : ''}" placeholder="1"></label>
      <div class="field" style="min-width:auto"><span>Guardados</span>${chips('savedOnly', [['false', 'Todos'], ['true', 'Solo guardados']], String(!!f.savedOnly))}</div>
      <div class="spacer"></div>
      <button class="btn btn-ghost" data-action="reset-filters">${icon('x', 14)}Restablecer filtros</button>`;
  }

  function updateLoadButtons() {
    if (!tb) return;
    tb.loadAllBtn.dataset.action = state.autoLoading ? 'stop-load' : 'load-all';
    tb.loadAllBtn.innerHTML = state.autoLoading ? `${icon('stop', 14)}Detener (${state.ads.size})` : `${icon('refresh', 15)}Cargar todos`;
    tb.loadAllBtn.disabled = !state.autoLoading && state.hasNext === false;
    tb.loadAllBtn.title = state.hasNext === false ? 'Ya están cargados todos los resultados' : 'Carga todos los resultados de la búsqueda';
    if (state.overlayOpen) renderOverlayLoadMore();
  }

  // ======================= Integración con las tarjetas de Facebook =======================
  // Rendimiento: la búsqueda de tarjetas usa XPath (nativo del navegador, no JS nodo por nodo),
  // corre como máximo cada ~0,5 s y solo cuando Facebook agrega contenido con IDs de anuncios.
  // Primero se lee todo (sin tocar la página) y después se escribe, para no forzar recálculos de diseño.
  const DIGITS_XPATH =
    ".//text()[string-length(.) - string-length(translate(., '0123456789', '')) >= 13][not(ancestor::script or ancestor::style or ancestor::noscript)]";
  const ID_LABEL = /:\s*\d{13,20}\s*$/;
  const STOP_SEL = 'input, textarea, [role="search"], [role="dialog"], bap-toolbar, header, nav';

  let scanTimer = null;
  let lastScanAt = 0;
  let needFull = false;
  const pendingNodes = new Set();
  // full = revisar toda la página (cuando llegan datos nuevos). Si no, solo lo que agregó Facebook.
  function scheduleScan(full = true) {
    if (full) needFull = true;
    if (scanTimer) return;
    const wait = Math.max(60, 450 - (performance.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      lastScanAt = performance.now();
      scan();
    }, wait);
  }

  let lastRescan = 0;
  function requestRescan() {
    if (Date.now() - lastRescan < 3000) return;
    lastRescan = Date.now();
    window.postMessage({ source: 'BAP_CS', type: 'rescan' }, location.origin);
  }

  function purgeCards() {
    let changed = false;
    for (const [id, c] of native.cards) {
      if (c.root.isConnected && c.host.isConnected) continue;
      if (c.root.isConnected) {
        c.root.removeAttribute('data-bap-card');
        c.root.removeAttribute('data-bap-hide');
        c.root.style.removeProperty('order');
      }
      c.host.remove();
      native.cards.delete(id);
      changed = true;
    }
    if (changed) native.version++;
    return changed;
  }

  function clearNative() {
    for (const c of native.cards.values()) {
      c.root.removeAttribute('data-bap-card');
      c.root.removeAttribute('data-bap-hide');
      c.root.style.removeProperty('order');
      c.host.remove();
    }
    native.cards.clear();
    native.version++;
    unflatten();
  }

  // Cantidad de IDs de anuncios conocidos dentro de un elemento (con caché por pasada).
  function countKnown(el, cache) {
    let n = cache.get(el);
    if (n !== undefined) return n;
    n = 0;
    const m = (el.textContent || '').match(LONG_NUM);
    if (m) {
      const s = new Set();
      for (const x of m) if (state.ads.has(x)) s.add(x);
      n = s.size;
    }
    cache.set(el, n);
    return n;
  }

  // Sube desde "Identificador de la biblioteca: …" hasta la caja más grande que contiene solo ese anuncio.
  // Solo cuenta IDs de anuncios conocidos, así un teléfono de 13 dígitos en el texto no confunde la detección.
  function cardRootFor(textNode, cache) {
    let el = textNode.parentElement;
    while (el && el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (countKnown(p, cache) > 1) break;
      if (p.querySelector(STOP_SEL)) break;
      el = p;
    }
    return el;
  }

  function findDetailsButton(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = w.nextNode())) {
      const t = tn.data.trim();
      if (!t || t.length > 40 || !DETAILS_RE.test(t)) continue;
      let target = tn.parentElement;
      while (target && target.parentElement && target.parentElement !== root) {
        const p = target.parentElement;
        if ((p.textContent || '').trim() === t) {
          target = p;
          continue;
        }
        const cs = getComputedStyle(p);
        if (cs.display.includes('flex') && !cs.flexDirection.startsWith('column') && p.children.length <= 3) target = p;
        else break;
      }
      return target;
    }
    return null;
  }

  function candidatesIn(ctx, out) {
    if (ctx.nodeType === 3) {
      if (HAS_ID.test(ctx.data)) out.push(ctx);
      return;
    }
    const snap = document.evaluate(DIGITS_XPATH, ctx, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
  }

  function scan() {
    if (!document.body) return;
    const t0 = performance.now();
    const purged = purgeCards();
    // Si Facebook volvió a dibujar tarjetas, revisamos toda la página para reconectarlas.
    const full = needFull || purged;
    needFull = false;
    const nodes = full ? [document.body] : [...pendingNodes].filter((n) => n.isConnected);
    pendingNodes.clear();
    if (!state.ads.size || !nodes.length) {
      if (purged) scheduleRender();
      return;
    }

    // 1) Candidatos: textos con 13+ dígitos (búsqueda nativa del navegador).
    const texts = [];
    for (const n of nodes) candidatesIn(n, texts);
    const found = [];
    let unknown = 0;
    for (const tn of texts) {
      const m = tn.data.match(LONG_NUM);
      if (!m) continue;
      const ids = m.filter((x) => state.ads.has(x));
      if (ids.length !== 1) {
        if (!ids.length && ID_LABEL.test(tn.data.trim())) unknown++;
        continue;
      }
      if (native.cards.has(ids[0])) continue;
      const pe = tn.parentElement;
      if (!pe || pe.closest('[role="dialog"], [data-bap-card]')) continue;
      found.push([ids[0], tn]);
    }

    // 2) Lectura: ubicar la tarjeta y el botón "Ver detalles" de cada una.
    const cache = new Map();
    const plans = [];
    const used = new Set();
    for (const [id, tn] of found) {
      if (plans.some((p) => p.id === id)) continue;
      const root = cardRootFor(tn, cache);
      if (!root || used.has(root) || root === document.body || root.querySelector('[data-bap-card]')) continue;
      used.add(root);
      plans.push({ id, root, details: findDetailsButton(root) });
    }

    // 3) Escritura: marcar tarjetas e insertar los botones.
    for (const p of plans) {
      p.root.setAttribute('data-bap-card', p.id);
      const host = buildCardBar(state.ads.get(p.id), p.root, p.details);
      native.cards.set(p.id, { root: p.root, host, hidden: false, sel: false, order: '' });
    }
    if (plans.length) native.version++;
    if (unknown) requestRescan();
    if (native.cards.size) placeToolbar();
    if (plans.length || purged) scheduleRender();
    updateFallback();
    const dt = performance.now() - t0;
    if (dt > 40) console.debug(`[BAP] scan ${full ? 'completo' : 'parcial'} ${dt.toFixed(0)}ms · ${plans.length} tarjetas nuevas · ${native.cards.size} total`);
  }

  // ---------- Barra dentro de cada tarjeta ----------
  function cardBarHtml(ad) {
    const dest = BAP.destByKey[ad.dest] || BAP.destByKey.other;
    const destTitle = ad.channel && ad.channel !== dest.label ? `${dest.label} · ${ad.channel}` : dest.label;
    const sv = state.saved[ad.id];
    const n = (ad.media || []).length;
    const dl = BAP.downloadLabel(ad);
    return `
      <div class="nb-kpis">
        <span class="days ${BAP.daysTone(ad.days)}" title="Días en circulación">${icon(ad.days >= 30 ? 'flame' : 'clock', 14)}${BAP.fmtDays(ad.days)}</span>
        <span class="dest tone-${dest.tone}" title="${esc(destTitle)}${ad.ctaText ? ' · Botón: ' + esc(ad.ctaText) : ''}">${icon(dest.icon, 13)}<span class="lbl">${esc(destTitle)}</span></span>
        ${ad.copies > 1 ? `<span class="versions" title="Anuncios con este mismo creativo">${icon('layers', 13)}<b>${ad.copies}</b></span>` : ''}
        <span class="spacer"></span>
        <button class="icon-btn" data-action="more" title="Más opciones">${icon('dots', 18)}</button>
      </div>
      <div class="act-row">
        <button class="check" data-action="select" title="Seleccionar"><span class="box">${icon('check', 12)}</span></button>
        <div class="split">
          <button class="btn ${sv ? 'saved' : 'btn-soft'}" data-action="save" title="${sv ? 'Quitar de guardados' : 'Guardar para ver después'}">${icon(sv ? 'bookmarkFill' : 'bookmark', 15)}<span>${sv ? `Guardado · ${esc(sv.folder)}` : 'Guardar'}</span></button>
          <button class="btn ${sv ? 'saved' : 'btn-soft'}" data-action="save-menu" title="Elegir carpeta">${icon('chevronDown', 15)}</button>
        </div>
      </div>
      ${
        n > 1
          ? `<div class="split dl-split">
              <button class="btn btn-primary btn-lg" data-action="download" title="Descarga todos los archivos del anuncio">${icon('download', 16)}<span>${dl}</span></button>
              <button class="btn btn-primary btn-lg" data-action="download-menu" title="Elegir qué archivo descargar">${icon('chevronDown', 16)}</button>
            </div>`
          : `<button class="btn btn-primary btn-lg btn-block" data-action="download" ${n ? '' : 'disabled'}>${icon('download', 16)}${dl}</button>`
      }`;
  }

  function buildCardBar(ad, root, details) {
    const host = document.createElement('bap-cardbar');
    host.dataset.id = ad.id;
    const sr = makeShadow(host);
    const wrap = document.createElement('div');
    wrap.className = 'bap nb';
    wrap.innerHTML = cardBarHtml(ad);
    sr.appendChild(wrap);
    sr.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const cur = state.ads.get(host.dataset.id);
      if (cur) cardAction(btn.dataset.action, cur, btn);
    });
    if (details && details.parentElement && root.contains(details)) {
      details.parentElement.insertBefore(host, details);
    } else {
      wrap.classList.add('nb-top');
      root.insertBefore(host, root.firstChild);
    }
    return host;
  }

  function refreshSaved(id) {
    const ad = state.ads.get(id);
    if (!ad) return;
    const c = native.cards.get(id);
    if (c) {
      const wrap = c.host.shadowRoot.querySelector('.nb');
      wrap.innerHTML = cardBarHtml(ad);
    }
    const el = overlayCards.get(id);
    if (el) {
      const fresh = BAP.renderCard(ad, { mode: 'live', savedFolder: (state.saved[id] || {}).folder || null });
      el.querySelector('.split').replaceWith(fresh.querySelector('.split'));
    }
  }

  function setSelectedUI(id) {
    const on = state.selected.has(id);
    const c = native.cards.get(id);
    if (c && c.sel !== on) {
      c.sel = on;
      c.host.shadowRoot.querySelector('.nb').classList.toggle('selected', on);
    }
    const el = overlayCards.get(id);
    if (el) el.classList.toggle('selected', on);
  }

  // ---------- Filtros y orden sobre las tarjetas de Facebook ----------
  function lca(nodes) {
    const index = new Map();
    const anc = [];
    for (let a = nodes[0].parentElement; a; a = a.parentElement) {
      index.set(a, anc.length);
      anc.push(a);
    }
    let best = 0;
    for (let i = 1; i < nodes.length; i++) {
      let n = nodes[i].parentElement;
      while (n && !index.has(n)) n = n.parentElement;
      if (!n) return null;
      best = Math.max(best, index.get(n));
    }
    return anc[best] || null;
  }

  // Solo escribe en la página lo que cambió.
  function applyNative() {
    if (!native.cards.size) {
      if (native.grid) unflatten();
      return;
    }
    const sorting = state.sort !== 'default';
    const order = sorting ? new Map(state.view.map((a, i) => [a.id, i])) : null;
    for (const [id, c] of native.cards) {
      const hide = !state.viewIds.has(id);
      if (hide !== c.hidden) {
        c.hidden = hide;
        if (hide) c.root.setAttribute('data-bap-hide', '');
        else c.root.removeAttribute('data-bap-hide');
      }
      setSelectedUI(id);
      const o = sorting ? String(order.has(id) ? order.get(id) : 99999) : '';
      if (o !== c.order) {
        c.order = o;
        if (o) c.root.style.setProperty('order', o);
        else c.root.style.removeProperty('order');
      }
    }
    if (sorting) {
      if (native.flatVersion !== native.version || !native.grid) flatten();
    } else if (native.grid) unflatten();
  }

  // Para ordenar entre los distintos bloques que arma Facebook, aplanamos los contenedores intermedios
  // (display: contents) y convertimos el contenedor común en una grilla. No movemos nodos de Facebook.
  function flatten() {
    native.flatVersion = native.version;
    const roots = [...native.cards.values()].map((c) => c.root);
    if (roots.length < 2) return unflatten();
    const common = lca(roots);
    if (!common || common === document.body || common === document.documentElement) return unflatten();
    const flat = new Set();
    for (const r of roots) {
      let p = r.parentElement;
      while (p && p !== common && !flat.has(p)) {
        flat.add(p);
        p = p.parentElement;
      }
    }
    for (const el of native.flat) if (!flat.has(el)) el.removeAttribute('data-bap-flat');
    for (const el of flat) if (!el.hasAttribute('data-bap-flat')) el.setAttribute('data-bap-flat', '');
    if (native.grid && native.grid !== common) native.grid.removeAttribute('data-bap-grid');
    if (!common.hasAttribute('data-bap-grid')) common.setAttribute('data-bap-grid', '');
    native.grid = common;
    native.flat = flat;

    // Lo que no es tarjeta (encabezados, "cargando…") va arriba o abajo de la grilla.
    let first = roots[0];
    for (const r of roots) if (r.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) first = r;
    for (const el of native.ordered) el.style.removeProperty('order');
    native.ordered = new Set();
    const parents = [common, ...flat];
    for (const par of parents) {
      for (const el of par.children) {
        if (el.hasAttribute('data-bap-card') || el.hasAttribute('data-bap-flat')) continue;
        const before = el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING;
        el.style.setProperty('order', before ? '-1' : '1000000');
        native.ordered.add(el);
      }
    }
  }

  function unflatten() {
    for (const el of native.flat) el.removeAttribute('data-bap-flat');
    native.flat = new Set();
    if (native.grid) native.grid.removeAttribute('data-bap-grid');
    native.grid = null;
    for (const el of native.ordered) el.style.removeProperty('order');
    native.ordered = new Set();
    native.flatVersion = -1;
  }

  function placeToolbar() {
    if (!tb || state.overlayOpen) return;
    if (native.tbVersion === native.version && tb.host.isConnected) return;
    native.tbVersion = native.version;
    const roots = [...native.cards.values()].map((c) => c.root);
    if (!roots.length) return;
    const anchor = native.grid || (roots.length > 1 ? lca(roots) : roots[0].parentElement);
    if (!anchor || !anchor.parentElement || anchor === document.body) return;
    if (tb.host.nextElementSibling !== anchor || tb.host.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(tb.host, anchor);
    }
    tb.closeBtn.hidden = true;
  }

  // ---------- Observador de cambios de Facebook ----------
  // Ignora casi todos los cambios (animaciones, videos, tooltips, contadores): solo toma en cuenta
  // contenido nuevo que tenga el ID de un anuncio todavía sin botones, o la salida de una tarjeta nuestra.
  const HAS_ID = /\d{13}/;
  function wantsNode(text) {
    if (!HAS_ID.test(text)) return false;
    const m = text.match(LONG_NUM) || [];
    for (const x of m) if (state.ads.has(x) && !native.cards.has(x)) return true;
    // "Identificador…: 123…" de un anuncio sin datos todavía: sirve para pedir una relectura.
    return /:\s*\d{13,20}/.test(text) && m.some((x) => !state.ads.has(x));
  }
  function observePage() {
    const mo = new MutationObserver((muts) => {
      let schedule = false;
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.localName.startsWith('bap-')) continue;
            if (wantsNode(node.textContent)) {
              pendingNodes.add(node);
              schedule = true;
            }
          } else if (node.nodeType === 3 && wantsNode(node.data)) {
            pendingNodes.add(node);
            schedule = true;
          }
        }
        if (native.cards.size && !schedule) {
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1 || node.localName.startsWith('bap-')) continue;
            if (node.hasAttribute('data-bap-card') || node.querySelector('[data-bap-card]')) {
              schedule = true;
              break;
            }
          }
        }
      }
      if (schedule) scheduleScan(false);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ======================= Acciones de anuncio =======================

  function cardAction(action, ad, anchor) {
    switch (action) {
      case 'select':
        if (state.selected.has(ad.id)) state.selected.delete(ad.id);
        else state.selected.add(ad.id);
        setSelectedUI(ad.id);
        updateSelbar();
        updateToolbar();
        return;
      case 'save':
        if (state.saved[ad.id]) return unsave([ad.id]);
        return saveAds([ad]);
      case 'save-menu':
        return openFolderMenu(anchor, ad, (folder) => saveAds([ad], folder));
      case 'download':
        return downloadAds([ad]);
      case 'download-menu':
        return openDownloadMenu(anchor, ad);
      case 'more':
        return openMoreMenu(anchor, ad);
    }
  }

  function selectedAds() {
    return [...state.selected].map((id) => state.ads.get(id)).filter(Boolean);
  }

  // ======================= Capa fija (panel lateral, menús, toasts) =======================

  function buildLayer() {
    const host = document.createElement('bap-layer');
    const root = makeShadow(host);
    const wrap = document.createElement('div');
    wrap.className = 'bap';
    wrap.innerHTML = `
      <button class="pill" data-action="to-toolbar" data-ref="pill" hidden>${icon('filter', 15)}Filtros · <span data-ref="pillN">0</span> visibles</button>
      <button class="launcher" data-action="open-overlay" data-ref="launcher" hidden title="Ver los anuncios en grilla">
        <span class="logo">${icon('library', 17)}</span><span>${esc(BAP.APP_NAME)}</span><span class="n" data-ref="launchN">0</span>
      </button>
      <div class="overlay" data-ref="overlay" hidden>
        <div class="overlay-top" data-ref="overlayTop"></div>
        <div class="content">
          <div class="grid" data-ref="grid"></div>
          <div class="empty" data-ref="empty" hidden></div>
          <div class="sentinel" data-ref="sentinel"></div>
          <div class="loadmore" data-ref="loadmore"></div>
        </div>
      </div>
      <div class="scrim" data-action="close-drawer" data-ref="scrim" hidden></div>
      <aside class="drawer" data-ref="drawer" hidden aria-label="Anuncios guardados">
        <div class="drawer-h">
          <div class="brand">${icon('bookmark', 17)}Guardados <span class="filter-count" data-ref="drawerN">0</span></div>
          <div class="spacer"></div>
          <button class="icon-btn" data-action="close-drawer" title="Cerrar (Esc)">${icon('x', 18)}</button>
        </div>
        <div class="drawer-tools">
          <label class="search">${icon('search', 15)}<input class="input" type="search" placeholder="Buscar en guardados…" data-ref="drawerSearch"></label>
          <div class="chips" data-ref="drawerFolders"></div>
        </div>
        <div class="drawer-list" data-ref="drawerList"></div>
        <div class="drawer-f">
          <button class="btn" data-action="drawer-export" data-value="xlsx">${icon('sheet', 15)}Exportar Excel</button>
          <button class="btn" data-action="drawer-export" data-value="csv">CSV</button>
          <button class="btn" data-action="drawer-copy">${icon('link', 15)}Copiar links</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" data-action="open-saved-page" title="Abre la página completa de guardados en otra pestaña">${icon('external', 14)}Página completa</button>
        </div>
      </aside>
      <div class="selbar" data-ref="selbar" hidden></div>
      <div class="toasts" data-ref="toasts"></div>`;
    root.appendChild(wrap);
    const refs = { host, root, wrap };
    root.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));
    document.documentElement.appendChild(host);

    root.addEventListener('click', onLayerClick);
    ['keydown', 'keyup', 'keypress'].forEach((t) => root.addEventListener(t, stopKeys));
    refs.drawerSearch.addEventListener(
      'input',
      debounce(() => {
        state.drawerText = refs.drawerSearch.value.trim();
        renderDrawer();
      }, 150)
    );
    refs.drawerList.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.role !== 'note') return;
      const id = t.closest('[data-id]').dataset.id;
      clearTimeout(t._timer);
      t._timer = setTimeout(() => BAP.storage.patch(id, { note: t.value }), 500);
    });
    // Cierra el menú solo si se scrollea de verdad (no por un ajuste chico al hacer clic).
    const closeOnScroll = () => {
      if (!menu) return;
      const y = state.overlayOpen ? refs.overlay.scrollTop : window.scrollY;
      if (Math.abs(y - (menu._scrollY ?? y)) > 40) closeMenu();
    };
    refs.overlay.addEventListener('scroll', closeOnScroll, { passive: true });
    window.addEventListener('scroll', closeOnScroll, { passive: true });

    new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || !state.overlayOpen) return;
        if (state.renderLimit < state.view.length) {
          state.renderLimit += PAGE_SIZE;
          renderOverlayGrid();
        } else if (state.hasNext !== false && !state.loading && !state.autoLoading && state.ads.size) loadMore();
      },
      { root: refs.overlay, rootMargin: '600px' }
    ).observe(refs.sentinel);
    return refs;
  }

  function onLayerClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (menu && !e.target.closest('.menu')) closeMenu();
      return;
    }
    if (menu && !btn.closest('.menu')) closeMenu();
    const action = btn.dataset.action;
    const value = btn.dataset.value;
    switch (action) {
      case 'to-toolbar':
        return tb.host.scrollIntoView({ block: 'start', behavior: 'smooth' });
      case 'open-overlay':
        return setOverlay(true);
      case 'close-drawer':
        return openDrawer(false);
      case 'drawer-folder':
        state.drawerFolder = value;
        return renderDrawer();
      case 'drawer-export':
        return exportAds(drawerItems(), value, { saved: true, prefix: 'anuncios-guardados' });
      case 'drawer-copy': {
        const items = drawerItems();
        if (!items.length) return toast('No hay guardados para copiar', true);
        return copy(items.map((a) => a.url).join('\n'), `${items.length} links copiados`);
      }
      case 'open-saved-page':
        return chrome.runtime.sendMessage({ type: 'open-saved' });
      case 'sel-download':
        return downloadAds(selectedAds());
      case 'sel-save':
        return openFolderMenu(btn, null, (folder) => saveAds(selectedAds(), folder));
      case 'sel-export':
        return exportAds(selectedAds(), 'xlsx');
      case 'sel-copy':
        return copy(selectedAds().map((a) => a.url).join('\n'), `${state.selected.size} links copiados`);
      case 'sel-clear':
        state.selected.clear();
        return render();
      case 'toast-action': {
        const t = btn.closest('.toast');
        if (t && t._fn) t._fn();
        if (t) t.remove();
        return;
      }
    }

    // Guardados (filas del panel lateral)
    const row = btn.closest('.srow');
    if (row) {
      const rec = state.saved[row.dataset.id];
      if (!rec) return;
      switch (action) {
        case 's-copy':
          return copy(rec.url, 'Link copiado');
        case 's-download':
          return downloadAds([rec]);
        case 's-folder':
          return openFolderMenu(btn, rec, (folder) => BAP.storage.patch(rec.id, { folder }).then(() => ensureFolder(folder)));
        case 's-delete':
          return unsave([rec.id]);
      }
      return;
    }

    // Tarjetas de la vista en grilla (respaldo)
    const card = btn.closest('.card');
    const ad = card && state.ads.get(card.dataset.id);
    if (!ad) return;
    if (BAP.handleMediaAction(action, card, ad)) return;
    cardAction(action, ad, btn);
  }

  async function ensureFolder(folder) {
    if (!state.folders.includes(folder)) {
      state.folders.push(folder);
      await BAP.storage.setFolders(state.folders);
    }
  }

  // ---------- Panel lateral de guardados ----------
  function openDrawer(open) {
    state.drawerOpen = open;
    layer.drawer.hidden = !open;
    layer.scrim.hidden = !open;
    closeMenu();
    if (open) {
      renderDrawer();
      setTimeout(() => layer.drawerSearch.focus(), 50);
    }
  }

  function drawerItems() {
    const f = Object.assign(BAP.defaultFilters(), { text: state.drawerText });
    return Object.values(state.saved)
      .filter((a) => (state.drawerFolder === '__all' || a.folder === state.drawerFolder) && BAP.matches(a, f))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  function renderDrawer() {
    if (!layer || !state.drawerOpen) return;
    const all = Object.values(state.saved);
    layer.drawerN.textContent = all.length;
    const counts = {};
    for (const a of all) counts[a.folder] = (counts[a.folder] || 0) + 1;
    if (state.drawerFolder !== '__all' && !state.folders.includes(state.drawerFolder)) state.drawerFolder = '__all';
    layer.drawerFolders.innerHTML = [['__all', 'Todas', all.length], ...state.folders.map((f) => [f, f, counts[f] || 0])]
      .map(([k, l, n]) => `<button class="chip ${state.drawerFolder === k ? 'on' : ''}" data-action="drawer-folder" data-value="${esc(k)}">${k === '__all' ? '' : icon('folder', 13)}${esc(l)}<span class="count">${n}</span></button>`)
      .join('');
    const items = drawerItems();
    if (!items.length) {
      layer.drawerList.innerHTML = `<div class="empty" style="padding:50px 10px">${icon('bookmark', 34)}<h3>${all.length ? 'Nada por acá' : 'Todavía no guardaste anuncios'}</h3><p>${
        all.length ? 'Probá con otra carpeta o búsqueda.' : 'Tocá “Guardar” en cualquier anuncio y aparece acá, con su link listo para volver a verlo.'
      }</p></div>`;
      return;
    }
    layer.drawerList.innerHTML = items
      .map((a) => {
        const dest = BAP.destByKey[a.dest] || BAP.destByKey.other;
        const thumb = a.thumbData || a.thumb;
        return `<div class="srow" data-id="${esc(a.id)}">
          <a class="sthumb" href="${esc(a.url)}" target="_blank" rel="noopener" title="Abrir anuncio">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon('image', 20)}${a.mediaType === 'video' ? `<span class="splay">${icon('play', 12)}</span>` : ''}</a>
          <div class="sbody">
            <a class="sname" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.pageName)}</a>
            <div class="smeta">
              <span class="days ${BAP.daysTone(a.days)}">${BAP.fmtDays(a.days)}</span>
              <span class="dest tone-${dest.tone}">${icon(dest.icon, 12)}<span class="lbl">${esc(dest.label)}</span></span>
            </div>
            <div class="stext">${esc((a.body || a.title || '').slice(0, 140))}</div>
            <input class="input snote" data-role="note" placeholder="Agregar nota…" value="${esc(a.note || '')}">
            <div class="sacts">
              <a class="btn btn-soft" href="${esc(a.url)}" target="_blank" rel="noopener">${icon('external', 13)}Ver anuncio</a>
              <button class="btn" data-action="s-copy" title="Copiar link">${icon('link', 13)}</button>
              <button class="btn" data-action="s-download" title="Descargar">${icon('download', 13)}</button>
              <button class="btn" data-action="s-folder" title="Mover de carpeta">${icon('folder', 13)}<span>${esc(a.folder)}</span></button>
              <button class="btn btn-danger" data-action="s-delete" title="Eliminar">${icon('trash', 13)}</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
    layer.drawerList.querySelectorAll('img').forEach((img) =>
      img.addEventListener('error', () => {
        img.replaceWith(document.createRange().createContextualFragment(icon('image', 20)));
      })
    );
  }

  // ---------- Selección ----------
  function updateSelbar() {
    if (!layer) return;
    const n = state.selected.size;
    layer.selbar.hidden = !n;
    if (!n) return;
    layer.selbar.innerHTML = `<span>${n} seleccionado${n > 1 ? 's' : ''}</span>
      <button class="btn btn-primary" data-action="sel-download">${icon('download', 14)}Descargar</button>
      <button class="btn" data-action="sel-save">${icon('bookmark', 14)}Guardar</button>
      <button class="btn" data-action="sel-export">${icon('sheet', 14)}Excel</button>
      <button class="btn" data-action="sel-copy">${icon('link', 14)}Copiar links</button>
      <button class="btn" data-action="sel-clear" title="Quitar selección">${icon('x', 14)}</button>`;
  }

  // ---------- Respaldo: vista en grilla ----------
  let fallbackTimer = null;
  function updateFallback() {
    if (!layer) return;
    const integrated = native.cards.size > 0;
    if (integrated) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
      state.mode = 'native';
      if (!state.overlayOpen) layer.launcher.hidden = true;
      return;
    }
    if (state.ads.size && !fallbackTimer && state.mode === 'native') {
      // Si en unos segundos no reconocemos las tarjetas de Facebook, mostramos la vista de respaldo.
      fallbackTimer = setTimeout(() => {
        if (native.cards.size) return;
        state.mode = 'fallback';
        layer.launcher.hidden = state.overlayOpen;
        layer.launchN.textContent = `${state.ads.size} anuncios`;
      }, 5000);
    }
    if (state.mode === 'fallback') {
      layer.launcher.hidden = state.overlayOpen;
      layer.launchN.textContent = `${state.ads.size} anuncios`;
    }
  }

  function setOverlay(open) {
    state.overlayOpen = open;
    layer.overlay.hidden = !open;
    layer.launcher.hidden = open || state.mode !== 'fallback';
    closeMenu();
    if (open) {
      layer.overlayTop.appendChild(tb.host);
      tb.closeBtn.hidden = false;
      render();
    } else {
      layer.overlay.querySelectorAll('video').forEach((v) => v.pause());
      tb.closeBtn.hidden = true;
      native.tbVersion = -1;
      if (native.cards.size) placeToolbar();
      else tb.host.remove();
      render();
    }
  }

  function getOverlayCard(ad) {
    let el = overlayCards.get(ad.id);
    if (!el) {
      el = BAP.renderCard(ad, { mode: 'live', savedFolder: (state.saved[ad.id] || {}).folder || null, selected: state.selected.has(ad.id) });
      overlayCards.set(ad.id, el);
    }
    el.classList.toggle('selected', state.selected.has(ad.id));
    return el;
  }

  function renderOverlayGrid() {
    const list = state.view.slice(0, state.renderLimit);
    layer.empty.hidden = list.length > 0;
    if (!list.length) {
      layer.empty.innerHTML = state.ads.size
        ? `${icon('filter', 40)}<h3>Ningún anuncio coincide con los filtros</h3><p>Hay ${state.ads.size} anuncios cargados. Probá quitar algún filtro.</p>`
        : `${icon('search', 40)}<h3>Todavía no hay anuncios cargados</h3><p>Hacé una búsqueda en la Biblioteca de anuncios.</p>`;
    }
    const grid = layer.grid;
    const current = [...grid.children];
    const same = current.length === list.length && current.every((n, i) => n.dataset.id === list[i].id);
    if (same) list.forEach((ad) => getOverlayCard(ad));
    else {
      const wanted = new Set(list.map((a) => a.id));
      current.forEach((n) => !wanted.has(n.dataset.id) && n.remove());
      let ref = grid.firstElementChild;
      for (const ad of list) {
        const el = getOverlayCard(ad);
        if (el === ref) ref = ref.nextElementSibling;
        else grid.insertBefore(el, ref);
      }
    }
    renderOverlayLoadMore();
  }

  function renderOverlayLoadMore() {
    const busy = state.loading || state.autoLoading;
    let html = '';
    if (state.renderLimit < state.view.length) html = `<span class="hint">Bajá para ver más…</span>`;
    else if (state.ads.size && state.hasNext !== false) html = busy ? `<span class="btn" style="pointer-events:none"><span class="spinner"></span>Cargando más anuncios…</span>` : '';
    else if (state.ads.size && state.hasNext === false) html = `<div class="hint">No hay más resultados para esta búsqueda.</div>`;
    layer.loadmore.innerHTML = html;
  }

  // ---------- Menús ----------
  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
    }
  }

  function placeMenu(m, anchor) {
    layer.wrap.appendChild(m);
    const r = anchor.getBoundingClientRect();
    let left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8));
    let top = r.bottom + 6;
    if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    m._scrollY = state.overlayOpen ? layer.overlay.scrollTop : window.scrollY;
    menu = m;
  }

  function openFolderMenu(anchor, ad, onPick) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const current = ad && state.saved[ad.id] ? state.saved[ad.id].folder : null;
    m.innerHTML =
      `<div class="mh">Guardar en carpeta</div>` +
      state.folders.map((fo) => `<button class="mi ${fo === current ? 'on' : ''}" data-folder="${esc(fo)}">${icon(fo === current ? 'check' : 'folder', 15)}${esc(fo)}</button>`).join('') +
      `<div class="sep"></div>
       <form><input class="input" placeholder="Nueva carpeta…" maxlength="40"><button class="btn btn-primary" type="submit" title="Crear y guardar">${icon('folderPlus', 14)}</button></form>` +
      (current ? `<div class="sep"></div><button class="mi danger" data-unsave="1">${icon('trash', 15)}Quitar de guardados</button>` : '');
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.folder) {
        closeMenu();
        onPick(b.dataset.folder);
      } else if (b.dataset.unsave) {
        closeMenu();
        unsave([ad.id]);
      }
    });
    m.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = e.target.querySelector('input').value.trim();
      if (!name) return;
      closeMenu();
      onPick(name);
    });
    placeMenu(m, anchor);
  }

  function openDownloadMenu(anchor, ad) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const media = ad.media || [];
    m.innerHTML =
      `<div class="mh">Elegí qué descargar</div>` +
      media
        .map((x, i) => {
          const thumb = x.poster || (x.type === 'image' ? x.url : '');
          return `<button class="mi mi-media" data-i="${i}">${
            thumb ? `<img src="${esc(thumb)}" alt="" referrerpolicy="no-referrer">` : icon(x.type === 'video' ? 'video' : 'image', 15)
          }<span>${esc(BAP.mediaItemLabel(ad, i))}${x.type === 'video' && x.hd ? ' · HD' : ''}</span></button>`;
        })
        .join('') +
      `<div class="sep"></div><button class="mi" data-i="all">${icon('download', 15)}${esc(BAP.downloadLabel(ad))}</button>`;
    m.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove()));
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('[data-i]');
      if (!b) return;
      closeMenu();
      if (b.dataset.i === 'all') downloadAds([ad]);
      else downloadAds([ad], Number(b.dataset.i));
    });
    placeMenu(m, anchor);
  }

  function openMoreMenu(anchor, ad) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const pageAds = ad.pageId
      ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${encodeURIComponent(ad.pageId)}&search_type=page&media_type=all`
      : '';
    const items = [
      ['copy-link', 'link', 'Copiar link del anuncio'],
      ['copy-id', 'copy', 'Copiar ID'],
      ad.body ? ['copy-text', 'copy', 'Copiar texto del anuncio'] : null,
      'sep',
      pageAds ? ['page-ads', 'library', 'Ver todos los anuncios de esta página'] : null,
      ad.linkUrl ? ['open-dest', 'globe', 'Abrir destino del botón'] : null,
    ].filter(Boolean);
    m.innerHTML =
      `<div class="mh">${esc(ad.ctaText || 'Sin botón')}${ad.ctaType ? ' · ' + esc(ad.ctaType) : ''}</div>` +
      items.map((it) => (it === 'sep' ? '<div class="sep"></div>' : `<button class="mi" data-m="${it[0]}">${icon(it[1], 15)}${esc(it[2])}</button>`)).join('');
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('[data-m]');
      if (!b) return;
      closeMenu();
      switch (b.dataset.m) {
        case 'copy-link':
          return copy(ad.url, 'Link copiado');
        case 'copy-id':
          return copy(ad.id, 'ID copiado');
        case 'copy-text':
          return copy(ad.body, 'Texto copiado');
        case 'page-ads':
          return (location.href = pageAds);
        case 'open-dest':
          return window.open(ad.linkUrl, '_blank', 'noopener');
      }
    });
    placeMenu(m, anchor);
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!menu) return;
      const path = e.composedPath();
      if (!path.includes(menu)) closeMenu();
    },
    true
  );

  // ---------- Toasts ----------
  function toast(msg, isErr, action) {
    if (!layer) return;
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.setAttribute('role', 'status');
    t.innerHTML = `${icon(isErr ? 'x' : 'check', 15)}<span>${esc(msg)}</span>${action ? `<button class="toast-btn" data-action="toast-action">${esc(action.label)}</button>` : ''}`;
    if (action) t._fn = action.fn;
    layer.toasts.appendChild(t);
    setTimeout(() => t.remove(), action ? 5000 : 3200);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ======================= Inicio =======================

  function handleEscape() {
    if (menu) closeMenu();
    else if (state.drawerOpen) openDrawer(false);
    else if (state.overlayOpen) setOverlay(false);
    else return false;
    return true;
  }

  // Las teclas escritas en nuestros campos no deben llegar a los atajos de Facebook (salvo Escape, que manejamos acá).
  function stopKeys(e) {
    e.stopPropagation();
    if (e.type === 'keydown' && e.key === 'Escape') handleEscape();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && handleEscape()) e.stopPropagation();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !tb) return;
    if (msg.type === 'open-drawer') openDrawer(true);
    if (msg.type === 'toggle-panel') {
      if (state.mode === 'fallback' || !native.cards.size) setOverlay(!state.overlayOpen);
      else tb.host.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  async function init() {
    await Promise.all([loadStorage(), loadCss()]);
    const start = () => {
      tb = buildToolbar();
      layer = buildLayer();
      observePage();
      render();
      scheduleScan(true);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  init();
})();
