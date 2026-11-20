/* Configuración de transcripción: formulario compartido (panel en la página y página de opciones). */
(function (g) {
  const BAP = g.BAP || (g.BAP = {});
  const { esc } = BAP;

  BAP.SETTINGS_KEY = 'bap_settings';
  BAP.TRANSCRIPTS_KEY = 'bap_transcripts';
  BAP.DEFAULT_SETTINGS = { provider: 'local', openaiKey: '', groqKey: '', language: 'es', localModel: 'small' };
  BAP.PROVIDER_NAMES = { groq: 'Groq', openai: 'OpenAI', local: 'esta compu (Whisper local)' };

  BAP.loadSettings = async function () {
    const r = await chrome.storage.local.get(BAP.SETTINGS_KEY);
    return { settings: Object.assign({}, BAP.DEFAULT_SETTINGS, r[BAP.SETTINGS_KEY] || {}), configured: !!r[BAP.SETTINGS_KEY] };
  };

  BAP.isTranscribeReady = function (st) {
    if (st.provider === 'local') return true;
    if (st.provider === 'groq') return !!(st.groqKey || '').trim();
    if (st.provider === 'openai') return !!(st.openaiKey || '').trim();
    return false;
  };

  BAP.settingsFormHtml = function (st, submitLabel = 'Guardar') {
    const opt = (v, title, sub) =>
      `<label class="opt ${st.provider === v ? 'on' : ''}"><input type="radio" name="provider" value="${v}" ${st.provider === v ? 'checked' : ''}><span><b>${title}</b><small>${sub}</small></span></label>`;
    return `
      <form class="set" data-role="settings">
        <div class="set-h">¿Cómo querés transcribir los videos?</div>
        <div class="opts">
          ${opt('groq', 'Groq', 'Gratis con límites diarios · muy rápido · necesita una clave')}
          ${opt('openai', 'OpenAI', 'Cobra muy poco por minuto de audio · rápido · necesita una clave')}
          ${opt('local', 'En esta compu', 'Gratis, sin claves y privado · más lento y usa más recursos mientras transcribe')}
        </div>
        <div class="set-sec" data-show="groq">
          <label class="field"><span>Clave de Groq</span><input class="input" type="password" name="groqKey" autocomplete="off" placeholder="gsk_…" value="${esc(st.groqKey)}"></label>
          <a class="set-link" href="https://console.groq.com/keys" target="_blank" rel="noopener">Crear una clave en Groq →</a>
        </div>
        <div class="set-sec" data-show="openai">
          <label class="field"><span>Clave de OpenAI</span><input class="input" type="password" name="openaiKey" autocomplete="off" placeholder="sk-…" value="${esc(st.openaiKey)}"></label>
          <a class="set-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Crear una clave en OpenAI →</a>
        </div>
        <div class="set-sec" data-show="local">
          <label class="field"><span>Modelo</span>
            <select class="select" name="localModel">
              <option value="small" ${st.localModel === 'small' ? 'selected' : ''}>Preciso (recomendado) · se baja una vez, ~240 MB</option>
              <option value="base" ${st.localModel === 'base' ? 'selected' : ''}>Liviano · ~75 MB, más rápido pero comete más errores en español</option>
            </select></label>
          <p class="set-hint">El modelo se baja una sola vez y queda guardado. Transcribe de a un video, con un solo núcleo del procesador para no trabar la compu: un anuncio de 1 minuto puede tardar uno o dos minutos. Al terminar se libera la memoria.</p>
        </div>
        <label class="field"><span>Idioma de los videos</span>
          <select class="select" name="language">
            <option value="es" ${st.language === 'es' ? 'selected' : ''}>Español</option>
            <option value="en" ${st.language === 'en' ? 'selected' : ''}>Inglés</option>
            <option value="pt" ${st.language === 'pt' ? 'selected' : ''}>Portugués</option>
            <option value="auto" ${st.language === 'auto' ? 'selected' : ''}>Detectar automáticamente</option>
          </select></label>
        <p class="set-hint">Las claves se guardan solo en esta compu y se usan únicamente para transcribir. Con Groq u OpenAI el video se envía a ese servicio.</p>
        <p class="set-err" data-role="err" hidden></p>
        <div class="set-actions"><button class="btn btn-primary btn-lg" type="submit">${esc(submitLabel)}</button></div>
      </form>`;
  };

  /** Conecta el formulario. onSaved(settings) se llama al guardar. */
  BAP.bindSettingsForm = function (form, onSaved) {
    const sync = () => {
      const prov = form.querySelector('input[name="provider"]:checked').value;
      form.querySelectorAll('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== prov));
      form.querySelectorAll('.opt').forEach((el) => el.classList.toggle('on', el.querySelector('input').checked));
    };
    form.addEventListener('change', sync);
    sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const st = Object.assign({}, BAP.DEFAULT_SETTINGS, (await chrome.storage.local.get(BAP.SETTINGS_KEY))[BAP.SETTINGS_KEY] || {}, {
        provider: fd.get('provider'),
        groqKey: String(fd.get('groqKey') || '').trim(),
        openaiKey: String(fd.get('openaiKey') || '').trim(),
        localModel: fd.get('localModel'),
        language: fd.get('language'),
      });
      const err = form.querySelector('[data-role="err"]');
      if (!BAP.isTranscribeReady(st)) {
        err.hidden = false;
        err.textContent = `Pegá tu clave de ${st.provider === 'groq' ? 'Groq' : 'OpenAI'} o elegí “En esta compu”.`;
        return;
      }
      err.hidden = true;
      await chrome.storage.local.set({ [BAP.SETTINGS_KEY]: st });
      onSaved && onSaved(st);
    });
  };
})(typeof window !== 'undefined' ? window : self);
