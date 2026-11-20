/*
 * Lógica compartida: normalización de anuncios, clasificación por destino (perfil / mensaje / web…),
 * filtros, orden, formato y los íconos SVG. La usan el content script y la página de Guardados.
 */
(function (g) {
  const BAP = g.BAP || (g.BAP = {});
  const DAY = 86400000;

  BAP.APP_NAME = 'Biblioteca Ads Pro';
  BAP.LIBRARY_URL = 'https://www.facebook.com/ads/library/';
  BAP.adUrl = (id) => `https://www.facebook.com/ads/library/?id=${id}`;

  // ---------------- Destinos (lo que hace el botón del anuncio) ----------------
  BAP.DESTINATIONS = [
    { key: 'profile', label: 'Visitar perfil', icon: 'user', tone: 'pink' },
    { key: 'message', label: 'Mensaje', icon: 'message', tone: 'green' },
    { key: 'website', label: 'Sitio web', icon: 'globe', tone: 'blue' },
    { key: 'call', label: 'Llamada', icon: 'phone', tone: 'amber' },
    { key: 'app', label: 'App', icon: 'smartphone', tone: 'violet' },
    { key: 'other', label: 'Sin botón / otro', icon: 'dots', tone: 'gray' },
  ];
  BAP.destByKey = Object.fromEntries(BAP.DESTINATIONS.map((d) => [d.key, d]));

  const PLATFORM_LABELS = {
    FACEBOOK: 'Facebook',
    INSTAGRAM: 'Instagram',
    MESSENGER: 'Messenger',
    AUDIENCE_NETWORK: 'Audience Network',
    THREADS: 'Threads',
    WHATSAPP: 'WhatsApp',
  };
  BAP.PLATFORM_LABELS = PLATFORM_LABELS;

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  // Facebook a veces envuelve el destino en l.facebook.com/l.php?u=...
  function unwrapLink(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      if (/(^|\.)facebook\.com$/.test(u.hostname) && u.pathname === '/l.php' && u.searchParams.get('u')) {
        return u.searchParams.get('u');
      }
    } catch (e) {
      /* ignore */
    }
    return url;
  }
  BAP.unwrapLink = unwrapLink;

  /**
   * Clasifica el anuncio según a dónde lleva el botón.
   * La Biblioteca no publica el "objetivo de campaña", así que lo inferimos del tipo de CTA,
   * el texto del botón y la URL de destino.
   */
  BAP.classify = function (ctaType, ctaText, linkUrl, caption) {
    const t = String(ctaType || '').toUpperCase();
    const txt = String(ctaText || '').toLowerCase();
    const link = String(linkUrl || '').toLowerCase();
    const cap = String(caption || '').toLowerCase();
    const host = hostOf(link);

    // --- Mensajes ---
    if (/WHATSAPP/.test(t) || /(^|\.)wa\.me$|whatsapp\.com$/.test(host) || /whatsapp/.test(txt)) {
      return { dest: 'message', channel: 'WhatsApp' };
    }
    if (/INSTAGRAM_MESSAGE|IG_MESSAGE|INSTAGRAM_DIRECT/.test(t) || host === 'ig.me' || /instagram\.com\/direct/.test(link)) {
      return { dest: 'message', channel: 'Instagram Direct' };
    }
    if (/MESSAGE|MESSENGER/.test(t) || host === 'm.me' || /messenger\.com$/.test(host) || /mensaje|message|escr[ií]b/.test(txt)) {
      return { dest: 'message', channel: 'Messenger' };
    }

    // --- Visitar perfil ---
    if (/PROFILE/.test(t) || /perfil|profile/.test(txt)) {
      return { dest: 'profile', channel: /instagram/.test((t + link + cap + txt).toLowerCase()) ? 'Instagram' : 'Facebook' };
    }
    if (/instagram\.com$/.test(host)) {
      const path = (() => {
        try {
          return new URL(linkUrl).pathname.split('/').filter(Boolean);
        } catch (e) {
          return [];
        }
      })();
      if (path.length <= 1 || !/^(p|reel|reels|tv|explore|stories|direct)$/.test(path[0])) {
        return { dest: 'profile', channel: 'Instagram' };
      }
    }
    if (t === 'LIKE_PAGE' || t === 'FOLLOW_PAGE' || t === 'FOLLOW') {
      return { dest: 'profile', channel: 'Facebook' };
    }

    // --- Llamada ---
    if (/CALL/.test(t) || link.startsWith('tel:') || /llam/.test(txt)) {
      return { dest: 'call', channel: 'Teléfono' };
    }

    // --- App ---
    if (/INSTALL|USE_APP|PLAY_GAME|USE_MOBILE_APP/.test(t) || /play\.google\.com|apps\.apple\.com|itunes\.apple\.com/.test(link)) {
      return { dest: 'app', channel: /apple/.test(link) ? 'App Store' : 'Google Play' };
    }

    // --- Sitio web ---
    if (host && !/(^|\.)(facebook|fb)\.(com|me)$/.test(host)) {
      return { dest: 'website', channel: host };
    }
    if (/(^|\.)facebook\.com$/.test(host) && t && t !== 'NO_BUTTON') {
      return { dest: 'profile', channel: 'Facebook' };
    }

    if (!t || t === 'NO_BUTTON') return { dest: 'other', channel: 'Sin botón' };
    return { dest: 'other', channel: t };
  };

  // ---------------- Normalización ----------------

  function toMs(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }

  function textOf(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v.text === 'string') return v.text;
    if (v.markup && typeof v.markup.__html === 'string') return v.markup.__html.replace(/<[^>]+>/g, '');
    return '';
  }

  function collectMedia(s) {
    const out = [];
    const seen = new Set();
    const addVideo = (o) => {
      const url = o.video_hd_url || o.video_sd_url;
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({
        type: 'video',
        url,
        hd: o.video_hd_url || null,
        sd: o.video_sd_url || null,
        poster: o.video_preview_image_url || o.resized_image_url || o.original_image_url || null,
      });
    };
    const addImage = (o) => {
      const url = o.original_image_url || o.resized_image_url || o.watermarked_resized_image_url;
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({ type: 'image', url, poster: o.resized_image_url || url });
    };
    const each = (arr, fn) => Array.isArray(arr) && arr.forEach((x) => x && typeof x === 'object' && fn(x));

    each(s.videos, addVideo);
    each(s.cards, (c) => (c.video_hd_url || c.video_sd_url ? addVideo(c) : addImage(c)));
    each(s.images, addImage);
    each(s.extra_videos, addVideo);
    each(s.extra_images, addImage);
    return out;
  }

  BAP.normalize = function (raw, now = Date.now()) {
    const s = raw.snapshot || {};
    const cards = Array.isArray(s.cards) ? s.cards : [];
    const first = cards[0] || {};
    const id = String(raw.ad_archive_id);

    const ctaType = s.cta_type || first.cta_type || '';
    const ctaText = s.cta_text || first.cta_text || '';
    const linkUrl = unwrapLink(s.link_url || first.link_url || '');
    const caption = s.caption || first.caption || '';
    const cls = BAP.classify(ctaType, ctaText, linkUrl, caption);

    const media = collectMedia(s);
    const start = toMs(raw.start_date != null ? raw.start_date : s.start_date);
    const end = toMs(raw.end_date);
    let isActive = raw.is_active;
    if (typeof isActive !== 'boolean') isActive = end ? end > now : true;
    const ref = isActive ? now : end || now;
    const days = start ? Math.max(0, Math.floor((ref - start) / DAY)) : null;

    const hasVideo = media.some((m) => m.type === 'video');
    const fmt = String(s.display_format || '').toUpperCase();
    let mediaType = hasVideo ? 'video' : 'image';
    if (media.length > 1 || fmt === 'CAROUSEL' || fmt === 'DCO' || fmt === 'DPA') mediaType = media.length > 1 ? 'carousel' : mediaType;
    if (!media.length) mediaType = 'text';

    const pageId = String(raw.page_id || s.page_id || '');
    const platforms = (Array.isArray(raw.publisher_platform) ? raw.publisher_platform : []).map((p) => String(p).toUpperCase());

    let reach = null;
    if (typeof raw.reach_estimate === 'number') reach = raw.reach_estimate;
    else if (raw.reach_estimate && typeof raw.reach_estimate === 'object') reach = raw.reach_estimate.upper_bound || raw.reach_estimate.lower_bound || null;
    else if (typeof raw.eu_total_reach === 'number') reach = raw.eu_total_reach;

    return {
      id,
      url: BAP.adUrl(id),
      pageId,
      pageName: s.page_name || raw.page_name || 'Anunciante',
      pageUrl: s.page_profile_uri || (pageId ? `https://www.facebook.com/${pageId}` : ''),
      pageAvatar: s.page_profile_picture_url || '',
      body: textOf(s.body) || textOf(first.body),
      title: s.title || first.title || '',
      caption,
      linkUrl,
      ctaType: String(ctaType || ''),
      ctaText: String(ctaText || ''),
      dest: cls.dest,
      channel: cls.channel,
      media,
      mediaType,
      displayFormat: fmt,
      platforms,
      start,
      end,
      isActive,
      days,
      copies: Number(raw.collation_count) || 1,
      reach,
      firstSeen: now,
    };
  };

  // ---------------- Filtros y orden ----------------

  BAP.defaultFilters = () => ({
    dest: 'all',
    channel: 'all',
    cta: 'all',
    media: 'all',
    platform: 'all',
    status: 'all',
    minDays: 0,
    maxDays: null,
    minCopies: 1,
    text: '',
    savedOnly: false,
  });

  BAP.matches = function (ad, f, savedMap) {
    if (f.dest !== 'all' && ad.dest !== f.dest) return false;
    if (f.channel !== 'all' && ad.channel !== f.channel) return false;
    if (f.cta !== 'all' && (ad.ctaText || '(sin botón)') !== f.cta) return false;
    if (f.media !== 'all' && ad.mediaType !== f.media) return false;
    if (f.platform !== 'all' && !(ad.platforms || []).includes(f.platform)) return false;
    if (f.status === 'active' && !ad.isActive) return false;
    if (f.status === 'inactive' && ad.isActive) return false;
    if (f.minDays && (ad.days == null || ad.days < f.minDays)) return false;
    if (f.maxDays != null && f.maxDays !== '' && ad.days != null && ad.days > Number(f.maxDays)) return false;
    if (f.minCopies > 1 && (ad.copies || 1) < f.minCopies) return false;
    if (f.savedOnly && !(savedMap && savedMap[ad.id])) return false;
    if (f.text) {
      const hay = `${ad.pageName} ${ad.body} ${ad.title} ${ad.caption} ${ad.ctaText} ${ad.linkUrl} ${ad.id}`.toLowerCase();
      const terms = f.text.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  };

  BAP.SORTS = [
    { key: 'default', label: 'Orden de Facebook' },
    { key: 'days_desc', label: 'Más días activo' },
    { key: 'days_asc', label: 'Menos días activo' },
    { key: 'newest', label: 'Más recientes' },
    { key: 'oldest', label: 'Más antiguos' },
    { key: 'copies', label: 'Más versiones' },
    { key: 'reach', label: 'Mayor alcance (UE)' },
  ];

  BAP.sortAds = function (list, key) {
    const arr = list.slice();
    const n = (v, d = -1) => (v == null ? d : v);
    switch (key) {
      case 'days_desc':
        return arr.sort((a, b) => n(b.days) - n(a.days));
      case 'days_asc':
        return arr.sort((a, b) => n(a.days, 1e9) - n(b.days, 1e9));
      case 'newest':
        return arr.sort((a, b) => n(b.start, 0) - n(a.start, 0));
      case 'oldest':
        return arr.sort((a, b) => n(a.start, 1e15) - n(b.start, 1e15));
      case 'copies':
        return arr.sort((a, b) => (b.copies || 1) - (a.copies || 1) || n(b.days) - n(a.days));
      case 'reach':
        return arr.sort((a, b) => n(b.reach) - n(a.reach));
      default:
        return arr;
    }
  };

  // ---------------- Formato ----------------

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  BAP.fmtDate = function (ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };
  BAP.isoDate = function (ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  BAP.fmtDays = function (days) {
    if (days == null) return '—';
    if (days === 0) return 'Hoy';
    return days === 1 ? '1 día' : `${days} días`;
  };
  BAP.daysTone = function (days) {
    if (days == null) return 'gray';
    if (days >= 60) return 'hot';
    if (days >= 30) return 'warm';
    if (days >= 7) return 'mild';
    return 'new';
  };
  BAP.fmtNum = function (n) {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
  };
  BAP.hostOf = hostOf;

  BAP.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  };

  BAP.sanitizeFilename = function (s, max = 60) {
    return (
      String(s || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\- .]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max) || 'anuncio'
    );
  };

  BAP.extOf = function (url, type) {
    const m = /\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i.exec(String(url || '').split('#')[0]);
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    return type === 'video' ? 'mp4' : 'jpg';
  };

  /** Arma la lista de archivos a descargar de un anuncio. */
  BAP.downloadItems = function (ad) {
    const base = `${BAP.sanitizeFilename(BAP.APP_NAME)}/${BAP.sanitizeFilename(ad.pageName)}`;
    const media = ad.media || [];
    return media.map((m, i) => {
      const url = m.type === 'video' ? m.hd || m.sd || m.url : m.url;
      const suffix = media.length > 1 ? `_${i + 1}` : '';
      return { url, filename: `${base}/${ad.id}${suffix}.${BAP.extOf(url, m.type)}` };
    });
  };

  // ---------------- Íconos (trazos estilo "lucide", 24x24) ----------------
  const P = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    bookmarkFill: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" fill="currentColor"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    sort: '<line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="11" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/><polyline points="15 15 18 18 21 15"/><line x1="18" y1="6" x2="18" y2="18"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    checkCircle: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><polyline points="16.5 9 10.5 15 7.5 12" stroke="#fff" stroke-width="2.5"/>',
    play: '<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/>',
    dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
    message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="12" y1="11" x2="12" y2="19"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="16" y2="7"/><line x1="9" y1="11" x2="14" y2="11"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    facebook: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
    instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>',
    messenger: '<path d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.4 3.7 7.1V22l3.4-1.9c.9.3 1.9.4 2.9.4 5.5 0 10-4.1 10-9.2S17.5 2 12 2z"/><polyline points="7 13 10.5 9.5 13.5 12 17 9"/>',
    network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><line x1="12" y1="7.5" x2="5.8" y2="16.7"/><line x1="12" y1="7.5" x2="18.2" y2="16.7"/>',
    threads: '<path d="M16.5 11.5c-.3-3-2.2-4.5-4.6-4.5-2.6 0-4.4 1.8-4.4 1.8"/><path d="M12 22C6.5 22 3 18 3 12S6.5 2 12 2s8.5 3.5 9 7"/><path d="M15.5 12.5c0 2-1.4 3.5-3.4 3.5-1.6 0-2.6-.9-2.6-2.2 0-1.6 1.6-2.4 3.8-2.4 3.3 0 6.2 1.3 6.2 4.6 0 3.3-3 6-7.5 6"/>',
    whatsapp: '<path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  };
  BAP.icon = function (name, size = 16, extra = '') {
    const body = P[name] || P.dots;
    return `<svg class="ic ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };
  BAP.platformIcon = function (p, size = 14) {
    const map = { FACEBOOK: 'facebook', INSTAGRAM: 'instagram', MESSENGER: 'messenger', AUDIENCE_NETWORK: 'network', THREADS: 'threads', WHATSAPP: 'whatsapp' };
    return `<span class="plat" title="${BAP.esc(PLATFORM_LABELS[p] || p)}">${BAP.icon(map[p] || 'globe', size)}</span>`;
  };

  // ---------------- Guardados (chrome.storage) ----------------
  BAP.STORAGE_KEYS = { saved: 'bap_saved', folders: 'bap_folders', prefs: 'bap_prefs' };

  BAP.toSaved = function (ad, folder) {
    const firstMedia = (ad.media || [])[0] || {};
    return {
      id: ad.id,
      url: ad.url,
      pageId: ad.pageId,
      pageName: ad.pageName,
      pageUrl: ad.pageUrl,
      pageAvatar: ad.pageAvatar,
      body: ad.body,
      title: ad.title,
      caption: ad.caption,
      linkUrl: ad.linkUrl,
      ctaType: ad.ctaType,
      ctaText: ad.ctaText,
      dest: ad.dest,
      channel: ad.channel,
      mediaType: ad.mediaType,
      media: (ad.media || []).slice(0, 20),
      platforms: ad.platforms,
      start: ad.start,
      end: ad.end,
      isActive: ad.isActive,
      days: ad.days,
      copies: ad.copies,
      reach: ad.reach,
      thumb: firstMedia.poster || firstMedia.url || '',
      thumbData: '',
      folder: folder || 'General',
      note: '',
      savedAt: Date.now(),
    };
  };

  BAP.storage = {
    async load() {
      const k = BAP.STORAGE_KEYS;
      const r = await chrome.storage.local.get([k.saved, k.folders, k.prefs]);
      const saved = r[k.saved] || {};
      let folders = r[k.folders] || ['General'];
      for (const s of Object.values(saved)) if (s.folder && !folders.includes(s.folder)) folders.push(s.folder);
      if (!folders.includes('General')) folders.unshift('General');
      return { saved, folders, prefs: r[k.prefs] || {} };
    },
    async saveAll(saved) {
      await chrome.storage.local.set({ [BAP.STORAGE_KEYS.saved]: saved });
    },
    async setFolders(folders) {
      await chrome.storage.local.set({ [BAP.STORAGE_KEYS.folders]: folders });
    },
    async setPrefs(prefs) {
      await chrome.storage.local.set({ [BAP.STORAGE_KEYS.prefs]: prefs });
    },
    // Las escrituras se hacen leyendo de nuevo para no pisar cambios hechos en otra pestaña.
    async upsert(records) {
      const k = BAP.STORAGE_KEYS.saved;
      const r = await chrome.storage.local.get(k);
      const saved = r[k] || {};
      for (const rec of records) saved[rec.id] = Object.assign({}, saved[rec.id] || {}, rec);
      await chrome.storage.local.set({ [k]: saved });
      return saved;
    },
    // Actualiza campos solo si el anuncio sigue guardado (evita "revivir" uno que se borró).
    async patch(id, fields) {
      const k = BAP.STORAGE_KEYS.saved;
      const r = await chrome.storage.local.get(k);
      const saved = r[k] || {};
      if (!saved[id]) return false;
      saved[id] = Object.assign({}, saved[id], fields);
      await chrome.storage.local.set({ [k]: saved });
      return true;
    },
    async remove(ids) {
      const k = BAP.STORAGE_KEYS.saved;
      const r = await chrome.storage.local.get(k);
      const saved = r[k] || {};
      for (const id of ids) delete saved[id];
      await chrome.storage.local.set({ [k]: saved });
      return saved;
    },
  };
})(typeof window !== 'undefined' ? window : self);
