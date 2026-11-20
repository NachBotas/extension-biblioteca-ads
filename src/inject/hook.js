/*
 * Corre en el "MAIN world" de la página de la Biblioteca de anuncios, antes que los scripts de Facebook.
 * Intercepta las respuestas GraphQL (fetch + XHR) y los datos que vienen incrustados en el HTML inicial,
 * extrae los objetos de anuncio (los que tienen `ad_archive_id` + `snapshot`) y se los pasa al content script
 * mediante window.postMessage.
 */
(function () {
  if (window.__BAP_HOOKED__) return;
  window.__BAP_HOOKED__ = true;

  const TAG = 'BAP_HOOK';
  const buffer = []; // mensajes ya enviados, por si el content script se carga después
  const MAX_BUFFER = 400;

  function post(type, payload) {
    const msg = { source: TAG, type, payload };
    buffer.push(msg);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    try {
      window.postMessage(msg, location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // El content script avisa cuando está listo y le reenviamos todo lo acumulado.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'BAP_CS') return;
    if (ev.data.type === 'hello') {
      for (const msg of buffer) window.postMessage(msg, location.origin);
    } else if (ev.data.type === 'rescan') {
      // Hay tarjetas en pantalla sin datos: revisamos scripts de datos que llegaron tarde.
      scanScripts();
    }
  });

  // ---------- Extracción ----------

  function parseChunks(text) {
    if (typeof text !== 'string' || text.indexOf('ad_archive_id') === -1) return [];
    let t = text.trim();
    if (t.startsWith('for (;;);')) t = t.slice(9);
    const out = [];
    try {
      out.push(JSON.parse(t));
      return out;
    } catch (e) {
      /* puede venir en varias líneas (respuestas en streaming / @defer) */
    }
    for (const line of t.split('\n')) {
      const l = line.trim();
      if (!l || l.indexOf('ad_archive_id') === -1) continue;
      try {
        out.push(JSON.parse(l.startsWith('for (;;);') ? l.slice(9) : l));
      } catch (e) {
        /* ignore */
      }
    }
    return out;
  }

  function walk(root) {
    const ads = [];
    let meta = null;
    const seen = new Set();
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      if (node.ad_archive_id && node.snapshot && typeof node.snapshot === 'object') {
        ads.push(node);
        continue; // no hace falta seguir bajando dentro del anuncio
      }
      if (node.search_results_connection && typeof node.search_results_connection === 'object') {
        const c = node.search_results_connection;
        meta = {
          count: typeof c.count === 'number' ? c.count : null,
          hasNext: c.page_info ? !!c.page_info.has_next_page : null,
        };
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return { ads, meta };
  }

  function handleText(text, origin, info) {
    const chunks = parseChunks(text);
    if (!chunks.length) return;
    const ads = [];
    let meta = null;
    for (const c of chunks) {
      const r = walk(c);
      ads.push(...r.ads);
      if (r.meta) meta = r.meta;
    }
    // Primera página de una búsqueda (sin cursor): el content script decide si es una búsqueda nueva.
    if (meta && info && info.firstPage) post('reset', { name: info.name });
    if (ads.length || meta) post('ads', { ads, meta, origin });
  }

  // ---------- Info de la request (para detectar "nueva búsqueda") ----------

  function bodyToParams(body) {
    try {
      if (!body) return null;
      if (typeof body === 'string') return new URLSearchParams(body);
      if (body instanceof URLSearchParams) return body;
      if (body instanceof FormData) {
        const p = new URLSearchParams();
        for (const [k, v] of body.entries()) if (typeof v === 'string') p.append(k, v);
        return p;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function describeRequest(body) {
    const p = bodyToParams(body);
    if (!p) return { name: '', firstPage: false };
    const name = p.get('fb_api_req_friendly_name') || '';
    let firstPage = false;
    try {
      const raw = p.get('variables');
      if (raw) firstPage = !JSON.parse(raw).cursor;
    } catch (e) {
      /* ignore */
    }
    return { name, firstPage };
  }

  function shouldProcess(info) {
    // Facebook usa distintos nombres de consulta para los resultados (y cambian con el tiempo),
    // así que aceptamos todo salvo el detalle de un anuncio puntual ("Ver detalles").
    return !(info.name && /Detail|Preview|Report|Typeahead/i.test(info.name));
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const p = origFetch.apply(this, arguments);
      try {
        if (url && /\/(api\/)?graphql/.test(url)) {
          const info = describeRequest(init && init.body);
          if (shouldProcess(info)) {
            p.then((res) => {
              try {
                res
                  .clone()
                  .text()
                  .then((t) => handleText(t, 'fetch', info))
                  .catch(() => {});
              } catch (e) {
                /* ignore */
              }
            }).catch(() => {});
          }
        }
      } catch (e) {
        /* ignore */
      }
      return p;
    };
  }

  // ---------- XMLHttpRequest ----------
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__bapUrl = typeof url === 'string' ? url : url && url.href;
    return origOpen.apply(this, arguments);
  };
  XHR.send = function (body) {
    try {
      if (this.__bapUrl && /\/(api\/)?graphql/.test(this.__bapUrl)) {
        const info = describeRequest(body);
        if (shouldProcess(info)) {
          this.addEventListener('load', () => {
            try {
              if (this.responseType === '' || this.responseType === 'text') handleText(this.responseText, 'xhr', info);
            } catch (e) {
              /* ignore */
            }
          });
        }
      }
    } catch (e) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };

  // ---------- Datos incrustados en el HTML inicial ----------
  const scanned = new WeakSet();
  function scanScripts() {
    const scripts = document.querySelectorAll('script[type="application/json"], script[data-sjs]');
    for (const s of scripts) {
      if (scanned.has(s)) continue;
      scanned.add(s);
      const t = s.textContent;
      if (t && t.indexOf('ad_archive_id') !== -1) handleText(t, 'ssr');
    }
  }
  document.addEventListener('DOMContentLoaded', scanScripts);
  window.addEventListener('load', () => {
    scanScripts();
    setTimeout(scanScripts, 1500);
  });
})();
