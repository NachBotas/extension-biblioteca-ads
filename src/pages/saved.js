/* Página de anuncios guardados: carpetas, búsqueda, notas, descarga y exportación. */
(function () {
  const BAP = window.BAP;
  const { icon, esc } = BAP;
  const $ = (id) => document.getElementById(id);

  const SORTS = [
    ['savedAt', 'Recién guardados'],
    ['days_desc', 'Más días'],
    ['newest', 'Más recientes'],
    ['oldest', 'Más antiguos'],
    ['copies', 'Más versiones'],
  ];

  const state = { saved: {}, folders: ['General'], folder: '__all', dest: 'all', text: '', sort: 'savedAt', selected: new Set(), view: [] };
  let menuEl = null;

  // Íconos estáticos
  $('logo').innerHTML = icon('library', 17);
  $('goLibrary').innerHTML = `${icon('external', 14)}Abrir Biblioteca de anuncios`;
  $('newFolder').innerHTML = icon('folderPlus', 17);
  $('backup').innerHTML = `${icon('download', 15)}Copia de seguridad (JSON)`;
  $('restoreLbl').insertAdjacentHTML('afterbegin', `${icon('upload', 15)}Restaurar copia`);
  $('exportXlsx').innerHTML = `${icon('sheet', 15)}Exportar Excel`;
  $('searchWrap').insertAdjacentHTML('afterbegin', icon('search', 15));

  async function load() {
    const r = await BAP.storage.load();
    state.saved = r.saved;
    state.folders = r.folders;
    render();
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch[BAP.STORAGE_KEYS.saved] || ch[BAP.STORAGE_KEYS.folders]) {
      const active = document.activeElement;
      // No re-renderizar mientras se escribe una nota.
      if (active && active.dataset && active.dataset.role === 'note') {
        pendingRender = true;
        BAP.storage.load().then((r) => {
          state.saved = r.saved;
          state.folders = r.folders;
        });
        return;
      }
      load();
    }
  });
  let pendingRender = false;

  // ---------- Render ----------
  function all() {
    return Object.values(state.saved);
  }

  function computeView() {
    const f = Object.assign(BAP.defaultFilters(), { dest: state.dest, text: state.text });
    let list = all().filter((a) => (state.folder === '__all' || a.folder === state.folder) && BAP.matches(a, f));
    if (state.sort === 'savedAt') list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    else list = BAP.sortAds(list, state.sort);
    state.view = list;
  }

  function render() {
    computeView();
    renderFolders();
    renderToolbar();
    renderGrid();
    renderSelbar();
  }

  function renderFolders() {
    const counts = {};
    for (const a of all()) counts[a.folder] = (counts[a.folder] || 0) + 1;
    const row = (key, name, ic, n, editable) =>
      `<button class="fo ${state.folder === key ? 'on' : ''}" data-folder="${esc(key)}">${icon(ic, 16)}<span class="nm">${esc(name)}</span><span class="n">${n || 0}</span>${
        editable ? `<span class="icon-btn fo-more" data-fmenu="${esc(key)}" title="Opciones" tabindex="0">${icon('dots', 15)}</span>` : ''
      }</button>`;
    $('folders').innerHTML =
      row('__all', 'Todos los guardados', 'bookmark', all().length, false) + state.folders.map((f) => row(f, f, 'folder', counts[f], f !== 'General')).join('');
  }

  function renderToolbar() {
    $('title').textContent = state.folder === '__all' ? 'Todos los guardados' : state.folder;
    $('countPill').textContent = `${state.view.length} anuncio${state.view.length === 1 ? '' : 's'}`;
    const base = all().filter((a) => (state.folder === '__all' || a.folder === state.folder) && BAP.matches(a, Object.assign(BAP.defaultFilters(), { text: state.text })));
    const counts = { all: base.length };
    for (const a of base) counts[a.dest] = (counts[a.dest] || 0) + 1;
    const chip = (key, label, ic) =>
      `<button class="chip ${state.dest === key ? 'on' : ''} ${!counts[key] && key !== 'all' ? 'zero' : ''}" data-dest="${key}">${ic ? icon(ic, 14) : ''}${esc(label)}<span class="count">${counts[key] || 0}</span></button>`;
    $('destRow').innerHTML = chip('all', 'Todos', 'grid') + BAP.DESTINATIONS.map((d) => chip(d.key, d.label, d.icon)).join('');
    $('sortSeg').innerHTML =
      `<span class="seg-label">${icon('sort', 13)}Ordenar por</span>` + SORTS.map(([k, l]) => `<button class="${state.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('');
    const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
    $('selectAll').textContent = allSel ? 'Quitar selección' : 'Seleccionar todos';
  }

  function renderGrid() {
    const grid = $('grid');
    grid.innerHTML = '';
    const empty = $('empty');
    empty.hidden = state.view.length > 0;
    if (!state.view.length) {
      empty.innerHTML = all().length
        ? `${icon('filter', 40)}<h3>No hay anuncios con estos filtros</h3><p>Probá con otra carpeta o quitá la búsqueda.</p>`
        : `${icon('bookmark', 40)}<h3>Todavía no guardaste anuncios</h3><p>En la Biblioteca de anuncios, abrí el panel de Biblioteca Ads Pro y tocá “Guardar” en los anuncios que quieras revisar después. Se guardan con su link, datos y miniatura.</p>`;
    }
    const frag = document.createDocumentFragment();
    for (const ad of state.view) {
      const el = BAP.renderCard(ad, { mode: 'saved', savedFolder: ad.folder, selected: state.selected.has(ad.id) });
      const meta = document.createElement('div');
      meta.className = 'saved-meta';
      meta.textContent = `Guardado el ${BAP.fmtDate(ad.savedAt)} · días contados hasta ese momento`;
      el.querySelector('.card-head').appendChild(meta);
      frag.appendChild(el);
    }
    grid.appendChild(frag);
  }

  function renderSelbar() {
    const n = state.selected.size;
    const bar = $('selbar');
    bar.hidden = !n;
    if (!n) return;
    bar.innerHTML = `<span>${n} seleccionado${n > 1 ? 's' : ''}</span>
      <button class="btn btn-primary" data-sel="download">${icon('download', 14)}Descargar</button>
      <button class="btn" data-sel="move">${icon('folder', 14)}Mover</button>
      <button class="btn" data-sel="export">${icon('sheet', 14)}Excel</button>
      <button class="btn" data-sel="copy">${icon('link', 14)}Copiar links</button>
      <button class="btn btn-danger" data-sel="delete">${icon('trash', 14)}Eliminar</button>
      <button class="btn" data-sel="clear" title="Quitar selección">${icon('x', 14)}</button>`;
  }

  // ---------- Acciones ----------
  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.setAttribute('role', 'status');
    t.innerHTML = `${icon(isErr ? 'x' : 'check', 15)}<span>${esc(msg)}</span>`;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  async function copy(text, msg) {
    await navigator.clipboard.writeText(text);
    toast(msg || 'Copiado');
  }

  async function download(ads) {
    const items = ads.flatMap((a) => BAP.downloadItems(a));
    if (!items.length) return toast('No hay archivos para descargar', true);
    if (items.length > 25 && !confirm(`Se van a descargar ${items.length} archivos. ¿Continuar?`)) return;
    toast(`Descargando ${items.length} archivo${items.length > 1 ? 's' : ''}…`);
    const r = await chrome.runtime.sendMessage({ type: 'download', items });
    if (r && r.failed) {
      toast(`${r.failed} archivo(s) no se pudieron bajar: el link de Facebook venció. Abrí el anuncio y descargalo de nuevo desde el panel.`, true);
    }
  }

  async function moveTo(ids, folder) {
    if (!state.folders.includes(folder)) {
      state.folders.push(folder);
      await BAP.storage.setFolders(state.folders);
    }
    const saved = Object.assign({}, state.saved);
    for (const id of ids) if (saved[id]) saved[id] = Object.assign({}, saved[id], { folder });
    await BAP.storage.saveAll(saved);
    toast(ids.length > 1 ? `${ids.length} anuncios movidos a “${folder}”` : `Movido a “${folder}”`);
  }

  async function remove(ids) {
    if (!confirm(ids.length > 1 ? `¿Eliminar ${ids.length} anuncios guardados?` : '¿Eliminar este anuncio de guardados?')) return;
    ids.forEach((id) => state.selected.delete(id));
    await BAP.storage.remove(ids);
    toast(ids.length > 1 ? `${ids.length} anuncios eliminados` : 'Anuncio eliminado');
  }

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function placeMenu(menu, anchor) {
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    let left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
    let top = r.bottom + 6;
    if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menuEl = menu;
  }

  function folderMenu(anchor, current, onPick) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML =
      `<div class="mh">Mover a carpeta</div>` +
      state.folders.map((f) => `<button class="mi ${f === current ? 'on' : ''}" data-pick="${esc(f)}">${icon(f === current ? 'check' : 'folder', 15)}${esc(f)}</button>`).join('') +
      `<div class="sep"></div><form><input class="input" placeholder="Nueva carpeta…" maxlength="40"><button class="btn btn-primary" type="submit">${icon('folderPlus', 14)}</button></form>`;
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) {
        closeMenu();
        onPick(b.dataset.pick);
      }
    });
    m.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = e.target.querySelector('input').value.trim();
      if (v) {
        closeMenu();
        onPick(v);
      }
    });
    placeMenu(m, anchor);
  }

  function moreMenu(anchor, ad) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const pageAds = ad.pageId
      ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${encodeURIComponent(ad.pageId)}&search_type=page&media_type=all`
      : '';
    m.innerHTML = `
      <button class="mi" data-m="copy">${icon('link', 15)}Copiar link del anuncio</button>
      ${ad.body ? `<button class="mi" data-m="text">${icon('copy', 15)}Copiar texto</button>` : ''}
      ${pageAds ? `<button class="mi" data-m="page">${icon('library', 15)}Ver todos los anuncios de esta página</button>` : ''}
      ${ad.linkUrl ? `<button class="mi" data-m="dest">${icon('globe', 15)}Abrir destino del botón</button>` : ''}
      <div class="sep"></div>
      <button class="mi danger" data-m="delete">${icon('trash', 15)}Eliminar de guardados</button>`;
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      closeMenu();
      ({
        copy: () => copy(ad.url, 'Link copiado'),
        text: () => copy(ad.body, 'Texto copiado'),
        page: () => window.open(pageAds, '_blank', 'noopener'),
        dest: () => window.open(ad.linkUrl, '_blank', 'noopener'),
        delete: () => remove([ad.id]),
      })[b.dataset.m]();
    });
    placeMenu(m, anchor);
  }

  function folderOptions(anchor, name) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `<button class="mi" data-f="rename">${icon('note', 15)}Renombrar</button><button class="mi danger" data-f="delete">${icon('trash', 15)}Eliminar carpeta</button>`;
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      closeMenu();
      if (b.dataset.f === 'rename') {
        const nn = (prompt('Nuevo nombre de la carpeta', name) || '').trim();
        if (!nn || nn === name) return;
        const folders = state.folders.map((f) => (f === name ? nn : f)).filter((f, i, arr) => arr.indexOf(f) === i);
        const saved = Object.assign({}, state.saved);
        for (const id in saved) if (saved[id].folder === name) saved[id] = Object.assign({}, saved[id], { folder: nn });
        await BAP.storage.setFolders(folders);
        await BAP.storage.saveAll(saved);
        if (state.folder === name) state.folder = nn;
      } else {
        const n = all().filter((a) => a.folder === name).length;
        if (!confirm(n ? `La carpeta “${name}” tiene ${n} anuncios. Se van a mover a “General”. ¿Eliminarla?` : `¿Eliminar la carpeta “${name}”?`)) return;
        const saved = Object.assign({}, state.saved);
        for (const id in saved) if (saved[id].folder === name) saved[id] = Object.assign({}, saved[id], { folder: 'General' });
        await BAP.storage.setFolders(state.folders.filter((f) => f !== name));
        await BAP.storage.saveAll(saved);
        if (state.folder === name) state.folder = '__all';
      }
    });
    placeMenu(m, anchor);
  }

  // ---------- Eventos ----------
  document.addEventListener('click', (e) => {
    if (menuEl && !e.target.closest('.menu')) closeMenu();

    const fm = e.target.closest('[data-fmenu]');
    if (fm) {
      e.stopPropagation();
      return folderOptions(fm, fm.dataset.fmenu);
    }
    const fo = e.target.closest('[data-folder]');
    if (fo) {
      state.folder = fo.dataset.folder;
      return render();
    }
    const dc = e.target.closest('[data-dest]');
    if (dc) {
      state.dest = state.dest === dc.dataset.dest && dc.dataset.dest !== 'all' ? 'all' : dc.dataset.dest;
      return render();
    }
    const sc = e.target.closest('[data-sort]');
    if (sc) {
      state.sort = sc.dataset.sort;
      return render();
    }
    const sel = e.target.closest('[data-sel]');
    if (sel) {
      const ads = [...state.selected].map((id) => state.saved[id]).filter(Boolean);
      const ids = ads.map((a) => a.id);
      switch (sel.dataset.sel) {
        case 'download':
          return download(ads);
        case 'move':
          return folderMenu(sel, null, (f) => moveTo(ids, f));
        case 'export':
          return BAP.exportAds(ads, 'xlsx', { saved: true, prefix: 'anuncios-guardados' });
        case 'copy':
          return copy(ads.map((a) => a.url).join('\n'), `${ads.length} links copiados`);
        case 'delete':
          return remove(ids);
        case 'clear':
          state.selected.clear();
          return render();
      }
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.card');
    const ad = card && state.saved[card.dataset.id];
    if (!ad) return;
    if (BAP.handleMediaAction(btn.dataset.action, card, ad, { thumb: ad.thumbData || '' })) return;
    switch (btn.dataset.action) {
      case 'select':
        if (state.selected.has(ad.id)) state.selected.delete(ad.id);
        else state.selected.add(ad.id);
        card.classList.toggle('selected', state.selected.has(ad.id));
        renderSelbar();
        return;
      case 'folder-menu':
        return folderMenu(btn, ad.folder, (f) => moveTo([ad.id], f));
      case 'download':
        return download([ad]);
      case 'more':
        return moreMenu(btn, ad);
    }
  });

  // Notas: se guardan solas al dejar de escribir.
  const noteTimers = {};
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.role !== 'note') return;
    const id = t.closest('.card').dataset.id;
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(() => BAP.storage.patch(id, { note: t.value }), 500);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.dataset && e.target.dataset.role === 'note' && pendingRender) {
      pendingRender = false;
      setTimeout(render, 600);
    }
  });

  let searchT;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      state.text = e.target.value.trim();
      render();
    }, 180);
  });
  $('selectAll').addEventListener('click', () => {
    const allSel = state.view.length > 0 && state.view.every((a) => state.selected.has(a.id));
    state.view.forEach((a) => (allSel ? state.selected.delete(a.id) : state.selected.add(a.id)));
    render();
  });
  $('exportXlsx').addEventListener('click', () => {
    if (!state.view.length) return toast('No hay anuncios para exportar', true);
    BAP.exportAds(state.view, 'xlsx', { saved: true, prefix: 'anuncios-guardados' });
  });
  $('exportCsv').addEventListener('click', () => {
    if (!state.view.length) return toast('No hay anuncios para exportar', true);
    BAP.exportAds(state.view, 'csv', { saved: true, prefix: 'anuncios-guardados' });
  });
  $('newFolder').addEventListener('click', async () => {
    const name = (prompt('Nombre de la nueva carpeta') || '').trim();
    if (!name || state.folders.includes(name)) return;
    await BAP.storage.setFolders([...state.folders, name]);
    state.folder = name;
  });
  $('backup').addEventListener('click', () => {
    const data = { app: BAP.APP_NAME, version: 1, exportedAt: new Date().toISOString(), folders: state.folders, saved: state.saved };
    BAP.downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `guardados-backup_${BAP.isoDate(Date.now())}.json`);
  });
  $('restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.saved !== 'object') throw new Error('formato');
      const saved = Object.assign({}, state.saved, data.saved);
      const folders = [...new Set([...state.folders, ...(data.folders || [])])];
      await BAP.storage.setFolders(folders);
      await BAP.storage.saveAll(saved);
      toast(`Copia restaurada · ${Object.keys(data.saved).length} anuncios`);
    } catch (err) {
      toast('El archivo no es una copia válida', true);
    }
  });
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

  load();
})();
