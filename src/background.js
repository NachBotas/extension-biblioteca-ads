/*
 * Service worker: descargas (chrome.downloads), miniaturas durables para los guardados
 * y apertura de la página de Guardados.
 */
const SAVED_PAGE = 'src/pages/saved.html';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'download') {
    downloadAll(msg.items || []).then(sendResponse);
    return true;
  }
  if (msg.type === 'thumb') {
    makeThumb(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'open-saved') {
    openSaved();
    sendResponse({ ok: true });
  }
});

function openSaved() {
  return chrome.tabs.create({ url: chrome.runtime.getURL(SAVED_PAGE) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadAll(items) {
  let ok = 0;
  let failed = 0;
  for (const it of items) {
    if (!it || !it.url) continue;
    try {
      await chrome.downloads.download({ url: it.url, filename: it.filename, conflictAction: 'uniquify', saveAs: false });
      ok++;
    } catch (e) {
      // Si el nombre de archivo tiene algo que Chrome rechaza, reintentamos sin carpeta.
      try {
        await chrome.downloads.download({ url: it.url, conflictAction: 'uniquify', saveAs: false });
        ok++;
      } catch (e2) {
        failed++;
        console.warn('[BAP] descarga fallida', it.url, e2);
      }
    }
    if (items.length > 1) await sleep(250);
  }
  return { ok, failed };
}

// Descarga la imagen y la reduce a ~360px para guardarla como data URL (no vence como los links de Facebook).
async function makeThumb(url) {
  if (!url) throw new Error('sin url');
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  let out = blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 360 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
  } catch (e) {
    /* si no se puede redimensionar, guardamos el original */
  }
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${out.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

chrome.runtime.onInstalled.addListener(async () => {
  const k = 'bap_folders';
  const r = await chrome.storage.local.get(k);
  if (!r[k]) await chrome.storage.local.set({ [k]: ['General'] });
});
