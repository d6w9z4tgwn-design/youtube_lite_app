import { panel, button, text, listen, slider, timeLabel } from '/core/module_ui.js';
import { createQualityPitch } from '/core/quality_pitch.js';
import { RVCPlayback } from '/core/rvc_playback.js';

const abortError = () => new DOMException('Cancelled', 'AbortError');
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
  const timer = setTimeout(finish, ms);
  const cancel = () => { clearTimeout(timer); reject(abortError()); };
  signal?.addEventListener('abort', cancel, { once: true });
});

export default {
  id: 'rvc-conversion', name: 'RVC 声変換', version: '1.0.0', enabledByDefault: false,
  description: '人声を分離してRVCで声質を変換し、BGMと再合成。字幕不要・端末内処理。モデルのインポートに対応。',
  async activate(ctx) {
    const { body, dialog, opener } = panel(ctx, 'RVC 声変換', '動画の声を好きな声に。字幕や音声ファイルの用意は不要です。');
    dialog.classList.add('rvc-panel');
    let destroyed = false, available = false, importing = false, playback, queue = Promise.resolve();
    let startButton, returnButton, loading = true, modelInfo = [];
    const requests = new Set();
    const hero = document.createElement('section'); hero.className = 'rvc-hero'; body.append(hero);
    const badge = text(hero, '確認中', 'span'); badge.className = 'rvc-badge';
    const videoTitle = text(hero, '動画を選ぶと、現在の再生位置から変換できます。'); videoTitle.className = 'rvc-video-title';
    const select = (parent, label, entries) => {
      const row = document.createElement('label'); row.className = 'rvc-field'; text(row, label, 'span');
      const input = document.createElement('select'); input.className = 'module-select'; input.setAttribute('aria-label', label);
      for (const [value, name] of entries) input.add(new Option(name, value));
      row.append(input); parent.append(row); return input;
    };
    const model = select(hero, '変換後の声', [['', '読み込み中…']]);
    const modelNote = text(hero, ''); modelNote.className = 'module-note';
    const actions = document.createElement('div'); actions.className = 'rvc-actions'; hero.append(actions);
    const statusBox = document.createElement('section'); statusBox.className = 'rvc-status'; body.append(statusBox);
    const status = text(statusBox, '処理環境とモデルを確認しています…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const steps = document.createElement('ol'); steps.className = 'rvc-steps'; steps.setAttribute('aria-label', '変換の工程'); steps.hidden = true;
    for (const label of ['音声取得', '人声分離', '声を変換', '再生準備']) text(steps, label, 'li');
    statusBox.append(steps);
    const prefetch = text(statusBox, ''); prefetch.className = 'module-note'; prefetch.hidden = true;
    const updateSteps = (stage = '') => {
      const index = ['音声を取得中', '人声とBGMを分離中', 'RVCで声を変換中', '再生用の音声を準備中'].indexOf(stage);
      steps.hidden = index < 0;
      [...steps.children].forEach((item, i) => {
        item.dataset.state = i < index ? 'done' : i === index ? 'current' : 'pending';
        if (i === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
      });
    };
    const render = () => {
      if (destroyed) return;
      const video = ctx.getCurrentVideo(), active = playback?.active, waiting = !!playback?.waiting;
      const phase = importing ? 'importing' : loading ? 'checking' : !available || !model.value ? 'unavailable' : !active ? 'ready' : waiting ? 'loading' : ctx.audio.paused ? 'paused' : 'playing';
      dialog.dataset.phase = phase;
      badge.textContent = { importing: 'モデルを追加中', checking: '確認中', unavailable: '準備が必要', ready: '準備OK', loading: '変換中', paused: '変換音声・一時停止', playing: '声変換 ON' }[phase];
      videoTitle.textContent = video ? `再生対象：${video.title || '選択中の動画'}` : '先に動画を選んでください。音声モードで利用できます。';
      model.disabled = loading || importing;
      if (startButton) {
        startButton.disabled = loading || importing || !available || !model.value || !video || active;
        startButton.textContent = waiting ? '変換を準備しています…' : active ? '声変換を使用中' : '声を変えて再生';
        startButton.setAttribute('aria-busy', String(waiting));
        returnButton.disabled = !active;
        returnButton.textContent = waiting ? '中止して原音を再生' : '原音に戻す';
      }
      if (!active) { updateSteps(); prefetch.hidden = true; }
      opener.textContent = `RVC 声変換${waiting ? ' · 変換中' : active ? ' · ON' : ''}`;
      opener.dataset.active = String(!!active);
      const selected = modelInfo.find(item => item.id === model.value);
      modelNote.textContent = selected ? `${selected.personalOnly ? '個人用プリセット · ' : ''}${selected.hasIndex ? '声の特徴データも準備済み' : '特徴データ（.index）なしでも使用できます'}` : '下の「別の声を追加」からモデルを選べます。';
    };
    const say = value => { if (!destroyed) { status.textContent = value; render(); } };
    const mix = document.createElement('section'); mix.className = 'rvc-mix'; body.append(mix);
    text(mix, '声とBGMのバランス', 'h3');
    const presets = document.createElement('div'); presets.className = 'module-actions'; presets.setAttribute('role', 'group'); presets.setAttribute('aria-label', '音声バランスのプリセット'); mix.append(presets);
    const fold = (parent, label) => {
      const details = document.createElement('details'); details.className = 'rvc-details'; text(details, label, 'summary'); parent.append(details);
      const content = document.createElement('div'); content.className = 'audio-panel-body'; details.append(content); return content;
    };
    const advanced = fold(body, '詳細調整');
    text(advanced, '通常は変更不要です。変更すると変換を停止します。もう一度「声を変えて再生」を押すと反映されます。').className = 'module-note';
    const device = select(advanced, '処理デバイス', [['auto', '自動（GPU優先・使えない場合はCPU）'], ['cpu', 'CPU（互換性優先）'], ['mps', 'Apple GPU'], ['cuda', 'NVIDIA GPU（CUDA環境が必要）']]);
    const savedDevice = ctx.storage.get('device', 'auto');
    device.value = ['auto', 'cpu', 'mps', 'cuda'].includes(savedDevice) ? savedDevice : 'auto';
    const speedNote = text(hero, ''); speedNote.className = 'module-note';
    const updateSpeed = () => { speedNote.textContent = `処理：${{ auto: '自動・GPU優先', cpu: 'CPU', mps: 'Apple GPU', cuda: 'NVIDIA GPU' }[device.value]} ／ モデルを再利用して次の区間を高速化`; };
    const autoButton = button(hero, '高速化を有効にする（GPU自動選択）', () => {
      device.value = 'auto'; ctx.storage.set('device', 'auto'); changed(); updateSpeed(); autoButton.hidden = true;
      say('GPUを優先して使用します。「声を変えて再生」で反映できます。使えない場合はCPUへ切り替えます。');
    });
    autoButton.hidden = device.value === 'auto'; updateSpeed();
    let pitch = 0, indexRate = 0.65;
    const changed = () => { if (playback?.active) playback.stop('声の設定を変更しました。「声を変えて再生」で反映できます。'); render(); };
    const pitchSlider = slider(ctx, advanced, 'pitch', '変換する声の高さ', -12, 12, 1, 0, value => { pitch = value; changed(); }, ' 半音');
    const indexSlider = slider(ctx, advanced, 'indexRate', 'モデルの声への寄せ方', 0, 1, 0.05, 0.65, value => { indexRate = value; changed(); });
    text(advanced, '「寄せ方」は.indexによる特徴検索の割合です。高くするとモデルの特徴が強くなりますが、音がにじむ場合もあります。').className = 'module-note';
    button(advanced, '詳細調整を標準に戻す', () => { device.value = 'auto'; ctx.storage.set('device', 'auto'); pitchSlider.set(0); indexSlider.set(0.65); changed(); updateSpeed(); autoButton.hidden = true; say('詳細調整を標準に戻しました。'); });

    async function request(url, options = {}, externalSignal, timeout = 20000) {
      if (destroyed || externalSignal?.aborted) throw abortError();
      const controller = new AbortController();
      // A started server job must return its ID even if the panel is disabled meanwhile.
      if (!options.keepalive) requests.add(controller);
      const cancel = () => controller.abort(); externalSignal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeout);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error?.message || 'RVCの処理を完了できませんでした。');
        }
        // Read before releasing the cancellation/timeout guard.
        return options.audio ? await response.arrayBuffer() : await response.json();
      } catch (error) {
        if (error.name === 'AbortError' && !externalSignal?.aborted && !destroyed) throw new Error('RVCとの通信がタイムアウトしました。再試行してください。');
        if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('RVCに接続できませんでした。アプリの起動状態を確認してください。');
        throw error;
      } finally {
        clearTimeout(timer); requests.delete(controller); externalSignal?.removeEventListener('abort', cancel);
      }
    }
    const post = (url, data, signal) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: url === '/api/rvc/start' }, signal);
    const cancelJob = async jobId => {
      // Cleanup must work even when the module has just been disabled.
      try { await fetch('/api/rvc/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }), keepalive: true }); } catch {}
    };
    async function refresh(selected) {
      loading = true; render();
      let data;
      try { data = await request('/api/rvc/status'); } finally { loading = false; render(); }
      if (destroyed) return;
      available = data.available === true;
      model.replaceChildren();
      modelInfo = data.models || [];
      for (const item of modelInfo) model.add(new Option(item.name, item.id));
      if (!model.options.length) model.add(new Option('モデルをインポートしてください', ''));
      const chosen = selected || ctx.storage.get('modelId', '');
      if ([...model.options].some(option => option.value === chosen)) model.value = chosen;
      say(available && model.value ? '最初の4秒ができたら再生し、続きを先読みします。長い動画も全体の完成を待つ必要はありません。' : data.message || '環境を確認できませんでした。');
    }
    const run = fn => async () => { try { await fn(); } catch (error) { if (error.name !== 'AbortError') say(error.message); } };
    button(advanced, '環境・モデル一覧を再確認', run(() => refresh(model.value)));

    function getChunk(start, signal, requestedSeconds = 20) {
      const video = ctx.getCurrentVideo();
      const seconds = Math.max(0.2, Math.min(requestedSeconds, video?.duration > start ? video.duration - start : requestedSeconds));
      const payload = { videoId: video?.id, modelId: model.value, start, seconds, pitch, indexRate, device: device.value };
      const task = queue.catch(() => {}).then(async () => {
        if (signal.aborted || destroyed) throw abortError();
        let job, completed = false;
        try {
          for (let attempt = 0; attempt < 12; attempt++) {
            try {
              // Do not abandon a successful start response: obtain its ID so cancellation can stop it.
              job = await post('/api/rvc/start', payload);
              break;
            } catch (error) {
              if (!error.message.includes('実行中') || attempt === 11) throw error;
              await delay(300, signal);
            }
          }
          if (signal.aborted || destroyed) throw abortError();
          const deadline = Date.now() + 23 * 60 * 1000;
          while (job.state === 'running') {
            if (playback?.waiting?.start === start) {
              say(`${timeLabel(start)}〜${timeLabel(start + seconds)}：${job.stage}… 準備ができると再生します。`);
              updateSteps(job.stage);
            } else {
              prefetch.hidden = false; prefetch.textContent = `次の区間 ${timeLabel(start)}〜${timeLabel(start + seconds)} を準備中：${job.stage}`;
            }
            if (Date.now() > deadline) throw new Error('変換がタイムアウトしました。短い動画・CPU設定で再試行してください。');
            await delay(250, signal);
            job = await request(`/api/rvc/job?jobId=${job.jobId}`, {}, signal);
          }
          if (job.state !== 'done') throw new Error(job.message || '変換を完了できませんでした。');
          completed = true;
          const buffers = await Promise.all(['voice', 'background'].map(stem => request(`/api/rvc/audio?jobId=${job.jobId}&stem=${stem}`, { audio: true }, signal, 60000)));
          const [voice, background] = await Promise.all(buffers.map(buffer => ctx.audioEngine.ensure().decodeAudioData(buffer)));
          if (signal.aborted || destroyed) throw abortError();
          updateSteps(); prefetch.hidden = false;
          const processor = { cpu: 'CPU', mps: 'Apple GPU', cuda: 'NVIDIA GPU' }[job.deviceUsed] || '';
          prefetch.textContent = `${timeLabel(start)}〜${timeLabel(start + job.duration)} 準備完了（処理 ${job.processingSeconds}秒${processor ? ` · ${processor}` : ''}${job.modelsReused ? ' · モデル再利用' : ''}${job.cpuFallback ? ' · CPUに切替' : ''}）`;
          return { voice, background, duration: job.duration };
        } finally { if (job?.jobId && !completed) await cancelJob(job.jobId); }
      });
      queue = task; return task;
    }

    const correction = await createQualityPitch(ctx.audioEngine.ensure(), ctx.audioEngine);
    playback = new RVCPlayback(ctx, correction, getChunk, say, render);
    listen(ctx, correction, 'processorerror', () => playback.stop('音声処理が停止しました。モジュールをOFF→ONで再起動してください。'));
    const presetButtons = [], presetValues = [[1, 1], [1.15, 0.45], [1, 0]];
    const reflectMix = () => presetButtons.forEach((item, i) => item.setAttribute('aria-pressed', String(Math.abs(playback.voiceGain.gain.value - presetValues[i][0]) < 0.01 && Math.abs(playback.backgroundGain.gain.value - presetValues[i][1]) < 0.01)));
    const voiceSlider = slider(ctx, mix, 'voiceLevel', '声', 0, 1.5, 0.05, 1, value => { playback.voiceGain.gain.value = value; reflectMix(); }, '×');
    const bgmSlider = slider(ctx, mix, 'backgroundLevel', 'BGM', 0, 1.5, 0.05, 1, value => { playback.backgroundGain.gain.value = value; reflectMix(); }, '×');
    for (const [i, label] of ['標準', '声を中心に', '声だけ'].entries()) presetButtons.push(button(presets, label, () => { voiceSlider.set(presetValues[i][0]); bgmSlider.set(presetValues[i][1]); }));
    reflectMix();
    text(mix, 'バランスは再生中も変更できます。全体の音量はプレイヤーの音量バーで調整します。').className = 'module-note';
    startButton = button(actions, '声を変えて再生', run(async () => {
      if (importing) throw new Error('モデルのインポート完了を待ってください。');
      if (!available || !model.value) throw new Error('処理環境とモデルを準備してください。');
      ctx.storage.set('modelId', model.value);
      await playback.start();
    }));
    startButton.classList.add('rvc-primary');
    returnButton = button(actions, '原音に戻す', run(async () => {
      const resume = playback.active && (!!playback.waiting || !ctx.audio.paused);
      playback.stop('原音に戻しました。');
      if (resume) { await ctx.audioEngine.resume(); try { await ctx.audio.play(); } catch { say('原音に戻しました。プレイヤーの再生ボタンを押してください。'); } }
    }));
    listen(ctx, ctx.events, 'player:videochange', render);
    listen(ctx, model, 'change', () => { ctx.storage.set('modelId', model.value); changed(); });
    listen(ctx, device, 'change', () => { ctx.storage.set('device', device.value); changed(); updateSpeed(); autoButton.hidden = device.value === 'auto'; });

    const importBody = fold(body, '別の声を追加（モデルのインポート）');
    text(importBody, '① .pthを選ぶ → ② 利用条件を確認 → ③ 追加。名前は自動入力されます。.indexは同じモデルのものがあれば選んでください。').className = 'module-note';
    const field = (label, type, accept) => {
      const row = document.createElement('label'); row.className = 'rvc-field'; text(row, label, 'span');
      const input = document.createElement('input'); input.type = type; input.setAttribute('aria-label', label);
      if (accept) input.accept = accept;
      row.append(input); importBody.append(row); return input;
    };
    const weights = field('RVCモデルファイル', 'file', '.pth');
    const name = field('モデルの表示名', 'text'); name.maxLength = 80;
    const index = field('RVC indexファイル（任意）', 'file', '.index');
    text(importBody, '.pth：128MBまで ／ .index：256MBまで。標準RVC v1/v2の推論用モデルに対応。ファイルはこの端末内に保存されます。').className = 'module-note';
    const trustLabel = document.createElement('label'); trustLabel.className = 'audio-toggle';
    const trust = document.createElement('input'); trust.type = 'checkbox';
    trustLabel.append(trust, '信頼できる配布元のモデルで、利用条件を確認しました'); importBody.append(trustLabel);
    listen(ctx, weights, 'change', () => { if (!name.value && weights.files[0]) name.value = weights.files[0].name.replace(/\.pth$/i, '').slice(0, 80); });
    const importButton = button(importBody, 'モデルをインポート', run(async () => {
      if (importing) return;
      if (!trust.checked) throw new Error('信頼できる配布元と利用条件を確認してください。');
      const file = weights.files[0], search = index.files[0];
      if (!file || !/\.pth$/i.test(file.name) || file.size > 128 * 1024**2 || !name.value.trim()) throw new Error('表示名と128MB以内の.pthを指定してください。');
      if (search && (!/\.index$/i.test(search.name) || search.size > 256 * 1024**2)) throw new Error('256MB以内の.indexを指定してください。');
      importing = true; importButton.disabled = true; importButton.textContent = '検証して追加しています…'; playback.stop('モデルを検証・インポートしています…');
      let importedId;
      try {
        const result = await request(`/api/rvc/import?name=${encodeURIComponent(name.value.trim())}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }, undefined, 180000);
        importedId = result.modelId;
        if (search) await request(`/api/rvc/import-index?modelId=${result.modelId}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: search }, undefined, 180000);
        await refresh(result.modelId); ctx.storage.set('modelId', result.modelId);
        weights.value = index.value = ''; trust.checked = false;
        say('新しい声を追加して選択しました。「声を変えて再生」で使えます。');
      } catch (error) {
        if (importedId && !destroyed) { await refresh(importedId).catch(() => {}); say(`モデル本体は保存済みですが、indexのインポートを完了できませんでした。${error.message}`); }
        else throw error;
      } finally { importing = false; if (!destroyed) { importButton.disabled = false; importButton.textContent = 'モデルをインポート'; render(); } }
    }));
    const help = fold(body, '使い方・できること');
    for (const note of [
      '最初は現在位置から4秒だけ変換して再生します。続く8秒、その後は20秒ずつを再生中に先読みします。未変換の場所への移動時も4秒から準備します。変換が追いつかない場合は一時停止し、準備後に再開します。',
      '初回に準備したモデルを次の区間でも再利用します。処理しない状態が2分続くとメモリを解放します。動画全体の一括変換・保存ではなく、再生位置付近の区間だけを保持します。',
      '音声モード専用です。公式の埋め込み映像との同期、話者ごとの選択には対応しません。すべての人声が変換対象で、分離漏れ・声のにじみが残る場合もあります。',
      'EQ・ピッチ・速度変更は変換後の音にも適用されます。VOICEVOX吹替とはどちらか一方を使用します。',
      'ずんだもんはこの端末の個人用プリセットです。モデルはアプリ本体とは別に保存し、公開版には同梱していません。公開・再配布時はモデルと元動画の利用条件を確認してください。',
    ]) text(help, note).className = 'module-note';
    text(body, '端末内で処理 · 初回と移動先では変換待ちが発生します').className = 'rvc-footnote';
    ctx.onCleanup(() => { destroyed = true; for (const controller of requests) controller.abort(); requests.clear(); });
    render(); void refresh().catch(error => say(error.message));
  },
};
