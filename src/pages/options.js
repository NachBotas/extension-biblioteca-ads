(async function () {
  const BAP = window.BAP;
  const { settings } = await BAP.loadSettings();
  const box = document.getElementById('box');
  box.innerHTML = BAP.settingsFormHtml(settings, 'Guardar');
  BAP.bindSettingsForm(box.querySelector('form'), () => {
    const ok = document.getElementById('ok');
    ok.hidden = false;
    setTimeout(() => (ok.hidden = true), 2500);
  });
})();
