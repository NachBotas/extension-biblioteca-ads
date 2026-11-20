(async function () {
  const BAP = window.BAP;
  const $ = (id) => document.getElementById(id);
  $('logo').innerHTML = BAP.icon('library', 18);
  $('panel').innerHTML = `${BAP.icon('filter', 16)}Ir a los filtros en esta pestaña`;
  $('saved').innerHTML = `${BAP.icon('bookmark', 16)}Ver anuncios guardados`;
  $('lib').innerHTML = `${BAP.icon('external', 14)}Ir a la Biblioteca de anuncios`;
  $('opts').innerHTML = `${BAP.icon('note', 14)}Configurar transcripción de videos`;
  $('opts').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  const { saved } = await BAP.storage.load();
  $('n').textContent = Object.keys(saved).length;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onLibrary = tab && /^https:\/\/([a-z]+\.)?facebook\.com\/ads\/library/.test(tab.url || '');
  $('panel').disabled = !onLibrary;
  if (!onLibrary) $('panel').title = 'Abrí la Biblioteca de anuncios para usar el panel';

  $('panel').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
    } catch (e) {
      /* el content script todavía no cargó */
    }
    window.close();
  });
  $('saved').addEventListener('click', async () => {
    // En la Biblioteca se abre el panel lateral en la misma pestaña; en otro lado, la página de guardados.
    if (onLibrary) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'open-drawer' });
        return window.close();
      } catch (e) {
        /* sigue abajo */
      }
    }
    await chrome.runtime.sendMessage({ type: 'open-saved' });
    window.close();
  });
  $('lib').addEventListener('click', () => {
    chrome.tabs.create({ url: BAP.LIBRARY_URL + '?active_status=active&ad_type=all&country=ALL&media_type=all' });
    window.close();
  });
})();
