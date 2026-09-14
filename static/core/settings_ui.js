// Application configuration is stored outside the installation directory.
export function setupSettings({ api, host }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#settingsDialog'), message = $('#settingsMessage');
  const fields = { defaultRate: $('#defaultRate') };
  let timer, busy = false;
  const say = text => { message.textContent = text; };
  const download = (data, filename) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function poll() {
    clearTimeout(timer);
    try {
      const status = await api('/api/ytdlp/update');
      $('#ytdlpUpdateMessage').textContent = status.message || '';
      busy = status.state === 'running';
      $('#updateYtdlp').disabled = busy; $('#resetYtdlp').disabled = busy;
      if (busy && dialog.open) timer = setTimeout(poll, 1500);
    } catch { $('#ytdlpUpdateMessage').textContent = '更新状況を取得できませんでした。設定を開き直してください。'; }
  }
  $('#settingsButton').addEventListener('click', async () => {
    dialog.showModal(); say('設定を読み込み中…');
    $('#settingsSave').disabled = true;
    try {
      const data = await api('/api/settings');
      for (const [key, field] of Object.entries(fields)) field.value = data.settings[key];
      $('#dataDirectory').textContent = data.dataDirectory;
      $('#quitApp').hidden = !data.canQuit;
      $('#settingsSave').disabled = false; say('');
      await poll();
    } catch { say('設定を読み込めませんでした。アプリを再起動してください。'); }
  });
  $('#closeSettings').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => clearTimeout(timer));
  $('#settingsForm').addEventListener('submit', async event => {
    event.preventDefault(); $('#settingsSave').disabled = true;
    try {
      const body = { defaultRate: Number(fields.defaultRate.value) };
      const result = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
      host.setBaseRate(result.settings.defaultRate);
      say('保存しました。現在の再生と、次回起動時の速度に反映しました。');
    } catch (error) { say(error.message); }
    finally { $('#settingsSave').disabled = false; }
  });
  $('#checkDependencies').addEventListener('click', async () => {
    $('#checkDependencies').disabled = true; $('#dependencyResult').textContent = '確認中…';
    try {
      const data = await api('/api/diagnostics');
      $('#dependencyResult').textContent = [
        `ClipNest ${data.appVersion} / ${data.platform} ${data.architecture}`,
        `yt-dlp：${data.ytDlp?.currentVersion || '利用できません'}`,
        `FFmpeg：${data.ffmpeg ? '検出' : '未検出（互換音声を使う場合に必要）'}`,
        ...(data.notes || []),
      ].join('\n');
    } catch (error) { $('#dependencyResult').textContent = error.message; }
    finally { $('#checkDependencies').disabled = false; }
  });
  $('#saveDiagnostics').addEventListener('click', async () => {
    try { download(await api('/api/diagnostics'), 'clipnest-diagnostics.json'); say('診断情報を保存しました。報告前に内容を確認してください。'); }
    catch (error) { say(error.message); }
  });
  $('#updateYtdlp').addEventListener('click', async () => {
    if (busy || !confirm('GitHubのyt-dlp公式安定版をダウンロードします。SHA-256を照合して保存し、アプリの再起動後に使用します。続けますか？')) return;
    $('#updateYtdlp').disabled = true;
    try { await api('/api/ytdlp/update', { method: 'POST', body: '{}' }); await poll(); }
    catch (error) { $('#ytdlpUpdateMessage').textContent = error.message; $('#updateYtdlp').disabled = false; }
  });
  $('#resetYtdlp').addEventListener('click', async () => {
    if (!confirm('管理用の更新版を無効にしますか？再起動後、同梱版（ソース版では元の環境）を使用します。')) return;
    try { $('#ytdlpUpdateMessage').textContent = (await api('/api/ytdlp/reset', { method: 'POST', body: '{}' })).message; }
    catch (error) { $('#ytdlpUpdateMessage').textContent = error.message; }
  });
  $('#quitApp').addEventListener('click', async () => {
    if (!confirm('再生を停止してClipNestを終了しますか？')) return;
    try { say((await api('/api/quit', { method: 'POST', body: '{}' })).message); host.audio.pause(); }
    catch (error) { say(error.message); }
  });
  return { async initialize() {
    try {
      const data = await api('/api/settings');
      if (data.settings?.defaultRate) host.setBaseRate(data.settings.defaultRate);
    } catch { /* The existing player remains usable if settings cannot be read. */ }
  } };
}
