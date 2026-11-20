/*
 * Content script (mundo aislado): recibe los anuncios del hook, mantiene el estado
 * y dibuja el panel con filtros, orden, descarga, guardado y exportación.
 */
(function () {
  if (window.__BAP_CS__) return;
  window.__BAP_CS__ = true;

  const BAP = window.BAP;
  const { icon, esc } = BAP;
  const PAGE_SIZE = 60;
  const LOAD_ALL_CAP = 3000;

  const state = {
    ads: new Map(),
    total: null,
    hasNext: null,
    open: false,
    filters: BAP.defaultFilters(),
    sort: 'default',
    selected: new Set(),
    saved: {},
    folders: ['General'],
    prefs: { lastFolder: 'General', autoLoad: true },
    loading: false,
    autoLoading: false,
    renderLimit: PAGE_SIZE,
    view: [],
    advOpen: false,
  };
  const cardCache = new Map();
  let ui = null;

  // ======================= Entrada de datos =======================

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'BAP_HOOK') return;
    const { type, payload } = ev.data;
    if (type === 'reset') resetAds();
    else if (type === 'ads') ingest(payload || {});
  });
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
    if (added) scheduleRender();
    else scheduleRender(true);
  }

  function resetAds() {
    state.ads.clear();
    state.selected.clear();
    state.total = null;
    state.hasNext = null;
    state.renderLimit = PAGE_SIZE;
    cardCache.clear();
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
      for (const id of ids) {
        if ((prev[id] || {}).folder !== (state.saved[id] || {}).folder) refreshCardSaved(id);
      }
      scheduleRender(true);
    }
    if (changes[k.folders]) {
      state.folders = changes[k.folders].newValue || ['General'];
    }
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
    toast(ads.length > 1 ? `${ads.length} anuncios guardados en “${folder}”` : `Guardado en “${folder}”`);
    // Miniatura durable (los links de Facebook vencen): la pide el service worker.
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

  async function downloadAds(ads) {
    const items = ads.flatMap((ad) => BAP.downloadItems(ad));
    if (!items.length) return toast('No hay archivos para descargar', true);
    if (items.length > 25 && !confirm(`Se van a descargar ${items.length} archivos. ¿Continuar?`)) return;
    toast(items.length > 1 ? `Descargando ${items.length} archivos…` : 'Descargando…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'download', items });
      if (r && r.failed) toast(`${r.failed} archivo(s) no se pudieron descargar`, true);
    } catch (e) {
      toast('Error al descargar. Recargá la página e intentá de nuevo.', true);
    }
  }

  function exportAds(ads, format) {
    if (!ads.length) return toast('No hay anuncios para exportar', true);
    BAP.exportAds(ads, format, { prefix: 'biblioteca-anuncios' });
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

  // La página de Facebook sigue debajo del panel: hacer scroll al final dispara su carga de más resultados.
  async function loadMore() {
    if (state.loading) return false;
    state.loading = true;
    updateLoadMore();
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
    updateLoadMore();
    return ok;
  }

  async function loadAll() {
    if (state.autoLoading) return;
    state.autoLoading = true;
    updateLoadMore();
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
    updateLoadMore();
    toast(stopped ? `Carga detenida · ${state.ads.size} anuncios` : `Listo · ${state.ads.size} anuncios cargados`);
  }

  // ======================= UI =======================

  async function buildUI() {
    if (ui) return;
    const host = document.createElement('div');
    host.id = 'bap-root';
    host.style.cssText = 'all: initial;';
    const root = host.attachShadow({ mode: 'open' });
    let css = '';
    try {
      const [a, b] = await Promise.all(
        ['src/shared/ui.css', 'src/content/panel.css'].map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text()))
      );
      css = a + '\n' + b;
    } catch (e) {
      console.warn('[BAP] css', e);
    }
    root.innerHTML = `<style>${css}</style>
      <div class="bap">
        <button class="launcher" data-action="open" title="Abrir ${esc(BAP.APP_NAME)}">
          <span class="logo">${icon('library', 17)}</span><span>${esc(BAP.APP_NAME)}</span><span class="n" data-ref="launchN">0</span>
        </button>
        <div class="overlay" data-ref="overlay" hidden>
          <div class="topbar"><div class="topbar-in">
            <div class="brand-row">
              <div class="brand"><span class="logo">${icon('library', 17)}</span>${esc(BAP.APP_NAME)}</div>
              <div class="stats" data-ref="stats"></div>
              <div class="spacer"></div>
              <label class="search">${icon('search', 15)}<input class="input" type="search" placeholder="Buscar en estos resultados…" data-ref="search"></label>
              <button class="btn" data-action="open-saved">${icon('bookmark', 15)}Guardados <span class="filter-count" data-ref="savedN">0</span></button>
              <button class="btn" data-action="close" title="Volver a la Biblioteca (Esc)">${icon('x', 15)}Cerrar</button>
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
                <input class="input input-num" type="number" min="0" placeholder="≥ días" data-ref="minDays" title="Mínimo de días activo" style="height:26px;width:72px;margin-left:2px">
              </div>
              <div class="seg" data-ref="sortSeg"><span class="seg-label">${icon('sort', 13)}Ordenar por</span></div>
            </div>

            <div class="tb-row">
              <button class="chip" data-action="status-active" data-ref="activeChip">${icon('checkCircle', 13)}Solo activos</button>
              <button class="btn btn-soft" data-action="download-all" data-ref="dlAll">${icon('download', 15)}Descargar todo</button>
              <button class="btn" data-action="export" data-value="xlsx">${icon('sheet', 15)}Exportar Excel</button>
              <button class="btn" data-action="export" data-value="csv">CSV</button>
              <button class="btn btn-ghost" data-action="select-all" data-ref="selAll">Seleccionar todos</button>
              <div class="spacer"></div>
              <button class="btn" data-action="load-more" data-ref="loadMoreBtn">${icon('arrowDown', 15)}Cargar más</button>
              <button class="btn btn-gold" data-action="load-all" data-ref="loadAllBtn">${icon('refresh', 15)}Cargar todos</button>
            </div>

            <div class="dest-row" data-ref="destRow"></div>
            <div class="adv" data-ref="adv" hidden></div>
          </div></div>

          <div class="content">
            <div class="grid" data-ref="grid"></div>
            <div class="empty" data-ref="empty" hidden></div>
            <div class="sentinel" data-ref="sentinel"></div>
            <div class="loadmore" data-ref="loadmore"></div>
          </div>
        </div>
        <div class="selbar" data-ref="selbar" hidden></div>
        <div class="toasts" data-ref="toasts"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const refs = {};
    root.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));
    ui = { host, root, ...refs };

    // Orden
    ui.sortSeg.insertAdjacentHTML(
      'beforeend',
      BAP.SORTS.map((s) => `<button data-action="sort" data-value="${s.key}" ${s.key === 'reach' ? 'data-reach="1" hidden' : ''}>${esc(s.key === 'default' ? 'Facebook' : s.label.replace('Más días activo', 'Más días').replace('Menos días activo', 'Menos días'))}</button>`).join('')
    );

    root.addEventListener('click', onClick);
    ui.search.addEventListener('input', debounce(() => {
      state.filters.text = ui.search.value.trim();
      state.renderLimit = PAGE_SIZE;
      render();
    }, 200));
    ui.minDays.addEventListener('change', () => {
      state.filters.minDays = Math.max(0, Number(ui.minDays.value) || 0);
      afterFilterChange();
    });
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) {
        if (ui.menu) closeMenu();
        else setOpen(false);
      }
    });
    ui.overlay.addEventListener('scroll', () => closeMenu(), { passive: true });

    new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || !state.open) return;
        if (state.renderLimit < state.view.length) {
          state.renderLimit += PAGE_SIZE;
          renderGrid();
        } else if (state.prefs.autoLoad !== false && state.hasNext !== false && !state.loading && !state.autoLoading && state.ads.size) {
          loadMore();
        }
      },
      { root: ui.overlay, rootMargin: '600px' }
    ).observe(ui.sentinel);

    render();
  }

  function setOpen(open) {
    state.open = open;
    ui.overlay.hidden = !open;
    ui.root.querySelector('.launcher').hidden = open;
    if (!open) {
      closeMenu();
      ui.overlay.querySelectorAll('video').forEach((v) => v.pause());
    } else {
      render();
    }
    updateSelbar();
  }

  // ---------- Render ----------
  let renderQueued = false;
  let lightOnly = true;
  function scheduleRender(light) {
    if (!light) lightOnly = false;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const l = lightOnly;
      lightOnly = true;
      if (!ui) return;
      if (l) renderChrome();
      else render();
    });
  }

  function filteredExcept(key) {
    const f = Object.assign({}, state.filters, { [key]: BAP.defaultFilters()[key] });
    const out = [];
    for (const ad of state.ads.values()) if (BAP.matches(ad, f, state.saved)) out.push(ad);
    return out;
  }

  function computeView() {
    const list = [];
    for (const ad of state.ads.values()) if (BAP.matches(ad, state.filters, state.saved)) list.push(ad);
    state.view = BAP.sortAds(list, state.sort);
  }

  function render() {
    if (!ui) return;
    computeView();
    renderChrome();
    if (state.open) renderGrid();
  }

  function renderChrome() {
    updateLauncher();
    if (!state.open) return;
    updateStats();
    updateToolbar();
    updateDestChips();
    if (state.advOpen) renderAdvanced();
    updateLoadMore();
    updateSelbar();
  }

  function updateLauncher() {
    ui.launchN.textContent = state.ads.size ? `${state.ads.size} anuncios` : 'Abrir';
    ui.savedN.textContent = Object.keys(state.saved).length;
  }

  function updateStats() {
    const parts = [];
    if (state.total != null) parts.push(`<span>~<b>${BAP.fmtNum(state.total)}</b> resultados en la búsqueda</span>`);
    parts.push(`<span><b>${state.ads.size}</b> cargados</span>`);
    parts.push(`<span><b>${state.view.length}</b> con estos filtros</span>`);
    ui.stats.innerHTML = parts.join('<span class="dot"></span>');
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
    ui.daysSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.value) === Number(f.minDays)));
    if (document.activeElement !== ui.host || ui.root.activeElement !== ui.minDays) {
      ui.minDays.value = [0, 7, 30, 60, 90].includes(Number(f.minDays)) ? '' : f.minDays || '';
    }
    ui.sortSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === state.sort));
    const hasReach = [...state.ads.values()].some((a) => a.reach != null);
    const rb = ui.sortSeg.querySelector('[data-reach]');
    if (rb) rb.hidden = !hasReach;
    ui.activeChip.classList.toggle('on', f.status === 'active');
    const n = activeFilterCount();
    ui.filterN.hidden = !n;
    ui.filterN.textContent = n;
    ui.advBtn.classList.toggle('active-filter', state.advOpen || n > 0);
    const files = state.view.reduce((s, a) => s + (a.media || []).length, 0);
    ui.dlAll.innerHTML = `${icon('download', 15)}Descargar todo <span class="filter-count">${files}</span>`;
    ui.dlAll.disabled = !files;
    const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
    ui.selAll.textContent = allSel ? 'Quitar selección' : 'Seleccionar todos';
    if (ui.search.value !== state.filters.text && ui.root.activeElement !== ui.search) ui.search.value = state.filters.text;
  }

  function updateDestChips() {
    const base = filteredExcept('dest');
    const counts = { all: base.length };
    for (const a of base) counts[a.dest] = (counts[a.dest] || 0) + 1;
    const f = state.filters;
    const chip = (key, label, ic) =>
      `<button class="chip ${f.dest === key ? 'on' : ''} ${!counts[key] && key !== 'all' ? 'zero' : ''}" data-action="dest" data-value="${key}">${ic ? icon(ic, 14) : ''}${esc(label)}<span class="count">${counts[key] || 0}</span></button>`;
    ui.destRow.innerHTML =
      `<span class="lbl">Destino del botón</span>` +
      chip('all', 'Todos', 'grid') +
      BAP.DESTINATIONS.map((d) => chip(d.key, d.label, d.icon)).join('');
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

    ui.adv.innerHTML = `
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

  function updateLoadMore() {
    if (!ui) return;
    const busy = state.loading || state.autoLoading;
    ui.loadMoreBtn.disabled = busy;
    ui.loadMoreBtn.innerHTML = state.loading && !state.autoLoading ? `<span class="spinner"></span>Cargando…` : `${icon('arrowDown', 15)}Cargar más`;
    ui.loadAllBtn.dataset.action = state.autoLoading ? 'stop-load' : 'load-all';
    ui.loadAllBtn.innerHTML = state.autoLoading ? `${icon('stop', 14)}Detener (${state.ads.size})` : `${icon('refresh', 15)}Cargar todos`;

    let html = '';
    if (state.renderLimit < state.view.length) {
      html = `<button class="btn" data-action="show-more">Mostrar ${Math.min(PAGE_SIZE, state.view.length - state.renderLimit)} más</button>`;
    } else if (state.ads.size && state.hasNext !== false) {
      html = busy
        ? `<span class="btn" style="pointer-events:none"><span class="spinner"></span>Cargando más anuncios de Facebook…</span>`
        : `<button class="btn" data-action="load-more">${icon('arrowDown', 15)}Cargar más de Facebook</button>`;
    } else if (state.ads.size && state.hasNext === false) {
      html = `<div class="hint">No hay más resultados para esta búsqueda.</div>`;
    }
    ui.loadmore.innerHTML = html;
  }

  function updateSelbar() {
    const n = state.selected.size;
    ui.selbar.hidden = !state.open || !n;
    if (!n) return;
    ui.selbar.innerHTML = `<span>${n} seleccionado${n > 1 ? 's' : ''}</span>
      <button class="btn btn-primary" data-action="sel-download">${icon('download', 14)}Descargar</button>
      <button class="btn" data-action="sel-save">${icon('bookmark', 14)}Guardar</button>
      <button class="btn" data-action="sel-export">${icon('sheet', 14)}Excel</button>
      <button class="btn" data-action="sel-copy">${icon('link', 14)}Copiar links</button>
      <button class="btn" data-action="sel-clear" title="Quitar selección">${icon('x', 14)}</button>`;
  }

  function emptyHtml() {
    if (!state.ads.size) {
      return `${icon('search', 40)}<h3>Todavía no hay anuncios cargados</h3>
        <p>Hacé una búsqueda en la Biblioteca de anuncios (o recargá la página) y los resultados van a aparecer acá automáticamente.</p>
        <p style="margin-top:14px"><button class="btn btn-primary" data-action="close">Ir a la búsqueda</button></p>`;
    }
    return `${icon('filter', 40)}<h3>Ningún anuncio coincide con los filtros</h3>
      <p>Hay ${state.ads.size} anuncios cargados. Probá quitar algún filtro o cargá más resultados.</p>
      <p style="margin-top:14px"><button class="btn" data-action="reset-filters">Restablecer filtros</button></p>`;
  }

  function getCard(ad) {
    let el = cardCache.get(ad.id);
    if (!el) {
      el = BAP.renderCard(ad, { mode: 'live', savedFolder: (state.saved[ad.id] || {}).folder || null, selected: state.selected.has(ad.id) });
      cardCache.set(ad.id, el);
    }
    el.classList.toggle('selected', state.selected.has(ad.id));
    return el;
  }

  function renderGrid() {
    const list = state.view.slice(0, state.renderLimit);
    ui.empty.hidden = list.length > 0;
    if (!list.length) ui.empty.innerHTML = emptyHtml();
    const grid = ui.grid;
    const current = [...grid.children];
    const same = current.length === list.length && current.every((n, i) => n.dataset.id === list[i].id);
    if (same) {
      list.forEach((ad) => getCard(ad));
    } else {
      // Reutiliza nodos ya montados en su lugar para no cortar videos en reproducción.
      const wanted = new Set(list.map((a) => a.id));
      current.forEach((n) => !wanted.has(n.dataset.id) && n.remove());
      let ref = grid.firstElementChild;
      for (const ad of list) {
        const el = getCard(ad);
        if (el === ref) {
          ref = ref.nextElementSibling;
        } else {
          grid.insertBefore(el, ref);
        }
      }
    }
    updateLoadMore();
  }

  function refreshCardSaved(id) {
    const el = cardCache.get(id);
    const ad = state.ads.get(id);
    if (!el || !ad) return;
    const fresh = BAP.renderCard(ad, { mode: 'live', savedFolder: (state.saved[id] || {}).folder || null });
    el.querySelector('.split').replaceWith(fresh.querySelector('.split'));
  }

  // ---------- Eventos ----------

  function afterFilterChange() {
    state.renderLimit = PAGE_SIZE;
    persistPrefs();
    render();
    ui.overlay.scrollTo({ top: 0 });
  }

  function onChange(e) {
    const t = e.target;
    const key = t.dataset && t.dataset.filter;
    if (!key) return;
    if (key === 'maxDays') state.filters.maxDays = t.value === '' ? null : Math.max(0, Number(t.value));
    else if (key === 'minCopies') state.filters.minCopies = Math.max(1, Number(t.value) || 1);
    else state.filters[key] = t.value;
    afterFilterChange();
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset && t.dataset.role === 'note') return;
  }

  function adFromEvent(target) {
    const card = target.closest('.card');
    if (!card) return {};
    return { card, ad: state.ads.get(card.dataset.id) };
  }

  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (ui.menu && !e.target.closest('.menu')) closeMenu();
      return;
    }
    const action = btn.dataset.action;
    const value = btn.dataset.value;
    const f = state.filters;
    if (ui.menu && !btn.closest('.menu')) closeMenu();

    switch (action) {
      case 'open':
        return setOpen(true);
      case 'close':
        return setOpen(false);
      case 'open-saved':
        return chrome.runtime.sendMessage({ type: 'open-saved' });
      case 'toggle-adv':
        state.advOpen = !state.advOpen;
        ui.adv.hidden = !state.advOpen;
        if (state.advOpen) renderAdvanced();
        return updateToolbar();
      case 'dest':
        f.dest = f.dest === value && value !== 'all' ? 'all' : value;
        if (f.dest !== 'message' && f.dest !== 'all') f.channel = 'all';
        return afterFilterChange();
      case 'days':
        f.minDays = Number(value);
        ui.minDays.value = '';
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
        ui.search.value = '';
        return afterFilterChange();
      case 'show-more':
        state.renderLimit += PAGE_SIZE;
        return renderGrid();
      case 'load-more':
        return loadMore();
      case 'load-all':
        return loadAll();
      case 'stop-load':
        state.autoLoading = false;
        return updateLoadMore();
      case 'download-all':
        return downloadAds(state.view);
      case 'export':
        return exportAds(state.view, value);
      case 'select-all': {
        const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
        state.view.forEach((a) => (allSel ? state.selected.delete(a.id) : state.selected.add(a.id)));
        return render();
      }
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
    }

    // Acciones de tarjeta
    const { card, ad } = adFromEvent(btn);
    if (!ad) return;
    if (BAP.handleMediaAction(action, card, ad)) return;
    switch (action) {
      case 'select':
        if (state.selected.has(ad.id)) state.selected.delete(ad.id);
        else state.selected.add(ad.id);
        card.classList.toggle('selected', state.selected.has(ad.id));
        updateSelbar();
        updateToolbar();
        return;
      case 'save':
        if (state.saved[ad.id]) return unsave([ad.id]);
        return saveAds([ad]);
      case 'save-menu':
        return openFolderMenu(btn, ad, (folder) => saveAds([ad], folder));
      case 'download':
        return downloadAds([ad]);
      case 'more':
        return openMoreMenu(btn, ad);
    }
  }

  function selectedAds() {
    return [...state.selected].map((id) => state.ads.get(id)).filter(Boolean);
  }

  // ---------- Menús ----------

  function closeMenu() {
    if (ui && ui.menu) {
      ui.menu.remove();
      ui.menu = null;
    }
  }

  function placeMenu(menu, anchor) {
    ui.root.querySelector('.bap').appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    ui.menu = menu;
  }

  function openFolderMenu(anchor, ad, onPick) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const current = ad && state.saved[ad.id] ? state.saved[ad.id].folder : null;
    menu.innerHTML =
      `<div class="mh">Guardar en carpeta</div>` +
      state.folders
        .map((fo) => `<button class="mi ${fo === current ? 'on' : ''}" data-folder="${esc(fo)}">${icon(fo === current ? 'check' : 'folder', 15)}${esc(fo)}</button>`)
        .join('') +
      `<div class="sep"></div>
       <form data-role="newfolder"><input class="input" placeholder="Nueva carpeta…" maxlength="40"><button class="btn btn-primary" type="submit">${icon('folderPlus', 14)}</button></form>` +
      (current ? `<div class="sep"></div><button class="mi danger" data-unsave="1">${icon('trash', 15)}Quitar de guardados</button>` : '');
    menu.addEventListener('click', (e) => {
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
    menu.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = e.target.querySelector('input').value.trim();
      if (!name) return;
      closeMenu();
      onPick(name);
    });
    placeMenu(menu, anchor);
  }

  function openMoreMenu(anchor, ad) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const pageAds = ad.pageId
      ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${encodeURIComponent(ad.pageId)}&search_type=page&media_type=all`
      : '';
    const items = [
      ['copy-link', 'link', 'Copiar link del anuncio'],
      ['copy-id', 'copy', 'Copiar ID'],
      ad.body ? ['copy-text', 'copy', 'Copiar texto del anuncio'] : null,
      'sep',
      ['open-ad', 'external', 'Abrir anuncio en pestaña nueva'],
      pageAds ? ['page-ads', 'library', 'Ver todos los anuncios de esta página'] : null,
      ad.pageUrl ? ['open-page', 'user', 'Abrir página del anunciante'] : null,
      ad.linkUrl ? ['open-dest', 'globe', 'Abrir destino del botón'] : null,
    ].filter(Boolean);
    menu.innerHTML =
      `<div class="mh">${esc(ad.ctaType || 'Sin CTA')}${ad.channel ? ' · ' + esc(ad.channel) : ''}</div>` +
      items.map((it) => (it === 'sep' ? '<div class="sep"></div>' : `<button class="mi" data-m="${it[0]}">${icon(it[1], 15)}${esc(it[2])}</button>`)).join('');
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      closeMenu();
      const open = (u) => window.open(u, '_blank', 'noopener');
      switch (b.dataset.m) {
        case 'copy-link':
          return copy(ad.url, 'Link copiado');
        case 'copy-id':
          return copy(ad.id, 'ID copiado');
        case 'copy-text':
          return copy(ad.body, 'Texto copiado');
        case 'open-ad':
          return open(ad.url);
        case 'page-ads':
          return open(pageAds);
        case 'open-page':
          return open(ad.pageUrl);
        case 'open-dest':
          return open(ad.linkUrl);
      }
    });
    placeMenu(menu, anchor);
  }

  // ---------- Toasts ----------
  function toast(msg, isErr) {
    if (!ui) return;
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.setAttribute('role', 'status');
    t.innerHTML = `${icon(isErr ? 'x' : 'check', 15)}<span>${esc(msg)}</span>`;
    ui.toasts.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ======================= Inicio =======================
  async function init() {
    await loadStorage();
    const start = () => buildUI();
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-panel' && ui) setOpen(!state.open);
  });

  init();
})();
