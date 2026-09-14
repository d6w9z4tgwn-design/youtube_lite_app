import { panel, text, button, slider, listen } from '/core/module_ui.js';
import { normalizeCues, parseSubtitles, cueAt } from '/core/subtitles.js';
import { dubbingSettings } from '/core/dubbing_settings.js';

export default {
  id: 'voice-dubbing', name: 'VOICEVOX 吹替', version: '1.2.0', enabledByDefault: false,
  description: '動画の字幕から吹替。別途VOICEVOXエンジンが必要。字幕なしの認識には追加の準備が必要です。元音声はBGMも含めてミュート。',
  activate(ctx) {
    const ac = ctx.audioEngine.ensure();
    const originalGain = ac.createGain();
    const unregister = ctx.audioEngine.registerEffect('module.dubbing-mute', originalGain, 10000);
    const { body } = panel(ctx, 'VOICEVOX 吹替', '字幕またはローカル文字起こしから吹替を作ります。声のクローン・音声分離ではなく、元音声はBGM・効果音も含めて消えます。VOICEVOXエンジンを同じ端末で起動してください。接続先の変更は下の詳細設定で行えます。');
    const select = (label, options) => {
      const row = document.createElement('label'); row.className = 'audio-slider';
      text(row, label, 'span'); const input = document.createElement('select'); input.setAttribute('aria-label', label);
      for (const [value, title] of options) input.add(new Option(title, value));
      row.append(input); body.append(row); return input;
    };
    const language = select('字幕言語', [['ja', '日本語'], ['en', '英語（翻訳はしません）']]);
    const voice = select('吹替の声', [['', '話者一覧を取得してください']]);
    text(body, '「この動画から吹替を準備」で字幕を取得します。字幕がない場合は、音声認識の準備ができていれば文字起こしへ進みます。VOICEVOXエンジンは別途必要ですが、字幕からの吹替にWhisperは不要です。字幕・音声ファイルの準備は不要です。').className = 'module-note';
    const status = text(body, '1. 話者一覧を取得 → 2. この動画から吹替を準備 → 3. 吹替を開始'); status.setAttribute('role', 'status');
    let cues = [], boundVideo = null, active = false, generation = 0, current = -1, speed = 1, destroyed = false;
    const speech = new Audio(); speech.preload = 'auto'; speech.preservesPitch = true;
    const cache = new Map(), pending = new Map(), controllers = new Set();
    let queued = Promise.resolve();
    let asrJob = null, asrEpoch = 0, asrTimer = null, asrStarting = false;
    const cancelJob = id => fetch('/api/dubbing/transcribe/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }), keepalive: true }).catch(() => {});
    function cancelAsr() {
      asrEpoch++; clearTimeout(asrTimer);
      if (asrJob) void cancelJob(asrJob);
      asrJob = null;
    }
    const haltSpeech = () => { speech.pause(); current = -1; };
    function stop(clear = false) {
      active = false; generation++; haltSpeech(); originalGain.gain.value = 1;
      for (const controller of controllers) controller.abort(); controllers.clear(); pending.clear();
      speech.removeAttribute('src'); speech.load();
      if (clear) { for (const item of cache.values()) URL.revokeObjectURL(item.url); cache.clear(); }
    }
    async function request(url, options = {}) {
      const controller = new AbortController(); controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 65000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error?.message || '吹替の処理を完了できませんでした。もう一度お試しください。');
        }
        return response;
      } finally { clearTimeout(timeout); controllers.delete(controller); }
    }
    const run = action => async () => {
      try { await action(); } catch (error) { if (!destroyed && error.name !== 'AbortError') status.textContent = error.message; }
    };
    button(body, '話者一覧を取得', run(async () => {
      status.textContent = 'VOICEVOXに接続しています…';
      const token = generation;
      const data = await (await request('/api/dubbing/voices')).json();
      if (destroyed || token !== generation) return;
      voice.replaceChildren();
      for (const item of data.voices || []) voice.add(new Option(`${item.name} / ${item.style}`, String(item.id)));
      const saved = ctx.storage.get('voice', '');
      if ([...voice.options].some(option => option.value === saved)) voice.value = saved;
      status.textContent = voice.options.length ? '話者を選び、「この動画から吹替を準備」を押してください。各話者の利用規約・クレジット条件をご確認ください。' : '読み上げ用の話者が見つかりません。';
    }));
    function install(raw, videoId) {
      const next = normalizeCues(raw);
      if (!next.length) throw new Error('字幕が空です。');
      stop(true); cues = next; boundVideo = videoId;
      status.textContent = `${cues.length}件の字幕を読み込みました。現在位置から吹替できます。`;
    }
    let preparing = false;
    button(body, 'この動画から吹替を準備（ファイル不要）', run(async () => {
      if (preparing || asrStarting || asrJob) throw new Error('準備中です。完了を待つか文字起こしを中止してください。');
      const video = ctx.getCurrentVideo(); if (!video) throw new Error('先に動画を開いてください。');
      preparing = true; cancelAsr(); stop(true);
      const token = generation, epoch = asrEpoch;
      status.textContent = '動画の字幕を自動取得しています…';
      try {
        try {
          const data = await (await request(`/api/dubbing/subtitles?videoId=${encodeURIComponent(video.id)}&language=${language.value}`)).json();
          if (destroyed || token !== generation || epoch !== asrEpoch || ctx.getCurrentVideo()?.id !== video.id) return;
          install(data.cues, video.id);
        } catch (error) {
          if (error.name === 'AbortError' || destroyed || token !== generation || epoch !== asrEpoch || ctx.getCurrentVideo()?.id !== video.id) return;
          status.textContent = '字幕を取得できなかったため、動画の音声から文字起こしを準備します…';
          await startTranscription();
        }
      } finally { preparing = false; }
    }));
    button(body, 'この動画の字幕を取得', run(async () => {
      const video = ctx.getCurrentVideo(); if (!video) throw new Error('先に動画を開いてください。');
      stop(true); const token = generation;
      cancelAsr();
      status.textContent = '字幕を取得しています…（字幕がない場合は下の文字起こしを利用できます）';
      const data = await (await request(`/api/dubbing/subtitles?videoId=${encodeURIComponent(video.id)}&language=${language.value}`)).json();
      if (!destroyed && token === generation && ctx.getCurrentVideo()?.id === video.id) install(data.cues, video.id);
    }));
    const { asrDetails, asrBody } = dubbingSettings(ctx, body, (previous, next) => {
      cancelAsr(); stop(true);
      if (previous.voicevoxPort !== next.voicevoxPort) {
        voice.replaceChildren(new Option('話者一覧を取得してください', ''));
        status.textContent = '接続先を変更して吹替・文字起こしを停止しました。話者一覧を取得し直してください。';
      } else status.textContent = 'モデルを変更して吹替・文字起こしを停止しました。次の文字起こしから使用します。';
    });
    const consentLabel = document.createElement('label');
    const consent = document.createElement('input'); consent.type = 'checkbox';
    consentLabel.append(consent, ' 初回の音声認識モデル取得を許可（ネット接続・空き容量が必要）'); asrBody.append(consentLabel);
    text(asrBody, '現在位置から最大5分をローカルで文字起こしします。数分以上かかる場合があります。認識には誤りがあり、歌・小声・重なった声は苦手です。音声を外部の認識サービスへ送りません。').className = 'module-note';
    async function startTranscription() {
      if (asrStarting || asrJob) throw new Error('文字起こし中です。完了を待つか中止してください。');
      const video = ctx.getCurrentVideo(); if (!video) throw new Error('先に動画を開いてください。');
      asrDetails.open = true;
      asrStarting = true;
      cancelAsr(); stop(true); const epoch = asrEpoch;
      try {
        const availability = await (await request('/api/dubbing/asr-status')).json();
        if (destroyed || epoch !== asrEpoch) return;
        if (!availability.available) throw new Error(availability.installation);
        status.textContent = '文字起こしを開始しています…';
        // Keep the start response alive so cancellation can also cancel a just-created job.
        const response = await fetch('/api/dubbing/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: video.id, start: ctx.audio.currentTime, language: language.value, downloadModel: consent.checked }) });
        const job = await response.json();
        if (!response.ok) throw new Error(job.error?.message || '文字起こしを開始できませんでした。');
        if (destroyed || epoch !== asrEpoch || ctx.getCurrentVideo()?.id !== video.id) { void cancelJob(job.jobId); return; }
        asrJob = job.jobId;
        const poll = async () => {
          try {
            const result = await (await request(`/api/dubbing/transcription?jobId=${encodeURIComponent(job.jobId)}`)).json();
            if (destroyed || epoch !== asrEpoch || ctx.getCurrentVideo()?.id !== video.id) return;
            if (result.status === 'running') {
              status.textContent = `${result.stage}…（対象：${Math.floor(result.start)}〜${Math.floor(result.end)}秒）`;
              asrTimer = setTimeout(poll, 1200); return;
            }
            asrJob = null;
            if (result.status !== 'done') throw new Error(result.message || '文字起こしを中止しました。');
            const previous = boundVideo === video.id ? cues.filter(cue => cue.end <= result.start || cue.start >= result.end) : [];
            install([...previous, ...result.cues], video.id);
            status.textContent = '文字起こしが完了しました。「吹替を開始」で使えます。認識した区間以外は吹替がありません。';
          } catch (error) {
            if (!destroyed && epoch === asrEpoch) { cancelAsr(); status.textContent = error.message; }
          }
        };
        await poll();
      } finally { asrStarting = false; }
    }
    button(asrBody, '字幕なし：現在位置から5分を文字起こし', run(startTranscription));
    button(asrBody, '文字起こしを中止', () => { cancelAsr(); status.textContent = '文字起こしの中止を要求しました。'; });
    const label = document.createElement('label'); label.className = 'audio-slider';
    text(label, 'SRT/VTT字幕ファイル（任意）', 'span'); const file = document.createElement('input');
    const advanced = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = '任意：手元に字幕ファイルがある場合のみ'; advanced.append(summary); body.append(advanced);
    file.type = 'file'; file.accept = '.srt,.vtt'; file.setAttribute('aria-label', 'SRT/VTT字幕ファイル'); label.append(file); advanced.append(label);
    listen(ctx, file, 'change', run(async () => {
      const video = ctx.getCurrentVideo(), selected = file.files?.[0];
      if (!video || !selected) throw new Error('先に動画と字幕ファイルを選んでください。');
      if (selected.size > 2 * 1024 * 1024) throw new Error('字幕ファイルは2MBまでです。');
      const raw = await selected.text();
      if (!destroyed && ctx.getCurrentVideo()?.id === video.id) { cancelAsr(); install(parseSubtitles(raw), video.id); }
      file.value = '';
    }));
    slider(ctx, body, 'speed', '読み上げ速度', 0.5, 2, 0.05, 1, value => { speed = value; stop(true); }, '×');
    listen(ctx, voice, 'change', () => { ctx.storage.set('voice', voice.value); stop(true); status.textContent = '声を変更しました。「吹替を開始」で再生成します。'; });
    const preview = text(body, ''); preview.className = 'module-note';
    text(body, '字幕の長さに合わせて0.5〜3倍速で調整します。収まらない部分は字幕の終わりで停止します。生成が間に合わない場合は動画を一時停止します。準備後に再生ボタンを押してください。吹替音声は元音声のEQ・Pitch処理の対象外です。').className = 'module-note';
    const terms = document.createElement('a'); terms.href = 'https://voicevox.hiroshiba.jp/'; terms.target = '_blank'; terms.rel = 'noreferrer'; terms.textContent = 'VOICEVOX・各話者の利用規約を確認'; body.append(terms);

    function ensure(index) {
      if (index < 0 || index >= cues.length) return Promise.resolve(null);
      if (cache.has(index)) return Promise.resolve(cache.get(index));
      if (pending.has(index)) return pending.get(index);
      const token = generation, cue = cues[index], speaker = Number(voice.value), settingsSpeed = speed;
      const task = queued.catch(() => {}).then(async () => {
        if (token !== generation || destroyed) return null;
        const response = await request('/api/dubbing/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cue.text, speaker, speed: settingsSpeed }) });
        const data = await response.arrayBuffer();
        if (data.byteLength > 8 * 1024 * 1024) throw new Error('吹替音声が大きすぎます。');
        const decoded = await ac.decodeAudioData(data.slice(0));
        if (token !== generation || destroyed) return null;
        const item = { url: URL.createObjectURL(new Blob([data], { type: 'audio/wav' })), duration: decoded.duration, bytes: data.byteLength };
        cache.set(index, item);
        let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [key, entry] of cache) {
          if (cache.size <= 6 && bytes <= 32 * 1024 * 1024) break;
          if (key === index || key === current) continue;
          bytes -= entry.bytes; URL.revokeObjectURL(entry.url); cache.delete(key);
        }
        return item;
      }).finally(() => { if (pending.get(index) === task) pending.delete(index); });
      pending.set(index, task); queued = task; return task;
    }
    let starting = false;
    button(body, '吹替を開始', run(async () => {
      if (starting) return;
      if (voice.value === '' || !voice.options.length) throw new Error('話者一覧から声を選んでください。');
      if (!cues.length || boundVideo !== ctx.getCurrentVideo()?.id) throw new Error('先に「この動画から吹替を準備」を押してください。ファイルは不要です。');
      starting = true;
      stop(); const token = generation;
      try {
        status.textContent = '現在位置の吹替を準備しています…';
        const position = ctx.audio.currentTime;
        let index = cueAt(cues, position);
        if (index < 0) index = cues.findIndex(cue => cue.start > position);
        if (index < 0) throw new Error('現在位置以降に字幕がありません。');
        await ensure(index); await ensure(index + 1);
        if (destroyed || generation !== token) return;
        ctx.events.dispatchEvent(new CustomEvent('player:voice-replacement', { detail: { owner: 'voice-dubbing' } }));
        active = true; originalGain.gain.value = 0;
        status.textContent = '吹替 ON（元音声・BGMはミュート）。動画の再生ボタンで開始・停止できます。'; tick();
      } finally { starting = false; }
    }));
    button(body, '吹替を停止・元の音声に戻す', () => { stop(); status.textContent = '元の音声に戻しました。'; });
    function tick() {
      if (!active || destroyed) return;
      if (ctx.audio.paused || ctx.audio.seeking || ctx.audio.readyState < 3) { haltSpeech(); return; }
      const time = ctx.audio.currentTime, index = cueAt(cues, time);
      if (index < 0) { haltSpeech(); preview.textContent = ''; return; }
      const cue = cues[index], entry = cache.get(index);
      preview.textContent = cue.text;
      if (!entry) {
        haltSpeech(); ctx.audio.pause();
        status.textContent = '吹替を準備するため動画を一時停止しました…';
        const token = generation;
        ensure(index).then(() => { if (active && generation === token) status.textContent = '吹替の準備ができました。動画の再生ボタンを押してください。'; }).catch(error => { if (generation === token) { stop(); status.textContent = error.message; } });
        return;
      }
      const factor = Math.max(0.5, Math.min(3, entry.duration / (cue.end - cue.start)));
      const offset = (time - cue.start) * factor;
      if (offset >= entry.duration) { haltSpeech(); return; }
      speech.volume = ctx.audio.volume; speech.preservesPitch = true;
      speech.playbackRate = Math.max(0.25, Math.min(4, factor * ctx.audio.playbackRate));
      if (current !== index) {
        speech.pause(); speech.src = entry.url; current = index;
        speech.currentTime = offset;
        const token = generation;
        speech.play().catch(error => { if (generation === token && active) { stop(); status.textContent = `吹替を再生できませんでした。${error.message}`; } });
      } else if (Math.abs(speech.currentTime - offset) > 0.4) speech.currentTime = offset;
      ensure(index + 1).catch(() => {});
      ensure(index + 2).catch(() => {});
    }
    const timer = setInterval(tick, 80);
    listen(ctx, ctx.audio, 'pause', haltSpeech); listen(ctx, ctx.audio, 'seeking', haltSpeech); listen(ctx, ctx.audio, 'seekflush', haltSpeech);
    listen(ctx, ctx.events, 'player:videochange', () => { cancelAsr(); stop(true); cues = []; boundVideo = null; status.textContent = '動画が変わりました。字幕または文字起こしを準備してください。'; });
    listen(ctx, ctx.events, 'player:voice-replacement', event => {
      if (event.detail?.owner !== 'voice-dubbing') { cancelAsr(); stop(true); status.textContent = 'RVC声変換を開始したためVOICEVOX吹替を停止しました。'; }
    });
    ctx.onCleanup(() => { destroyed = true; cancelAsr(); clearInterval(timer); stop(true); unregister(); originalGain.disconnect(); });
  },
};
