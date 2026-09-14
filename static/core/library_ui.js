import { LocalLibrary } from './local_library.js';
import { normalizeCues, cueAt } from './subtitles.js';

export function createLibraryUI({ audio, host, api, getVideo, getRelated, open, notify, refreshHome }) {
  const store = new LocalLibrary();
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
  const action = (parent, label, fn) => {
    const b = el('button', label, 'ghost'); b.type = 'button';
    b.addEventListener('click', () => Promise.resolve().then(fn).catch(e => notify(e.message, 'error'))); parent.append(b); return b;
  };
  const time = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const dialog = title => {
    const d = el('dialog', '', 'library-dialog'); d.setAttribute('aria-label', title);
    const head = el('div', '', 'dialog-head'); head.append(el('h2', title));
    action(head, '閉じる', () => d.close()); d.append(head); document.body.append(d);
    d.addEventListener('close', () => { if (!d.open && !d.dataset.switching) d.remove(); }); return d;
  };
  function saveDialog(item) {
    const d = dialog('プレイリストに保存');
    d.append(el('p', item.title));
    const select = el('select'); select.setAttribute('aria-label', '保存先');
    for (const list of store.data.lists) select.add(new Option(list.name, list.id));
    d.append(select);
    action(d, '保存', () => { store.add(select.value, item); notify('プレイリストに保存しました。'); d.close(); });
    const name = el('input'); name.placeholder = '新しいプレイリスト名'; name.maxLength = 80; name.setAttribute('aria-label', '新しいプレイリスト名'); d.append(name);
    action(d, '作成して保存', () => { const list = store.create(name.value); store.add(list.id, item); d.close(); notify('作成して保存しました。'); });
    d.showModal();
  }
  function libraryDialog() {
    const d = dialog('マイライブラリ');
    d.append(el('p', 'このブラウザに保存されます。YouTubeアカウントとは同期しません。', 'module-note'));
    const select = el('select'); select.setAttribute('aria-label', 'プレイリスト'); d.append(select);
    const tools = el('div', '', 'library-actions'), rows = el('div', '', 'library-rows'); d.append(tools, rows);
    const name = el('input'); name.placeholder = 'プレイリスト名'; name.maxLength = 80; name.setAttribute('aria-label', 'プレイリスト名'); tools.append(name);
    function refresh(selected = select.value || 'later') {
      select.replaceChildren(); for (const list of store.data.lists) select.add(new Option(`${list.name} (${list.items.length})`, list.id)); select.value = selected;
      const list = store.list(select.value); rows.replaceChildren();
      if (!list.items.length) rows.append(el('p', '動画カードの「⋯」から保存できます。'));
      list.items.forEach((item, i) => {
        const row = el('div', '', 'library-row');
        const thumb = el('img', '', 'library-thumb'); thumb.src = item.thumbnail; thumb.alt = ''; thumb.loading = 'lazy'; row.append(thumb);
        action(row, item.title, () => { d.close(); open(item); }).classList.add('library-title');
        const up = action(row, '↑', () => { store.move(list.id, i, -1); refresh(); }); up.disabled = i === 0; up.setAttribute('aria-label', `${item.title}を前へ`);
        const down = action(row, '↓', () => { store.move(list.id, i, 1); refresh(); }); down.disabled = i === list.items.length - 1; down.setAttribute('aria-label', `${item.title}を後へ`);
        action(row, '削除', () => { store.remove(list.id, item.id); refresh(); }); rows.append(row);
      });
    }
    select.addEventListener('change', () => refresh());
    action(tools, '作成', () => refresh(store.create(name.value).id));
    action(tools, '名前変更', () => { store.rename(select.value, name.value); refresh(); });
    action(tools, 'リスト削除', () => { if (confirm('このプレイリストを削除しますか？ 元動画は削除されません。')) { store.delete(select.value); refresh('later'); } });
    action(tools, '全件をキューに追加', async () => {
      for (const item of store.list(select.value).items) await host.enqueue(item);
      notify('既存のキューの末尾へ追加しました（キュー上限100件）。');
    });
    action(tools, '先頭を再生', () => { const item = store.list(select.value).items[0]; if (item) { d.close(); open(item); } });
    action(tools, '連続再生（キュー置換）', async () => {
      if (!confirm('現在のキューをこのリストに置き換えて連続再生しますか？')) return;
      await host.playList(store.list(select.value).items); d.close();
    });
    const hidden = el('p', `おすすめ除外：動画${store.data.hiddenVideos.length}件・チャンネル${store.data.hiddenChannels.length}件`); d.append(hidden);
    action(d, 'おすすめ除外をすべて解除', () => { if (confirm('おすすめの除外設定をすべて解除しますか？')) { store.restoreHidden(); hidden.textContent = 'おすすめ除外を解除しました'; refreshHome(); } });
    refresh(); d.showModal();
  }
  document.querySelector('#libraryButton').addEventListener('click', libraryDialog);
  let tracked = null, ready = false, lastSave = 0;
  const persist = () => {
    if (!tracked || !ready || host.seekGuard.active) return;
    try { store.remember(tracked, audio.currentTime, tracked.duration || audio.duration); } catch (e) { notify('視聴位置を保存できません。ブラウザの空き容量を確認してください。', 'error'); }
  };
  audio.addEventListener('loadedmetadata', () => { ready = true; });
  audio.addEventListener('emptied', () => { ready = false; });
  audio.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 5000) { persist(); lastSave = Date.now(); } });
  for (const event of ['pause', 'ended']) audio.addEventListener(event, persist);
  window.addEventListener('pagehide', persist);

  let detailDialog = null, embed = null, cues = [], subtitleBox = null, releaseWatch = null, refreshMode = null;
  function closeEmbed() { if (embed) { embed.remove(); embed = null; } refreshMode?.(); }
  audio.addEventListener('play', closeEmbed); // Never allow native and embedded audio together.
  async function details(item) {
    releaseWatch?.();
    detailDialog?.close();
    closeEmbed(); cues = []; subtitleBox = null; refreshMode = null;
    const d = dialog('再生画面'); detailDialog = d; d.classList.add('watch-dialog');
    const main = el('div', '', 'watch-main'), side = el('aside', '', 'watch-related');
    const layout = el('div', '', 'watch-layout'); layout.append(main, side); d.append(layout);
    const head = d.querySelector('.dialog-head');
    const controls = el('div', '', 'library-actions watch-mode-controls'); main.append(controls);
    const videoSlot = el('div', '', 'video-slot'); main.append(videoSlot);
    const poster = el('img', '', 'watch-poster'); poster.src = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`; poster.alt = item.title || '動画'; videoSlot.append(poster);
    const badge = el('span', '音声モード', 'watch-mode-badge'); videoSlot.append(badge);
    const transport = el('div', '', 'watch-transport'); main.append(transport);
    const heading = el('div', '', 'watch-heading'); heading.append(el('h3', item.title, 'watch-title'));
    const info = el('div', '', 'watch-channel'); info.append(el('span', (item.channel || 'C').slice(0, 1), 'watch-channel-icon'), el('strong', item.channel || 'チャンネル不明'));
    heading.append(info); main.append(heading);
    const actions = el('div', '', 'library-actions watch-video-actions'); heading.append(actions);
    const settings = el('details', '', 'watch-audio-settings'); settings.append(el('summary', '音声設定'));
    const adjustments = el('div', '', 'watch-adjustments'); settings.append(adjustments); main.append(settings);
    action(settings, '追加機能を管理', () => document.querySelector('#modulesButton').click());
    // Reuse the live controls, not copies: one volume bar, one seek controller.
    // The media element itself stays in its original DOM position for Safari.
    const borrowed = [];
    for (const [node, target] of [
      [document.querySelector('#playerShell .transport'), transport],
      [document.querySelector('#playerShell .timeline'), transport],
      [document.querySelector('#volume')?.parentElement, transport],
      [document.querySelector('#rate')?.parentElement, adjustments],
      [document.querySelector('#autoplayButton'), actions],
      [document.querySelector('#loopButton'), adjustments],
      [document.querySelector('#standardPlayerTools'), adjustments],
      [document.querySelector('#moduleRack'), adjustments],
    ]) {
      if (!node) continue;
      const marker = document.createComment('watch-control-home'); node.before(marker);
      borrowed.push({ node, marker, target });
    }
    const dock = () => { for (const { node, target } of borrowed) target.append(node); document.body.classList.add('watch-open'); };
    const undock = () => { for (const { node, marker } of borrowed) if (marker.parentNode) marker.before(node); document.body.classList.remove('watch-open'); };
    let released = false;
    const release = () => { if (released) return; released = true; undock(); borrowed.forEach(({ marker }) => marker.remove()); if (releaseWatch === release) releaseWatch = null; };
    releaseWatch = release; dock();
    const videoButton = action(controls, '映像を開く', () => {
      audio.pause(); host.seekGuard.reset(); closeEmbed();
      embed = el('iframe'); embed.title = item.title || '動画プレーヤー';
      embed.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?playsinline=1&start=${Math.floor(audio.currentTime || 0)}`;
      embed.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; embed.allowFullscreen = true;
      embed.referrerPolicy = 'strict-origin-when-cross-origin'; videoSlot.append(embed);
      refreshMode?.();
    });
    const audioButton = action(controls, '音声モードへ戻る', () => { closeEmbed(); audio.play().catch(e => notify(e.message, 'error')); });
    audioButton.dataset.miniControl = 'true';
    controls.prepend(audioButton);
    const updateMode = () => {
      const video = Boolean(embed); d.dataset.mode = video ? 'video' : 'audio';
      videoButton.setAttribute('aria-pressed', String(video)); audioButton.setAttribute('aria-pressed', String(!video));
      audioButton.textContent = video ? '音声モードへ戻る' : '音声';
      badge.textContent = video ? '公式プレーヤー' : '音声モード';
      transport.hidden = video; settings.hidden = video;
      if (subtitleBox && video) subtitleBox.textContent = '';
    };
    refreshMode = updateMode; updateMode();
    action(head, '画面を拡大', () => { d.classList.toggle('watch-wide'); });
    const miniButton = action(head, 'ミニ表示', () => {
      d.dataset.switching = 'true';
      const mini = d.classList.toggle('watch-mini');
      miniButton.textContent = mini ? '通常表示' : 'ミニ表示';
      if (mini) undock(); else dock();
      d.close();
      if (mini) d.show(); else d.showModal();
      // close events are queued, so release the suppression in the next task.
      setTimeout(() => { delete d.dataset.switching; }, 0);
    });
    miniButton.dataset.miniControl = 'true';
    head.append(head.querySelector('button'));
    action(actions, '保存', () => saveDialog(item));
    const moreActions = el('details', '', 'watch-more-actions'); moreActions.append(el('summary', '共有・その他')); const moreBody = el('div', '', 'library-actions'); moreActions.append(moreBody); actions.append(moreActions);
    action(moreBody, '位置付きリンクをコピー', async () => { await navigator.clipboard.writeText(`https://www.youtube.com/watch?v=${item.id}&t=${Math.floor(audio.currentTime || 0)}s`); notify('リンクをコピーしました。'); });
    const official = el('a', 'YouTubeで開く', 'ghost'); official.href = `https://www.youtube.com/watch?v=${item.id}`; official.target = '_blank'; official.rel = 'noreferrer'; moreBody.append(official);
    const notice = el('details', '', 'watch-notice'); notice.append(el('summary', '映像モードの制限について'), el('p', '映像は公式埋め込みです。音声加工・アプリのキュー／視聴位置は映像と同期しません。埋め込みできない動画はYouTubeで開いてください。全画面・字幕は映像側の操作を使います。', 'module-note')); main.append(notice);
    const description = el('details'); description.append(el('summary', '概要・チャプター'));
    const copy = el('p', '「概要を取得」を押すと公開情報を取得します。', 'video-description'); description.append(copy);
    const chapters = el('div', '', 'library-rows'); description.append(chapters); main.append(description);
    action(description, '概要を取得', async () => {
      copy.textContent = '公開情報を取得中…';
      try {
        const data = await api(`/api/video/details?videoId=${item.id}`, { timeoutMs: 100000 });
        if (!d.isConnected) return;
        copy.textContent = data.description || '概要はありません。'; chapters.replaceChildren();
        for (const chapter of data.chapters || []) action(chapters, `${time(chapter.start)} ${chapter.title}`, () => { closeEmbed(); host.seekGuard.seek(chapter.start); });
      } catch (e) { copy.textContent = e.message; }
    });
    const subtitle = el('details'); subtitle.append(el('summary', '字幕・文字起こし表示'));
    const language = el('select'); language.setAttribute('aria-label', '字幕言語'); language.add(new Option('日本語', 'ja')); language.add(new Option('English', 'en')); subtitle.append(language);
    subtitleBox = el('p', '', 'active-subtitle'); main.append(subtitleBox);
    const transcript = el('div', '', 'transcript'); subtitle.append(transcript); main.append(subtitle);
    action(subtitle, '字幕を取得', async () => {
      transcript.textContent = '字幕を取得中…';
      try {
        const data = await api(`/api/dubbing/subtitles?videoId=${item.id}&language=${language.value}`, { timeoutMs: 100000 });
        if (!d.isConnected) return;
        cues = normalizeCues(data.cues); transcript.replaceChildren();
        for (const cue of cues) action(transcript, `${time(cue.start)} ${cue.text}`, () => { closeEmbed(); host.seekGuard.seek(cue.start); });
      } catch (e) { transcript.textContent = e.message; }
    });
    side.append(el('h3', '関連動画'));
    const related = el('div', '', 'library-rows'); side.append(related);
    related.textContent = '取得中…';
    getRelated(item.id).then(items => {
      if (!d.isConnected) return; related.replaceChildren();
      for (const next of items.filter(v => store.visible(v))) {
        const button = action(related, '', async () => { await open(next); });
        button.classList.add('watch-related-card'); button.setAttribute('aria-label', `${next.title}を再生`);
        const thumb = el('img'); thumb.src = `https://i.ytimg.com/vi/${next.id}/hqdefault.jpg`; thumb.alt = ''; thumb.loading = 'lazy';
        const text = el('span'); text.append(el('strong', next.title), el('small', next.channel || 'チャンネル不明'));
        button.append(thumb, text);
      }
      if (!related.children.length) related.textContent = '関連候補はありません。';
    }).catch(() => { related.textContent = '関連候補を取得できませんでした。'; });
    d.addEventListener('close', () => { if (d.open || d.dataset.switching) return; release(); if (detailDialog === d) { closeEmbed(); cues = []; subtitleBox = null; detailDialog = null; refreshMode = null; } });
    d.showModal();
  }
  audio.addEventListener('timeupdate', () => { if (subtitleBox) { const i = cueAt(cues, audio.currentTime); subtitleBox.textContent = i < 0 ? '' : cues[i].text; } });
  document.querySelector('#watchButton').addEventListener('click', () => { const item = getVideo(); if (item) details(item); });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, button, [contenteditable], dialog') || !getVideo()) return;
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector('#playPause').click(); }
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); host.seekGuard.seek(Math.max(0, audio.currentTime - 10)); }
    if (event.key.toLowerCase() === 'l') { event.preventDefault(); host.seekGuard.seek(Math.min(audio.duration || Infinity, audio.currentTime + 10)); }
  });
  return {
    store,
    beforeOpen(item) {
      const keepWatch = detailDialog?.open && !detailDialog.classList.contains('watch-mini');
      persist(); tracked = item; ready = false; releaseWatch?.(); detailDialog?.close(); closeEmbed();
      if (keepWatch) queueMicrotask(() => { if (getVideo()?.id === item.id) details(item); });
      return item.startFromBeginning ? 0 : store.resume(item);
    },
    close() { persist(); tracked = null; ready = false; releaseWatch?.(); detailDialog?.close(); },
    decorate(article, item, home) {
      const progress = store.data.progress[item.id];
      if (progress?.duration > 0) {
        const bar = el('progress', '', 'watched-progress'); bar.max = progress.duration; bar.value = progress.time;
        bar.setAttribute('aria-label', `視聴済み ${time(progress.time)}`); article.querySelector('.card-media').append(bar);
      }
      const menu = el('details', '', 'card-menu'); const summary = el('summary', '⋯'); summary.setAttribute('aria-label', `${item.title}の操作`); menu.append(summary);
      const options = el('div', '', 'card-menu-options'); menu.append(options);
      action(options, '後で見る', () => { store.add('later', item); menu.open = false; notify('後で見るに保存しました。'); });
      action(options, 'プレイリストに保存', () => { menu.open = false; saveDialog(item); });
      if (store.resume(item)) action(options, `続きから ${time(store.resume(item))}`, () => open(item));
      action(options, '最初から再生', () => { delete store.data.progress[item.id]; store.save(); open({ ...item, startFromBeginning: true }); });
      if (home) {
        action(options, '興味なし', () => { store.hide(item); article.remove(); notify('おすすめから除外しました。マイライブラリで解除できます。'); });
        if (item.channelId) action(options, 'このチャンネルをおすすめしない', () => { store.hide(item, true); refreshHome(); });
      }
      article.append(menu);
    },
  };
}
