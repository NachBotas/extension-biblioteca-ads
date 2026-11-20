/*
 * Service worker: descargas, miniaturas de guardados, página de guardados y transcripción de videos.
 */
const SAVED_PAGE = 'src/pages/saved.html';
const OFFSCREEN = 'src/offscreen/offscreen.html';
const K = { saved: 'bap_saved', transcripts: 'bap_transcripts', settings: 'bap_settings' };
const DEFAULT_SETTINGS = { provider: 'local', openaiKey: '', groqKey: '', language: 'es', localModel: 'small' };
const API_MAX_BYTES = 25 * 1024 * 1024;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || msg.target === 'offscreen') return;
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
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
  if (msg.type === 'transcribe') {
    const tabId = sender.tab && sender.tab.id;
    enqueue(() => transcribe(msg, tabId))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'offscreen-progress') {
    const job = jobs.get(msg.jobId);
    if (job) progress(job, msg);
  }
});

function openSaved() {
  return chrome.tabs.create({ url: chrome.runtime.getURL(SAVED_PAGE) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================= Descargas =======================

async function downloadAll(items) {
  let ok = 0;
  let failed = 0;
  for (const it of items) {
    if (!it || !it.url) continue;
    try {
      await chrome.downloads.download({ url: it.url, filename: it.filename, conflictAction: 'uniquify', saveAs: false });
      ok++;
    } catch (e) {
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

// ======================= Transcripción =======================

// Una transcripción por vez: no satura la compu ni el límite de la API.
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const jobs = new Map();
let jobSeq = 0;

// Mientras haya transcripciones en curso, mantenemos despierto el service worker
// (Chrome lo apaga a los 30 s sin actividad de la extensión).
let keepAliveTimer = null;
function keepAlive(on) {
  if (on && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  if (!on && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function progress(job, p) {
  if (!job.tabId) return;
  chrome.tabs.sendMessage(job.tabId, Object.assign({ type: 'transcribe-progress', id: job.id }, p)).catch(() => {});
}

async function getSettings() {
  const r = await chrome.storage.local.get(K.settings);
  return Object.assign({}, DEFAULT_SETTINGS, r[K.settings] || {});
}

class UserError extends Error {}

async function transcribe(msg, tabId) {
  const st = await getSettings();
  const provider = msg.provider || st.provider;
  const video = msg.video || {};
  const url = video.sd || video.hd || video.url;
  if (!url) throw new UserError('Este anuncio no tiene video.');
  const job = { id: String(msg.id), tabId, jobId: ++jobSeq };
  jobs.set(job.jobId, job);
  keepAlive(true);
  progress(job, { stage: 'start', provider });
  try {
    let result;
    if (provider === 'local') result = await localTranscribe(job, url, st);
    else result = await apiTranscribe(job, provider, video, st);
    const rec = {
      text: result.text || '',
      note: result.note || '',
      provider,
      model: result.model || '',
      language: st.language,
      at: Date.now(),
    };
    const r = await chrome.storage.local.get([K.transcripts, K.saved]);
    const all = r[K.transcripts] || {};
    all[job.id] = rec;
    const update = { [K.transcripts]: all };
    const saved = r[K.saved] || {};
    if (saved[job.id]) {
      saved[job.id] = Object.assign({}, saved[job.id], { transcript: rec.text });
      update[K.saved] = saved;
    }
    await chrome.storage.local.set(update);
    progress(job, { stage: 'done' });
    return { ok: true, id: job.id, ...rec };
  } catch (e) {
    const error = String((e && e.message) || e);
    progress(job, { stage: 'error', error });
    return { ok: false, id: job.id, error };
  } finally {
    jobs.delete(job.jobId);
    if (!jobs.size) keepAlive(false);
  }
}

// ---------- OpenAI / Groq (misma API, estilo OpenAI) ----------
const PROVIDERS = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', keyField: 'openaiKey' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', keyField: 'groqKey' },
};

async function fetchVideo(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new UserError(`No se pudo bajar el video (HTTP ${res.status}). Si el anuncio es viejo, el link venció: recargá la búsqueda.`);
  return res.blob();
}

async function apiTranscribe(job, provider, video, st) {
  const p = PROVIDERS[provider];
  if (!p) throw new UserError('Proveedor de transcripción desconocido.');
  const key = (st[p.keyField] || '').trim();
  if (!key) throw new UserError(`NO_KEY: Falta la clave de ${p.name}. Cargala en la configuración de transcripción.`);
  progress(job, { stage: 'video' });
  // Preferimos la versión SD: el audio es el mismo y pesa menos.
  let blob = await fetchVideo(video.sd || video.hd || video.url);
  if (blob.size > API_MAX_BYTES && video.sd && video.hd && video.sd !== video.hd) blob = await fetchVideo(video.sd);
  if (blob.size > API_MAX_BYTES) {
    throw new UserError(`El video pesa ${(blob.size / 1048576).toFixed(0)} MB y ${p.name} acepta hasta 25 MB. Probá con la transcripción local.`);
  }
  progress(job, { stage: 'transcribe', provider });
  const fd = new FormData();
  fd.append('file', new File([blob], 'video.mp4', { type: blob.type || 'video/mp4' }));
  fd.append('model', p.model);
  fd.append('response_format', 'json');
  if (st.language && st.language !== 'auto') fd.append('language', st.language);
  let res;
  try {
    res = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  } catch (e) {
    throw new UserError(`No se pudo conectar con ${p.name}. Revisá tu conexión.`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error)) || '';
    } catch (e) {
      /* ignore */
    }
    if (res.status === 401) throw new UserError(`NO_KEY: La clave de ${p.name} no es válida. Revisala en la configuración.`);
    if (res.status === 429) throw new UserError(`${p.name} rechazó el pedido por límite de uso o saldo (429). Esperá un rato o revisá tu cuenta.`);
    if (res.status === 413) throw new UserError(`El video es demasiado grande para ${p.name}. Probá con la transcripción local.`);
    throw new UserError(`${p.name} devolvió un error (${res.status})${detail ? ': ' + String(detail).slice(0, 200) : ''}.`);
  }
  const j = await res.json();
  return { text: String(j.text || '').trim(), model: p.model };
}

// ---------- Local (documento offscreen con Whisper) ----------
let offscreenTimer = null;
let creating = null;

async function ensureOffscreen() {
  clearTimeout(offscreenTimer);
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: OFFSCREEN, reasons: ['WORKERS'], justification: 'Transcribir el audio de los videos en esta computadora' })
      .finally(() => (creating = null));
  }
  await creating;
}

// Libera la memoria del modelo cuando no se usa.
function scheduleOffscreenClose() {
  clearTimeout(offscreenTimer);
  offscreenTimer = setTimeout(async () => {
    if (jobs.size) return scheduleOffscreenClose();
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch (e) {
      /* ignore */
    }
  }, 90000);
}

async function localTranscribe(job, url, st) {
  await ensureOffscreen();
  try {
    const r = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'transcribe',
      jobId: job.jobId,
      url,
      model: st.localModel,
      language: st.language,
    });
    if (!r) throw new UserError('El transcriptor local no respondió. Probá de nuevo.');
    if (!r.ok) throw new UserError(r.error || 'Error en la transcripción local.');
    return { text: r.text, note: r.note, model: `whisper-${st.localModel} (${r.device || 'local'})` };
  } finally {
    scheduleOffscreenClose();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get('bap_folders');
  if (!r.bap_folders) await chrome.storage.local.set({ bap_folders: ['General'] });
});
