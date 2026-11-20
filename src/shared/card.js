/*
 * Render de la tarjeta de anuncio (compartido entre el panel y la página de Guardados).
 * Las acciones se manejan por delegación usando data-action.
 */
(function (g) {
  const BAP = g.BAP || (g.BAP = {});
  const { esc, icon } = BAP;

  function avatarHtml(ad) {
    const initial = esc((ad.pageName || '?').trim().charAt(0).toUpperCase());
    if (ad.pageAvatar) {
      return `<img class="avatar" src="${esc(ad.pageAvatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${initial}">`;
    }
    return `<span class="avatar avatar-fallback">${initial}</span>`;
  }

  function downloadLabel(ad) {
    const n = (ad.media || []).length;
    if (!n) return 'Sin archivos';
    if (n > 1) return `Descargar (${n})`;
    return ad.media[0].type === 'video' ? 'Descargar video' : 'Descargar imagen';
  }

  BAP.mediaHtml = function (ad, index = 0, opts = {}) {
    const media = ad.media || [];
    const fmtIcon = { video: 'video', image: 'image', carousel: 'layers', text: 'note' }[ad.mediaType] || 'image';
    const fmtLabel = { video: 'Video', image: 'Imagen', carousel: 'Carrusel', text: 'Texto' }[ad.mediaType] || '';
    if (!media.length) {
      const fallback = opts.thumb ? `<img src="${esc(opts.thumb)}" alt="" loading="lazy">` : `<div class="noimg">${icon('image', 28)}<span>Sin vista previa</span></div>`;
      return `<div class="media">${fallback}</div>`;
    }
    const i = Math.max(0, Math.min(index, media.length - 1));
    const m = media[i];
    const poster = (i === 0 && opts.thumb) || m.poster || (m.type === 'image' ? m.url : '');
    let inner = poster
      ? `<img src="${esc(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb="${esc(opts.thumb || '')}">`
      : `<div class="noimg">${icon('video', 28)}<span>Video</span></div>`;
    if (m.type === 'video') inner += `<button class="play" data-action="play" title="Reproducir">${icon('play', 24)}</button>`;
    let nav = '';
    if (media.length > 1) {
      nav =
        `<span class="counter">${i + 1}/${media.length}</span>` +
        `<button class="nav prev" data-action="prev" title="Anterior">${icon('chevronLeft', 16)}</button>` +
        `<button class="nav next" data-action="next" title="Siguiente">${icon('chevronRight', 16)}</button>`;
    }
    return `<div class="media" data-index="${i}"><span class="fmt">${icon(fmtIcon, 12)}${fmtLabel}</span>${inner}${nav}</div>`;
  };

  /**
   * ctx: { mode: 'live'|'saved', savedFolder: string|null, selected: bool }
   */
  BAP.renderCard = function (ad, ctx = {}) {
    const el = document.createElement('article');
    el.className = 'card' + (ctx.selected ? ' selected' : '');
    el.dataset.id = ad.id;

    const dest = BAP.destByKey[ad.dest] || BAP.destByKey.other;
    const destTitle = ad.channel && ad.channel !== dest.label ? `${dest.label} · ${ad.channel}` : dest.label;
    const status = ad.isActive
      ? `<span class="badge badge-status">${icon('checkCircle', 14)}Activo</span>`
      : `<span class="badge badge-status off">${icon('clock', 13)}Inactivo</span>`;
    const days = `<span class="days ${BAP.daysTone(ad.days)}" title="Días en circulación">${icon(ad.days >= 30 ? 'flame' : 'clock', 14)}${BAP.fmtDays(ad.days)}</span>`;
    const destBadge = `<span class="dest tone-${dest.tone}" title="${esc(destTitle)}">${icon(dest.icon, 13)}<span class="lbl">${esc(destTitle)}</span></span>`;
    const plats = (ad.platforms || []).map((p) => BAP.platformIcon(p, 14)).join('');
    const since = ad.isActive
      ? `En circulación desde el <b>${BAP.fmtDate(ad.start)}</b>`
      : `${BAP.fmtDate(ad.start)} – ${BAP.fmtDate(ad.end)}`;

    const isSaved = !!ctx.savedFolder;
    let saveRow;
    if (ctx.mode === 'saved') {
      saveRow = `<div class="split">
          <button class="btn btn-soft" data-action="folder-menu" title="Mover de carpeta">${icon('folder', 15)}<span>${esc(ad.folder || 'General')}</span></button>
          <button class="btn btn-soft" data-action="folder-menu" title="Cambiar carpeta">${icon('chevronDown', 15)}</button>
        </div>`;
    } else {
      saveRow = `<div class="split">
          <button class="btn ${isSaved ? 'saved' : 'btn-soft'}" data-action="save" title="${isSaved ? 'Quitar de guardados' : 'Guardar para ver después'}">
            ${icon(isSaved ? 'bookmarkFill' : 'bookmark', 15)}<span>${isSaved ? `Guardado · ${esc(ctx.savedFolder)}` : 'Guardar'}</span>
          </button>
          <button class="btn ${isSaved ? 'saved' : 'btn-soft'}" data-action="save-menu" title="Elegir carpeta">${icon('chevronDown', 15)}</button>
        </div>`;
    }

    const hasMedia = (ad.media || []).length > 0;
    const body = ad.body || '';
    const longBody = body.length > 160 || (body.match(/\n/g) || []).length > 2;
    const capText = ad.caption || BAP.hostOf(ad.linkUrl) || '';
    const ctaHref = ad.linkUrl || ad.url;

    el.innerHTML = `
      <div class="card-head">
        <div class="card-top">
          <div class="left">${status}${destBadge}</div>
          <button class="icon-btn" data-action="more" title="Más opciones">${icon('dots', 18)}</button>
        </div>
        <div class="meta">Identificador de la biblioteca: ${esc(ad.id)}</div>
        <div class="meta">${since}</div>
        <div class="row-split">
          <div class="kpis">${days}${ad.copies > 1 ? `<span class="versions" title="Anuncios que usan este mismo creativo">${icon('layers', 13)}<b>${ad.copies}</b> versiones</span>` : ''}</div>
          <div class="plats">${plats}</div>
        </div>
      </div>
      <div class="card-actions">
        <div class="act-row">
          <button class="check" data-action="select" title="Seleccionar"><span class="box">${icon('check', 12)}</span></button>
          ${saveRow}
        </div>
        <button class="btn btn-primary btn-lg btn-block" data-action="download" ${hasMedia ? '' : 'disabled'}>${icon('download', 16)}${downloadLabel(ad)}</button>
        <a class="btn btn-details btn-block" href="${esc(ad.url)}" target="_blank" rel="noopener">Ver detalles del anuncio</a>
      </div>
      <div class="card-divider"></div>
      <div class="advertiser">
        ${avatarHtml(ad)}
        <div style="min-width:0">
          <a class="name" href="${esc(ad.pageUrl || ad.url)}" target="_blank" rel="noopener">${esc(ad.pageName)}</a>
          <div class="sub">Publicidad</div>
        </div>
      </div>
      ${body ? `<div class="body ${longBody ? 'clamp' : ''}">${esc(body)}</div>${longBody ? '<button class="more" data-action="toggle-body">Ver más</button>' : ''}` : '<div style="height:10px"></div>'}
      ${BAP.mediaHtml(ad, 0, ctx.mode === 'saved' ? { thumb: ad.thumbData || '' } : {})}
      <div class="card-foot">
        <div class="txt">
          <div class="cap">${esc(capText)}</div>
          <div class="ttl">${esc(ad.title || ad.pageName)}</div>
        </div>
        ${ad.ctaText ? `<a class="cta" href="${esc(ctaHref)}" target="_blank" rel="noopener" title="${esc(ad.ctaText)} · ${esc(ad.ctaType)}"><span>${esc(ad.ctaText)}</span></a>` : ''}
      </div>
      ${ctx.mode === 'saved' ? `<div style="padding:10px 12px 12px;border-top:1px solid var(--border)"><textarea class="input note" data-role="note" rows="2" placeholder="Agregar una nota…" style="width:100%;height:auto;padding:8px 10px;resize:vertical">${esc(ad.note || '')}</textarea></div>` : ''}
    `;

    // Fallback de imágenes rotas (los links de Facebook vencen con el tiempo)
    el.querySelectorAll('img').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          if (img.dataset.thumb && img.src !== img.dataset.thumb) {
            img.src = img.dataset.thumb;
            return;
          }
          if (img.classList.contains('avatar')) {
            const span = document.createElement('span');
            span.className = 'avatar avatar-fallback';
            span.textContent = img.dataset.fallback || '?';
            img.replaceWith(span);
          } else {
            const d = document.createElement('div');
            d.className = 'noimg';
            d.innerHTML = `${icon('image', 28)}<span>Vista previa vencida</span>`;
            img.replaceWith(d);
          }
        },
        { once: false }
      );
    });
    return el;
  };

  /** Maneja play / anterior / siguiente / ver más dentro de la tarjeta. Devuelve true si consumió el click. */
  BAP.handleMediaAction = function (action, cardEl, ad, opts = {}) {
    const mediaEl = cardEl.querySelector('.media');
    if (action === 'toggle-body') {
      const b = cardEl.querySelector('.body');
      const btn = cardEl.querySelector('[data-action="toggle-body"]');
      const clamped = b.classList.toggle('clamp');
      btn.textContent = clamped ? 'Ver más' : 'Ver menos';
      return true;
    }
    if (!mediaEl) return false;
    const idx = Number(mediaEl.dataset.index || 0);
    if (action === 'prev' || action === 'next') {
      const n = (ad.media || []).length;
      const next = (idx + (action === 'next' ? 1 : -1) + n) % n;
      const tmp = document.createElement('div');
      tmp.innerHTML = BAP.mediaHtml(ad, next, opts);
      mediaEl.replaceWith(tmp.firstElementChild);
      return true;
    }
    if (action === 'play') {
      const m = (ad.media || [])[idx];
      if (!m) return true;
      const v = document.createElement('video');
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.preload = 'auto';
      if (m.poster) v.poster = m.poster;
      v.src = m.sd || m.hd || m.url;
      v.addEventListener('error', () => {
        if (v.src !== (m.hd || '') && m.hd) v.src = m.hd;
      });
      const img = mediaEl.querySelector('img, .noimg');
      const play = mediaEl.querySelector('.play');
      if (img) img.replaceWith(v);
      else mediaEl.appendChild(v);
      if (play) play.remove();
      mediaEl.querySelector('.fmt')?.remove();
      return true;
    }
    return false;
  };
})(typeof window !== 'undefined' ? window : self);
