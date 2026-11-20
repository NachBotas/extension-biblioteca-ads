/*
 * Transcripción local con Whisper (Transformers.js), dentro de un documento offscreen.
 * Corre en el procesador con un solo núcleo (WebAssembly) para no trabar la compu.
 * El modelo se baja una sola vez de Hugging Face y queda en la caché del navegador.
 */
import { pipeline, env } from '../../vendor/transformers/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
env.backends.onnx.wasm.numThreads = 1; // sin aislamiento entre orígenes no hay hilos; además consume menos

const MODELS = { base: 'onnx-community/whisper-base', small: 'onnx-community/whisper-small' };
const LANGS = { es: 'spanish', en: 'english', pt: 'portuguese' };

let current = null; // { id, device, pipe }

async function getPipe(modelKey, report) {
  const id = MODELS[modelKey] || MODELS.small;
  if (current && current.id === id) return current;
  if (current) {
    try {
      await current.pipe.dispose();
    } catch (e) {
      /* ignore */
    }
    current = null;
  }
  const files = {};
  const pipe = await pipeline('automatic-speech-recognition', id, {
    device: 'wasm',
    dtype: 'q8', // modelo comprimido: descarga más chica y menos memoria
    progress_callback: (e) => {
      if (e.status !== 'progress' || !e.total) return;
      files[e.file] = { loaded: e.loaded, total: e.total };
      const all = Object.values(files);
      report({ stage: 'model', loaded: all.reduce((s, f) => s + f.loaded, 0), total: all.reduce((s, f) => s + f.total, 0) });
    },
  });
  current = { id, device: 'wasm', pipe };
  return current;
}

async function decodeAudio(buf) {
  const ctx = new AudioContext({ sampleRate: 16000 }); // Whisper usa audio a 16 kHz
  try {
    const audio = await ctx.decodeAudioData(buf);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / audio.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close();
  }
}

async function run({ url, model, language, jobId }) {
  const report = (p) => chrome.runtime.sendMessage(Object.assign({ type: 'offscreen-progress', jobId }, p)).catch(() => {});
  report({ stage: 'video' });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo bajar el video (HTTP ${res.status}). Si el anuncio es viejo, el link venció: recargá la búsqueda.`);
  const buf = await res.arrayBuffer();
  report({ stage: 'audio' });
  let pcm;
  try {
    pcm = await decodeAudio(buf);
  } catch (e) {
    throw new Error('No se pudo leer el audio de este video.');
  }
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 64) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak < 0.003) return { ok: true, text: '', note: 'El video no tiene voz (o no tiene audio).' };

  const { pipe, device } = await getPipe(model, report);
  report({ stage: 'transcribe', device });
  // Señal de vida periódica mientras transcribe (mantiene activo al service worker).
  const beat = setInterval(() => report({ stage: 'transcribe', device }), 10000);
  let out;
  try {
    out = await pipe(pcm, {
      task: 'transcribe',
      language: language && language !== 'auto' ? LANGS[language] || language : undefined,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
  } finally {
    clearInterval(beat);
  }
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').replace(/\s+/g, ' ').trim();
  return { ok: true, text, device };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'transcribe') {
    run(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
  }
});
