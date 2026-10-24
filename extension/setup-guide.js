export function initializeGasGuide({showSettings, notify}) {
  const guide = document.getElementById('gasSetupGuide');
  for (const button of document.querySelectorAll('[data-open-gas-setup]')) {
    button.addEventListener('click', () => {
      showSettings();
      guide.open = true;
      guide.scrollIntoView({block:'start', behavior:'smooth'});
      guide.querySelector('summary').focus({preventScroll:true});
    });
  }
  document.getElementById('backToSyncSettings').addEventListener('click', () => {
    const endpoint = document.getElementById('syncEndpoint');
    endpoint.scrollIntoView({block:'center', behavior:'smooth'});
    endpoint.focus({preventScroll:true});
  });
  for (const button of document.querySelectorAll('[data-copy-gas]')) {
    button.addEventListener('click', async () => {
      const filename = button.dataset.copyGas;
      if (!['Code.gs', 'Protocol.gs'].includes(filename)) return;
      button.disabled = true;
      try {
        const response = await fetch(new URL('setup/' + filename, import.meta.url));
        if (!response.ok) throw new Error('read failed');
        await navigator.clipboard.writeText(await response.text());
        notify(filename + ' をコピーしました。Apps Scriptの同名ファイルに貼り付けてください。');
      } catch {
        notify('コピーできませんでした。「ファイルを保存」で取得し、テキストエディターから貼り付けてください。');
      } finally { button.disabled = false; }
    });
  }
}
