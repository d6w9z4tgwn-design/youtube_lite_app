import { button, listen, text } from '/core/module_ui.js';

// Optional service settings live with their module, not the common app screen.
// The on-disk keys stay unchanged so existing ports/models are preserved.
export function dubbingSettings(ctx, parent, onSaved) {
  let destroyed = false, loaded = false, saving = false, loadRevision = 0, checkRevision = 0;
  let values;
  const requests = new Set();
  const section = document.createElement('section'); section.className = 'dubbing-settings';
  parent.append(section);
  const connection = document.createElement('details');
  text(connection, '詳細：VOICEVOXの接続先', 'summary');
  text(connection, '通常は変更不要です。別のポートでエンジンを起動している場合だけ指定してください。接続先はこの端末（127.0.0.1）のみです。').className = 'module-note';
  section.append(connection);
  const portForm = document.createElement('form'), portFields = document.createElement('fieldset');
  portFields.disabled = true; portForm.append(portFields); connection.append(portForm);
  const portLabel = document.createElement('label');
  text(portLabel, 'VOICEVOXエンジンのポート', 'span');
  const port = document.createElement('input');
  Object.assign(port, { type: 'number', min: '1024', max: '65535', step: '1', required: true });
  port.setAttribute('aria-label', 'VOICEVOXエンジンのポート'); portLabel.append(port); portFields.append(portLabel);
  const portSave = button(portFields, '接続先を保存', () => {}); portSave.type = 'submit';
  text(connection, '保存すると吹替・文字起こしを停止します。その後、話者一覧を取得し直してください。').className = 'module-note';

  const asrDetails = document.createElement('details'); asrDetails.className = 'dubbing-asr';
  text(asrDetails, '字幕がない場合：文字起こし', 'summary'); section.append(asrDetails);
  const asrBody = document.createElement('div'); asrBody.className = 'dubbing-asr-body'; asrDetails.append(asrBody);
  text(asrBody, '字幕からの吹替では不要です。字幕なしの動画だけ、Whisperによるローカル文字起こしを使用します。').className = 'module-note';
  const availability = text(asrBody, '「文字起こしの動作環境を確認」で、この機能に必要なソフトを確認できます。');
  availability.setAttribute('aria-live', 'polite');
  const check = button(asrBody, '文字起こしの動作環境を確認', async () => {
    const revision = ++checkRevision; check.disabled = true;
    try {
      const data = await request('/api/dubbing/asr-status');
      if (destroyed || revision !== checkRevision) return;
      availability.textContent = data.installation || '文字起こしの状態を取得できませんでした。';
    } catch (error) { if (!destroyed && revision === checkRevision) availability.textContent = error.message; }
    finally { if (!destroyed && revision === checkRevision) check.disabled = false; }
  });
  const modelForm = document.createElement('form'), modelFields = document.createElement('fieldset');
  modelFields.disabled = true; modelForm.append(modelFields); asrBody.append(modelForm);
  const modelLabel = document.createElement('label'); text(modelLabel, '文字起こしモデル', 'span');
  const model = document.createElement('select'); model.className = 'module-select'; model.setAttribute('aria-label', '文字起こしモデル');
  for (const [value, label] of [['tiny', 'tiny — 軽量'], ['base', 'base — 標準'], ['small', 'small — 精度優先・重い']]) model.add(new Option(label, value));
  modelLabel.append(model); modelFields.append(modelLabel);
  const modelSave = button(modelFields, 'モデル設定を保存', () => {}); modelSave.type = 'submit';
  text(asrBody, 'モデルを保存するだけではダウンロードしません。変更すると進行中の吹替・文字起こしを停止し、次の文字起こしから新しいモデルを使います。').className = 'module-note';
  const message = text(section, '吹替の設定を読み込み中…'); message.setAttribute('aria-live', 'polite');
  const retry = button(section, '吹替設定を再読み込み', () => load()); retry.hidden = true;

  async function request(url, options = {}) {
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '設定を読み書きできませんでした。');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('設定の通信が中断・タイムアウトしました。再試行してください。');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('吹替設定を取得できませんでした。アプリの接続状態を確認し、再読み込みしてください。');
      throw error;
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function populate(next) {
    if (!Number.isInteger(next?.voicevoxPort) || !['tiny', 'base', 'small'].includes(next?.whisperModel)) throw new Error('吹替設定を取得できませんでした。アプリを再起動してください。');
    values = next; port.value = String(next.voicevoxPort); model.value = next.whisperModel;
  }
  async function load() {
    if (destroyed || saving) return;
    const revision = ++loadRevision;
    retry.disabled = true; portFields.disabled = modelFields.disabled = true;
    try {
      const data = await request('/api/dubbing/settings');
      if (destroyed || revision !== loadRevision) return;
      populate(data.settings); loaded = true; retry.hidden = true; message.textContent = '';
    } catch (error) {
      if (destroyed || revision !== loadRevision) return;
      loaded = false; retry.hidden = false; message.textContent = error.message;
    } finally {
      if (!destroyed && revision === loadRevision) { retry.disabled = false; portFields.disabled = modelFields.disabled = !loaded; }
    }
  }
  async function save(event, patch) {
    event.preventDefault();
    if (!loaded || saving || destroyed) return;
    saving = true; portFields.disabled = modelFields.disabled = true;
    message.textContent = '吹替設定を保存しています…';
    const previous = values;
    try {
      const data = await request('/api/dubbing/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (destroyed) return;
      populate(data.settings);
      if (previous.voicevoxPort !== values.voicevoxPort || previous.whisperModel !== values.whisperModel) onSaved(previous, values);
      message.textContent = '保存しました。吹替機能の設定だけを変更しました。';
    } catch (error) { if (!destroyed) message.textContent = error.message; }
    finally { saving = false; if (!destroyed) portFields.disabled = modelFields.disabled = !loaded; }
  }
  listen(ctx, portForm, 'submit', event => { void save(event, { voicevoxPort: Number(port.value) }); });
  listen(ctx, modelForm, 'submit', event => { void save(event, { whisperModel: model.value }); });
  ctx.onCleanup(() => { destroyed = true; loadRevision++; checkRevision++; for (const controller of requests) controller.abort(); requests.clear(); });
  void load();
  return { asrDetails, asrBody };
}
