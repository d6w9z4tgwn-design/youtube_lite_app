'use strict';

import { ModuleHost } from '/core/module_host.js';
import { nextAudioFormat } from '/core/media_formats.js';
import { playerDuration, hasDurationMismatch } from '/core/media_duration.js';
import { bindSeekSlider } from '/core/seek_slider.js';
import { createLibraryUI } from '/core/library_ui.js';
import { setupSettings } from '/core/settings_ui.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

$('#menuToggle').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  $('#menuToggle').setAttribute('aria-expanded', String(!collapsed));
  $('#menuToggle').setAttribute('aria-label', collapsed ? 'サイドバーを広げる' : 'サイドバーを折りたたむ');
});
$('#playerSettingsToggle').addEventListener('click', () => {
  const expanded = $('#playerShell').classList.toggle('settings-expanded');
  $('#playerSettingsToggle').setAttribute('aria-expanded', String(expanded));
  $('#playerSettingsToggle').textContent = expanded ? '設定を閉じる' : '再生設定';
});
$$('.topic-chip[data-query]').forEach(button => button.addEventListener('click', () => {
  $('#searchInput').value = button.dataset.query;
  $('#searchForm').requestSubmit();
}));
$('#allTopics').addEventListener('click', () => loadView('home'));

const state = {
  currentView: 'home',
  currentVideo: null,
  channelReturnView: 'home',
  nextItems: [],
  nextRequestToken: 0,
  mediaRetryCount: 0,
  mediaErrorDetail: '',
  mediaFormat: 'm4a',
  durationInvalid: false,
  durationRecoveries: [],
  attemptedMediaFormats: [],
  mediaRetryTimer: null,
  mediaStallTimer: null,
  mediaSlowTimer: null,
  mediaRetryResetTimer: null,
  pendingSeekTime: 0,
  lastKnownTime: 0,
  requestToken: 0,
  suggestionIndex: -1,
  suggestionItems: [],
  suggestionTimer: null,
  homeOffset: 0,
  homeHasMore: false,
  homeLoading: false,
  homeIds: new Set(),
};

const els = {
  form: $('#searchForm'),
  input: $('#searchInput'),
  searchButton: $('#searchForm button[type="submit"]'),
  suggestions: $('#suggestions'),
  content: $('#content'),
  message: $('#message'),
  title: $('#pageTitle'),
  description: $('#pageDescription'),
  itemCount: $('#itemCount'),
  eyebrow: $('#eyebrow'),
  actions: $('#sectionActions'),
  subscribedChannels: $('#subscribedChannels'),
  channelList: $('#channelList'),
  channelCount: $('#channelCount'),
  channelProfile: $('#channelProfile'),
  channelProfileImage: $('#channelProfileImage'),
  channelProfileInitial: $('#channelProfileInitial'),
  channelHandle: $('#channelHandle'),
  channelStats: $('#channelStats'),
  channelDescription: $('#channelDescription'),
  channelSubscribe: $('#channelSubscribe'),
  channelOfficialLink: $('#channelOfficialLink'),
  tabs: $$('.tab'),
  brand: $('#brand'),
  modulesButton: $('#modulesButton'),
  modulesDialog: $('#modulesDialog'),
  closeModules: $('#closeModules'),
  moduleList: $('#moduleList'),
  moduleRack: $('#moduleRack'),
  statusButton: $('#statusButton'),
  statusDialog: $('#statusDialog'),
  statusText: $('#statusText'),
  closeStatus: $('#closeStatus'),
  playerShell: $('#playerShell'),
  closePlayer: $('#closePlayer'),
  audio: $('#audio'),
  playerThumb: $('#playerThumb'),
  playerTitle: $('#playerTitle'),
  playerChannel: $('#playerChannel'),
  playerStatus: $('#playerStatus'),
  playPause: $('#playPause'),
  back5: $('#back5'),
  forward5: $('#forward5'),
  seek: $('#seek'),
  currentTime: $('#currentTime'),
  duration: $('#duration'),
  rate: $('#rate'),
  volume: $('#volume'),
  loopButton: $('#loopButton'),
  reloadMedia: $('#reloadMedia'),
  upNextButton: $('#upNextButton'),
  upNextDialog: $('#upNextDialog'),
  upNextList: $('#upNextList'),
  closeUpNext: $('#closeUpNext'),
  officialLink: $('#officialLink'),
};

const moduleHost = new ModuleHost({
  audio: els.audio,
  rack: els.moduleRack,
  standardRack: $('#standardPlayerTools'),
  dialogList: els.moduleList,
  notify: showMessage,
  getCurrentVideo: () => state.currentVideo,
  playVideo: (video) => openPlayer(video),
  getRelatedVideos: async (videoId) => {
    await state.nextPromise;
    return state.currentVideo?.id === videoId ? state.nextItems.filter(item => libraryUI.store.visible(item)) : [];
  },
});
const libraryUI = createLibraryUI({
  audio: els.audio, host: moduleHost, api, getVideo: () => state.currentVideo,
  getRelated: id => moduleHost.getRelatedVideos(id), open: item => openPlayer(item),
  notify: showMessage, refreshHome: () => { if (state.currentView === 'home') loadHome(); },
});
const settingsUI = setupSettings({ api, host: moduleHost });
const playerSizeObserver = new ResizeObserver(() => {
  const space = els.playerShell.hidden ? 0 : Math.ceil(els.playerShell.getBoundingClientRect().height + 40);
  document.documentElement.style.setProperty('--player-safe-space', `${space}px`);
});
playerSizeObserver.observe(els.playerShell);
moduleHost.events.addEventListener('player:baserate', (event) => {
  const value = String(event.detail.rate);
  for (const option of [...els.rate.options]) if (option.dataset.custom) option.remove();
  if (![...els.rate.options].some((option) => option.value === value)) {
    const option = new Option(`${Number(value).toFixed(2)}×`, value);
    option.dataset.custom = 'true';
    els.rate.add(option);
  }
  els.rate.value = value;
});

async function api(path, options = {}) {
  const { timeoutMs = 45000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    ...requestOptions,
    signal: controller.signal,
    headers: { ...(requestOptions.headers || {}) },
  };
  if (init.body && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = data.error || {};
      const message = [error.message, error.hint].filter(Boolean).join('\n') || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('応答に時間がかかっています。もう一度お試しください。');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function showMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.dataset.kind = kind;
  els.message.hidden = !text;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function timelineDuration() {
  return playerDuration(state.currentVideo, els.audio.duration);
}

function updateDurationDisplay() {
  const duration = timelineDuration();
  els.duration.textContent = state.currentVideo?.isLive ? 'LIVE' : duration === null ? '—' : formatTime(duration);
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatRelative(timestamp, suffix = '') {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (elapsed < 60) return `たった今${suffix}`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分前${suffix}`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}時間前${suffix}`;
  if (elapsed < 86400 * 30) return `${Math.floor(elapsed / 86400)}日前${suffix}`;
  return `${new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' }).format(new Date(timestamp * 1000))}${suffix}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return formatTime(seconds);
}

function setLoading(active, text = '読み込み中…') {
  els.content.setAttribute('aria-busy', active ? 'true' : 'false');
  if (!active) return;
  els.itemCount.textContent = '';
  els.content.replaceChildren();
  for (let index = 0; index < 8; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-card';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.append(document.createElement('span'), document.createElement('i'), document.createElement('b'));
    els.content.append(skeleton);
  }
  showMessage(text, 'loading');
}

function channelInitial(name) {
  return Array.from(name || 'C')[0]?.toUpperCase() || 'C';
}

function syncSubscriptionButtons(channelId, subscribed) {
  for (const button of document.querySelectorAll('.subscribe[data-channel-id]')) {
    if (button.dataset.channelId !== channelId) continue;
    button.dataset.subscribed = subscribed ? 'true' : 'false';
    button.setAttribute('aria-pressed', subscribed ? 'true' : 'false');
    button.textContent = subscribed ? '登録済み' : '登録';
  }
}

async function saveSubscription(channelId, channelName, subscribed) {
  await api('/api/subscriptions/set', {
    method: 'POST',
    body: JSON.stringify({ channelId, subscribed }),
  });
  syncSubscriptionButtons(channelId, subscribed);
  showMessage(subscribed ? `${channelName}を登録しました。` : `${channelName}の登録を解除しました。`);
}

function renderChannelProfile(channel) {
  const name = channel.channel || 'チャンネル不明';
  els.title.textContent = name;
  els.channelProfileInitial.textContent = channelInitial(name);
  els.channelHandle.textContent = channel.handle || channel.channelId || '';
  els.channelStats.replaceChildren();

  const stats = [];
  if (Number.isFinite(channel.subscriberCount)) {
    stats.push(`登録者 ${formatCount(channel.subscriberCount)}人`);
  }
  stats.push(`保存済み動画 ${channel.videoCount || 0}本`);
  if (channel.watchedCount) stats.push(`視聴済み ${channel.watchedCount}本`);
  for (const text of stats) {
    const item = document.createElement('span');
    item.textContent = text;
    els.channelStats.append(item);
  }

  els.channelDescription.textContent = channel.description || 'このチャンネルの説明は取得できませんでした。';
  els.channelOfficialLink.href = channel.url || `https://www.youtube.com/channel/${encodeURIComponent(channel.channelId)}`;

  els.channelProfileImage.hidden = true;
  els.channelProfileInitial.hidden = false;
  els.channelProfileImage.removeAttribute('src');
  if (channel.avatar) {
    els.channelProfileImage.onload = () => {
      els.channelProfileImage.hidden = false;
      els.channelProfileInitial.hidden = true;
    };
    els.channelProfileImage.onerror = () => {
      els.channelProfileImage.hidden = true;
      els.channelProfileInitial.hidden = false;
    };
    els.channelProfileImage.src = channel.avatar;
  }

  const subscribed = Boolean(channel.isSubscribed);
  els.channelSubscribe.dataset.channelId = channel.channelId;
  syncSubscriptionButtons(channel.channelId, subscribed);
  els.channelSubscribe.onclick = async () => {
    const next = els.channelSubscribe.dataset.subscribed !== 'true';
    els.channelSubscribe.disabled = true;
    try {
      await saveSubscription(channel.channelId, name, next);
      channel.isSubscribed = next;
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      els.channelSubscribe.disabled = false;
    }
  };
}

function renderUpNext(items) {
  els.upNextList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'up-next-empty';
    empty.textContent = 'この動画の関連候補は取得できませんでした。登録チャンネルや別ジャンルの保存動画では補充しません。';
    els.upNextList.append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'up-next-item';
    button.type = 'button';
    button.setAttribute('aria-label', `${item.title || '動画'}を再生`);

    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`;
    image.alt = '';

    const copy = document.createElement('span');
    copy.className = 'up-next-copy';
    const title = document.createElement('strong');
    title.textContent = item.title || 'タイトル不明';
    const detail = document.createElement('span');
    detail.textContent = [item.channel, item.reason].filter(Boolean).join(' · ');
    copy.append(title, detail);

    const duration = document.createElement('span');
    duration.className = 'up-next-duration';
    duration.textContent = item.isLive ? 'LIVE' : formatDuration(item.duration);
    button.append(image, copy, duration);
    button.addEventListener('click', () => {
      els.upNextDialog.close();
      openPlayer(item);
    });
    els.upNextList.append(button);
  }
}

function loadNextCandidates(videoId, fresh = false) {
  state.nextPromise = fetchNextCandidates(videoId, fresh);
  return state.nextPromise;
}

async function fetchNextCandidates(videoId, fresh = false) {
  const token = ++state.nextRequestToken;
  state.nextItems = [];
  els.upNextButton.disabled = true;
  els.upNextButton.textContent = '候補を準備中…';
  $('#retryUpNext').disabled = true;
  renderUpNext([]);
  els.upNextList.querySelector('.up-next-empty').textContent = 'YouTubeの関連候補を取得中…';
  try {
    const data = await api(`/api/next?videoId=${encodeURIComponent(videoId)}${fresh ? '&fresh=1' : ''}`, { timeoutMs: 18000 });
    if (token !== state.nextRequestToken || state.currentVideo?.id !== videoId) return;
    state.nextItems = (data.items || []).filter(item => libraryUI.store.visible(item));
    $('#retryUpNext').disabled = false;
    renderUpNext(state.nextItems);
    els.upNextButton.disabled = false;
    els.upNextButton.textContent = state.nextItems.length ? `次の候補 ${state.nextItems.length}` : '次の候補なし';
  } catch (error) {
    if (token !== state.nextRequestToken || state.currentVideo?.id !== videoId) return;
    els.upNextButton.disabled = false;
    els.upNextButton.textContent = '関連候補を再取得';
    $('#retryUpNext').disabled = false;
    renderUpNext([]);
    console.warn('次の候補を取得できませんでした:', error);
  }
}

function renderSubscribedChannels(channels = []) {
  els.channelList.replaceChildren();
  els.subscribedChannels.hidden = state.currentView !== 'subscriptions' || channels.length === 0;
  els.channelCount.textContent = `${channels.length}件`;
  for (const channel of channels) {
    const item = document.createElement('article');
    item.className = 'channel-item';
    const avatar = document.createElement('button');
    avatar.className = 'channel-avatar channel-avatar-button';
    avatar.type = 'button';
    avatar.textContent = channelInitial(channel.channel);
    avatar.setAttribute('aria-label', `${channel.channel || 'チャンネル'}の概要を開く`);
    avatar.addEventListener('click', () => loadChannel({ ...channel, isSubscribed: true }));
    const copy = document.createElement('div');
    copy.className = 'channel-item-copy';
    const title = document.createElement('strong');
    title.textContent = channel.channel || 'チャンネル不明';
    const count = document.createElement('span');
    count.textContent = `${channel.videoCount || 0}本を保存`;
    copy.append(title, count);
    const remove = document.createElement('button');
    remove.className = 'channel-remove';
    remove.type = 'button';
    remove.textContent = '解除';
    remove.setAttribute('aria-label', `${channel.channel || 'チャンネル'}の登録を解除`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api('/api/subscriptions/set', {
          method: 'POST',
          body: JSON.stringify({ channelId: channel.channelId, subscribed: false }),
        });
        await loadSubscriptions();
        showMessage(`${channel.channel}の登録を解除しました。`);
      } catch (error) {
        remove.disabled = false;
        showMessage(error.message, 'error');
      }
    });
    item.append(avatar, copy, remove);
    els.channelList.append(item);
  }
}

function createCard(item) {
  const article = document.createElement('article');
  article.className = 'card';

  const media = document.createElement('button');
  media.className = 'card-media';
  media.type = 'button';
  media.setAttribute('aria-label', `${item.title || '動画'}を再生`);

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.src = item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`;
  thumb.alt = '';

  const playMark = document.createElement('span');
  playMark.className = 'card-play';
  playMark.textContent = '▶';
  playMark.setAttribute('aria-hidden', 'true');
  media.append(thumb, playMark);

  const badgeText = item.isLive ? 'LIVE' : item.isUpcoming ? '公開予定' : formatDuration(item.duration);
  if (badgeText) {
    const badge = document.createElement('span');
    badge.className = item.isLive ? 'card-badge is-live' : 'card-badge';
    badge.textContent = badgeText;
    media.append(badge);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const avatar = document.createElement('button');
  avatar.className = 'channel-avatar channel-avatar-button';
  avatar.type = 'button';
  avatar.textContent = channelInitial(item.channel);
  avatar.setAttribute('aria-label', `${item.channel || 'チャンネル'}の概要を開く`);
  if (item.channelId) {
    avatar.addEventListener('click', () => loadChannel(item));
  } else {
    avatar.disabled = true;
  }

  const copy = document.createElement('div');
  copy.className = 'card-copy';
  const title = document.createElement('button');
  title.className = 'card-title';
  title.type = 'button';
  title.textContent = item.title || 'タイトル不明';
  const channel = document.createElement('p');
  channel.className = 'channel';
  channel.textContent = item.channel || 'チャンネル不明';
  const meta = document.createElement('p');
  meta.className = 'meta';
  const bits = [];
  if (Number.isFinite(item.viewCount)) bits.push(`${formatCount(item.viewCount)} 回視聴`);
  if (item.isLive) bits.push('ライブ');
  if (item.isUpcoming) bits.push('配信予定');
  const dateText = state.currentView === 'history'
    ? formatRelative(item.lastOpenedAt, 'に再生')
    : formatRelative(item.publishedAt);
  if (dateText) bits.push(dateText);
  meta.textContent = bits.join(' · ');

  copy.append(title, channel, meta);
  if (item.reason && state.currentView !== 'search') {
    const reason = document.createElement('span');
    reason.className = 'reason';
    reason.textContent = item.reason;
    copy.append(reason);
  }
  body.append(avatar, copy);
  const queueButton = document.createElement('button');
  queueButton.type = 'button';
  queueButton.className = 'ghost queue-add';
  queueButton.textContent = '＋ キュー';
  queueButton.setAttribute('aria-label', `${item.title || '動画'}をキューに追加`);
  queueButton.addEventListener('click', () => moduleHost.enqueue(item).catch((error) => showMessage(error.message, 'error')));
  copy.append(queueButton);

  if (item.channelId) {
    const sub = document.createElement('button');
    sub.className = 'subscribe';
    sub.type = 'button';
    sub.dataset.channelId = item.channelId;
    const initialSubscribed = Boolean(item.isSubscribed ?? item.subscribed);
    sub.textContent = initialSubscribed ? '登録済み' : '登録';
    sub.dataset.subscribed = initialSubscribed ? 'true' : 'false';
    sub.setAttribute('aria-pressed', initialSubscribed ? 'true' : 'false');
    sub.addEventListener('click', async (event) => {
      sub.disabled = true;
      try {
        const next = sub.dataset.subscribed !== 'true';
        await saveSubscription(item.channelId, item.channel, next);
        item.isSubscribed = next;
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        sub.disabled = false;
      }
    });
    body.append(sub);
  }

  media.addEventListener('click', () => openPlayer(item));
  title.addEventListener('click', () => openPlayer(item));
  article.append(media, body);
  libraryUI.decorate(article, item, state.currentView === 'home');
  return article;
}

function renderItems(items, emptyText = '表示できる動画がありません。', emptyTitle = '') {
  if (state.currentView === 'home') items = (items || []).filter(item => libraryUI.store.visible(item));
  document.body.dataset.view = state.currentView;
  $$('.topic-chip').forEach(button => {
    const active = button.id === 'allTopics' ? state.currentView === 'home' : state.currentView === 'search' && button.dataset.query === els.input.value.trim();
    button.setAttribute('aria-pressed', String(active));
  });
  els.content.setAttribute('aria-busy', 'false');
  els.content.replaceChildren();
  els.itemCount.textContent = `${items?.length || 0}本`;
  if (!items?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.textContent = '▶';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = emptyTitle || (state.currentView === 'history'
      ? '再生履歴はまだありません'
      : state.currentView === 'subscriptions'
        ? '登録チャンネルはまだありません'
        : state.currentView === 'search'
          ? '動画が見つかりませんでした'
          : 'おすすめを準備しましょう');
    const copy = document.createElement('p');
    copy.textContent = emptyText;
    empty.append(icon, title, copy);
    els.content.append(empty);
    return;
  }
  items.forEach((item) => els.content.append(createCard(item)));
}

function clearMediaTimers() {
  window.clearTimeout(state.mediaRetryTimer);
  window.clearTimeout(state.mediaStallTimer);
  window.clearTimeout(state.mediaSlowTimer);
  window.clearTimeout(state.mediaRetryResetTimer);
  state.mediaRetryTimer = null;
  state.mediaStallTimer = null;
  state.mediaSlowTimer = null;
  state.mediaRetryResetTimer = null;
}

function setPlayerStatus(text, kind = '') {
  els.playerStatus.textContent = text;
  els.playerStatus.dataset.kind = kind;
}

function restorePendingSeek() {
  if (!state.pendingSeekTime || !Number.isFinite(els.audio.duration)) return;
  try {
    moduleHost.seekGuard.seek(Math.min(
      state.pendingSeekTime,
      Math.max(0, (timelineDuration() ?? els.audio.duration) - 0.25),
    ));
    state.pendingSeekTime = 0;
  } catch {}
}

async function loadCurrentMedia({ fresh = false, resumeAt = 0, autoplay = true } = {}) {
  const video = state.currentVideo;
  if (!video?.id) return;
  clearMediaTimers();
  state.durationInvalid = false;
  state.pendingSeekTime = Math.max(0, Number(resumeAt) || 0);
  els.reloadMedia.hidden = true;
  els.playPause.textContent = '…';
  setPlayerStatus(fresh ? '音声へ再接続しています…' : '音声を準備しています…', 'loading');

  const parameters = new URLSearchParams({ format: state.mediaFormat });
  if (fresh) {
    parameters.set('fresh', '1');
    parameters.set('attempt', String(state.mediaRetryCount));
  }
  const query = `?${parameters}`;
  els.audio.pause();
  els.audio.src = `/api/media/${encodeURIComponent(video.id)}${query}`;
  els.audio.load();
  moduleHost.audioEngine.resume().catch(() => {});

  state.mediaSlowTimer = window.setTimeout(() => {
    if (state.currentVideo?.id === video.id && els.audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      setPlayerStatus(state.mediaFormat === 'm4a-safe' ? '音声加工に対応したAACを準備中です。初回は音声全体の取得が必要です…' : '長時間動画を準備中です。しばらくお待ちください…', 'loading');
    }
  }, 8000);

  try {
    if (autoplay) await els.audio.play();
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      els.playPause.textContent = '▶';
      setPlayerStatus('再生ボタンを押してください。');
    }
  }
}

function recoverDurationMismatch() {
  if (state.durationInvalid) {
    moduleHost.seekGuard.block();
    return true;
  }
  if (els.audio.readyState < 1 || !hasDurationMismatch(state.currentVideo, els.audio.duration)) return false;
  const alternate = nextAudioFormat(els.audio, state.attemptedMediaFormats);
  const resumeAt = moduleHost.seekGuard.target ?? state.pendingSeekTime ?? 0;
  const autoplay = !els.audio.paused || moduleHost.seekGuard.resumeAfterSeek;
  state.durationRecoveries.push({ format: state.mediaFormat, duration: els.audio.duration, expected: state.currentVideo.duration, alternate });
  state.durationInvalid = true;
  moduleHost.seekGuard.block();
  clearMediaTimers();
  if (!alternate) {
    setPlayerStatus('音声の時間情報が動画と一致しません。誤った位置での再生を停止しました。別のブラウザでお試しください。', 'error');
    return true;
  }
  state.mediaFormat = alternate;
  state.attemptedMediaFormats.push(alternate);
  // Reload the source, not just its displayed duration. Do not scale timestamps
  // or playbackRate: the decoder's timeline itself cannot be trusted here.
  loadCurrentMedia({ resumeAt, autoplay });
  setPlayerStatus('音声の時間情報にずれがあるため、別形式で読み直しています…', 'loading');
  return true;
}

function retryCurrentMedia({ manual = false } = {}) {
  const video = state.currentVideo;
  if (!video?.id || state.mediaRetryTimer !== null) return;
  window.clearTimeout(state.mediaSlowTimer);
  window.clearTimeout(state.mediaStallTimer);
  window.clearTimeout(state.mediaRetryResetTimer);
  state.mediaSlowTimer = null;
  state.mediaStallTimer = null;
  if (manual) state.mediaRetryCount = 0;
  if (state.mediaRetryCount >= 2) {
    const detail = state.mediaErrorDetail || '通信待ちが続いています。';
    setPlayerStatus(`音声を読み込めませんでした。${detail}`, 'error');
    els.reloadMedia.hidden = false;
    els.playPause.textContent = '▶';
    showMessage(`${detail} 「再読み込み」で再試行できます。`, 'error');
    return;
  }

  state.mediaRetryCount += 1;
  const resumeAt = moduleHost.seekGuard.target ?? Math.max(state.lastKnownTime, Number(els.audio.currentTime) || 0);
  const delay = manual ? 0 : state.mediaRetryCount * 900;
  setPlayerStatus(`再接続を試しています（${state.mediaRetryCount}/2）…`, 'loading');
  state.mediaRetryTimer = window.setTimeout(() => {
    state.mediaRetryTimer = null;
    if (state.currentVideo?.id !== video.id) return;
    loadCurrentMedia({ fresh: true, resumeAt });
  }, delay);
}

function armMediaStallRetry() {
  window.clearTimeout(state.mediaStallTimer);
  const videoId = state.currentVideo?.id;
  if (!videoId) return;
  state.mediaStallTimer = window.setTimeout(() => {
    state.mediaStallTimer = null;
    if (
      state.currentVideo?.id === videoId
      && (!els.audio.paused || (moduleHost.seekGuard.active && moduleHost.seekGuard.resumeAfterSeek))
      && els.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      retryCurrentMedia();
    }
  }, 15000);
}

async function openPlayer(item) {
  if (!item?.id) return;
  const resumeAt = libraryUI.beforeOpen(item);
  state.currentVideo = item;
  state.durationInvalid = false;
  state.durationRecoveries = [];
  els.currentTime.textContent = '0:00';
  els.seek.value = '0';
  // Do not borrow the previous video's media metadata while the new source loads.
  const initialDuration = playerDuration(item, NaN);
  els.duration.textContent = item.isLive ? 'LIVE' : initialDuration === null ? '—' : formatTime(initialDuration);
  state.mediaErrorDetail = '';
  state.mediaFormat = nextAudioFormat(els.audio, []) || 'm4a';
  state.attemptedMediaFormats = [state.mediaFormat];
  els.playerShell.hidden = false;
  document.body.classList.add('player-open');
  els.playerTitle.textContent = item.title || 'タイトル不明';
  els.playerChannel.textContent = item.channel || '';
  els.playerThumb.src = item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`;
  els.playerThumb.alt = `${item.title || '動画'}のサムネイル`;
  els.officialLink.href = item.url || `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
  state.mediaRetryCount = 0;
  state.lastKnownTime = 0;
  moduleHost.videoChanged(item);

  api('/api/history/open', {
    method: 'POST',
    body: JSON.stringify({ videoId: item.id }),
  }).catch((error) => console.warn('履歴保存失敗:', error));
  loadNextCandidates(item.id);

  await loadCurrentMedia({ resumeAt });
}

function closePlayer() {
  libraryUI.close();
  clearMediaTimers();
  state.currentVideo = null;
  els.audio.pause();
  els.audio.removeAttribute('src');
  els.audio.load();
  els.playerShell.hidden = true;
  document.body.classList.remove('player-open');
  state.mediaRetryCount = 0;
  state.pendingSeekTime = 0;
  state.lastKnownTime = 0;
  setPlayerStatus('');
  els.reloadMedia.hidden = true;
  state.nextItems = [];
  state.nextRequestToken += 1;
  els.upNextButton.disabled = true;
  els.upNextButton.textContent = '次の候補';
  renderUpNext([]);
  if (els.upNextDialog.open) els.upNextDialog.close();
  moduleHost.videoChanged(null);
}

function loadView(view) {
  if (view === 'history') loadHistory();
  else if (view === 'subscriptions') loadSubscriptions();
  else loadHome();
}

async function loadChannel(source) {
  const channelId = source?.channelId;
  if (!channelId) return;
  if (state.currentView !== 'channel') {
    state.channelReturnView = ['home', 'history', 'subscriptions'].includes(state.currentView)
      ? state.currentView
      : 'home';
  }
  const token = ++state.requestToken;
  setActiveView('channel');
  renderSubscribedChannels();
  els.eyebrow.textContent = 'CHANNEL';
  els.title.textContent = source.channel || 'チャンネル';
  els.description.textContent = 'チャンネルの概要と、このアプリに保存された公開動画です。';
  const back = document.createElement('button');
  back.className = 'ghost';
  back.type = 'button';
  back.textContent = '← 戻る';
  back.addEventListener('click', () => loadView(state.channelReturnView));
  els.actions.replaceChildren(back);
  els.channelProfile.hidden = false;
  renderChannelProfile({
    channelId,
    channel: source.channel,
    isSubscribed: Boolean(source.isSubscribed ?? source.subscribed),
    videoCount: 0,
    watchedCount: 0,
  });
  setLoading(true, 'チャンネル情報を読み込んでいます…');
  try {
    const data = await api(`/api/channel?channelId=${encodeURIComponent(channelId)}`);
    if (token !== state.requestToken || state.currentView !== 'channel') return;
    renderChannelProfile(data);
    showMessage(data.warning || '');
    renderItems(data.items, 'このチャンネルの動画はまだ保存されていません。');
    installChannelTools(data.items || [], channelId, token);
  } catch (error) {
    if (token !== state.requestToken || state.currentView !== 'channel') return;
    els.content.setAttribute('aria-busy', 'false');
    showMessage(error.message, 'error');
    renderItems([], 'チャンネルの動画を読み込めませんでした。');
  }
}

function installChannelTools(initial, channelId, token) {
  let items = [...initial], offset = 0, loading = false;
  const input = document.createElement('input'); input.type = 'search';
  input.placeholder = '読み込み済みのチャンネル動画を検索'; input.setAttribute('aria-label', 'チャンネル内検索');
  const sort = document.createElement('select'); sort.setAttribute('aria-label', 'チャンネル動画の並べ替え');
  for (const [value, label] of [['new', '新しい順'], ['old', '古い順'], ['popular', '再生回数順']]) sort.add(new Option(label, value));
  const more = document.createElement('button'); more.type = 'button'; more.className = 'ghost'; more.textContent = 'チャンネル動画を追加';
  const status = document.createElement('span'); status.className = 'module-note'; status.setAttribute('role', 'status');
  els.actions.append(input, sort, more, status);
  const render = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const filtered = items.filter(v => (v.title || '').toLocaleLowerCase().includes(query));
    filtered.sort((a, b) => sort.value === 'popular' ? (b.viewCount || 0) - (a.viewCount || 0) : sort.value === 'old' ? (a.publishedAt || 0) - (b.publishedAt || 0) : (b.publishedAt || 0) - (a.publishedAt || 0));
    renderItems(filtered, '読み込み済みの動画に一致するものがありません。追加読み込みもお試しください。');
  };
  input.addEventListener('input', render); sort.addEventListener('change', render);
  more.addEventListener('click', async () => {
    if (loading) return; loading = true; more.disabled = true; status.textContent = '公開動画を取得中…';
    try {
      const data = await api(`/api/channel/videos?channelId=${encodeURIComponent(channelId)}&offset=${offset}`, { timeoutMs: 130000 });
      if (token !== state.requestToken || state.currentView !== 'channel') return;
      items = [...new Map([...items, ...(data.items || [])].map(v => [v.id, v])).values()];
      offset = data.nextOffset; more.hidden = !data.hasMore;
      status.textContent = data.hasMore ? `${items.length}件を読み込み済み` : '取得できる候補を読み込みました'; render();
    } catch (e) { if (token === state.requestToken) status.textContent = e.message; }
    finally { loading = false; more.disabled = false; }
  });
}

function showRecommendationSettings(preferences) {
  const dialog = document.createElement('dialog');
  dialog.className = 'recommendation-settings';
  const title = document.createElement('h2');
  title.id = 'recommendationSettingsTitle';
  title.textContent = 'おすすめの地域・言語';
  dialog.setAttribute('aria-labelledby', title.id);
  const note = document.createElement('p');
  note.className = 'dialog-note';
  note.textContent = '位置情報は取得しません。選んだ地域・言語と最近の検索語をヒントに候補を補充します。YouTube公式の地域ランキングではなく、動画の言語を保証するフィルターでもありません。設定はこのアプリ内で共有されます。';
  dialog.append(title, note);
  const selects = {};
  for (const [key, labelText, options] of [
    ['region', '国・地域', preferences.regions],
    ['language', '優先する言語', preferences.languages],
  ]) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    for (const [value, text] of Object.entries(options)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = preferences[key];
    selects[key] = select;
    label.append(select);
    dialog.append(label);
  }
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'recommendation-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '設定を保存';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '保存して候補を補充';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '閉じる';
  close.className = 'ghost';
  close.addEventListener('click', () => dialog.close());
  let busy = false;
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  async function submit(replenish) {
    if (busy) return;
    busy = true;
    for (const control of [save, refresh, close, ...Object.values(selects)]) control.disabled = true;
    status.textContent = replenish ? '設定を保存して、候補を取得しています…' : '保存しています…';
    let saved = false;
    const token = state.requestToken;
    try {
      await api('/api/recommendations/preferences', {
        method: 'POST', body: JSON.stringify({ region: selects.region.value, language: selects.language.value }),
      });
      saved = true;
      if (replenish) {
        const result = await api('/api/recommendations/refresh', { method: 'POST', body: '{}' });
        status.textContent = `${result.count}件の候補を補充しました（検索: ${result.query}）。`;
      } else status.textContent = '保存しました。候補の補充は必要なときに実行できます。';
    } catch (error) {
      status.textContent = `${saved ? '設定は保存済みです。' : ''}${error.message}`;
    } finally {
      busy = false;
      for (const control of [save, refresh, close, ...Object.values(selects)]) control.disabled = false;
      if (saved && state.currentView === 'home' && token === state.requestToken) await loadHome();
    }
  }
  save.addEventListener('click', () => submit(false));
  refresh.addEventListener('click', () => submit(true));
  actions.append(save, refresh, close);
  dialog.append(status, actions);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

const homeObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) loadMoreHome();
}, { rootMargin: '0px 0px 1400px 0px' });
$('#loadMoreHome').addEventListener('click', () => loadMoreHome());

function updateHomeMore(data) {
  state.homeOffset = data.nextOffset;
  state.homeHasMore = data.hasMore === true && Number.isInteger(data.nextOffset);
  $('#homeMore').hidden = !state.homeHasMore;
  homeObserver.disconnect();
  if (state.homeHasMore) homeObserver.observe($('#homeMore'));
}

async function loadMoreHome() {
  if (state.currentView !== 'home' || !state.homeHasMore || state.homeLoading) return;
  const token = state.requestToken, offset = state.homeOffset;
  state.homeLoading = true;
  $('#loadMoreHome').disabled = true;
  $('#homeMoreStatus').textContent = '候補を追加しています…';
  try {
    const data = await api(`/api/home?offset=${offset}`);
    if (token !== state.requestToken || state.currentView !== 'home') return;
    for (const item of data.items || []) {
      if (!libraryUI.store.visible(item)) continue;
      if (state.homeIds.has(item.id)) continue;
      state.homeIds.add(item.id);
      els.content.append(createCard(item));
    }
    els.itemCount.textContent = `${state.homeIds.size}本`;
    $('#homeMoreStatus').textContent = '';
    if (data.nextOffset <= offset) data.hasMore = false;
    state.homeLoading = false;
    updateHomeMore(data);
  } catch (error) {
    if (token !== state.requestToken) return;
    homeObserver.disconnect(); // Retry explicitly; do not loop on errors.
    $('#homeMoreStatus').textContent = '追加できませんでした。ボタンで再試行できます。';
  } finally {
    if (token === state.requestToken) {
      state.homeLoading = false;
      $('#loadMoreHome').disabled = false;
    }
  }
}

async function loadHome() {
  const token = ++state.requestToken;
  setActiveView('home');
  homeObserver.disconnect();
  state.homeHasMore = false; state.homeLoading = false;
  state.homeIds = new Set();
  $('#homeMore').hidden = true;
  $('#loadMoreHome').disabled = false;
  $('#homeMoreStatus').textContent = '';
  els.eyebrow.textContent = 'HOME';
  els.title.textContent = 'あなたへのおすすめ';
  els.description.textContent = '視聴・検索の傾向を優先し、登録チャンネルは控えめに反映します。';
  els.actions.replaceChildren();
  renderSubscribedChannels();
  setLoading(true, 'おすすめを読み込んでいます…');
  try {
    const data = await api('/api/home');
    if (token !== state.requestToken) return;
    showMessage('');
    if (!data.personalized) {
      els.description.textContent = '検索した動画がここに蓄積され、使うほど好みに近づきます。';
    }
    if (data.preferences) {
      const preferences = data.preferences;
      const setting = document.createElement('button');
      setting.type = 'button';
      setting.className = 'ghost';
      setting.textContent = '地域・言語の設定';
      setting.addEventListener('click', () => showRecommendationSettings(preferences));
      els.actions.replaceChildren(setting);
      const labels = [preferences.region && preferences.regions[preferences.region], preferences.language && preferences.languages[preferences.language]].filter(Boolean);
      if (labels.length) els.description.textContent += ` 地域・言語の候補を優先: ${labels.join(' / ')}。`;
    }
    renderItems(data.items, '検索や視聴をすると、ここにおすすめが表示されます。');
    state.homeIds = new Set((data.items || []).filter(item => libraryUI.store.visible(item)).map(item => item.id));
    updateHomeMore(data);
  } catch (error) {
    if (token !== state.requestToken) return;
    els.content.setAttribute('aria-busy', 'false');
    showMessage(error.message, 'error');
  }
}

async function loadHistory() {
  const token = ++state.requestToken;
  setActiveView('history');
  els.eyebrow.textContent = 'LIBRARY';
  els.title.textContent = '視聴履歴';
  els.description.textContent = 'このアプリで再生した動画です。履歴はこの端末だけに保存されます。';
  renderSubscribedChannels();
  const clear = document.createElement('button');
  clear.className = 'ghost';
  clear.type = 'button';
  clear.textContent = '履歴を消去';
  clear.addEventListener('click', async () => {
    if (!window.confirm('視聴履歴と、おすすめに使う検索傾向を消去しますか？')) return;
    clear.disabled = true;
    try {
      await api('/api/history/clear', { method: 'POST', body: '{}' });
      await loadHistory();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      clear.disabled = false;
    }
  });
  els.actions.replaceChildren(clear);
  setLoading(true, '履歴を読み込んでいます…');
  try {
    const data = await api('/api/history');
    if (token !== state.requestToken) return;
    showMessage('');
    renderItems(data.items, '動画を再生すると、後からここで見つけられます。');
  } catch (error) {
    if (token !== state.requestToken) return;
    els.content.setAttribute('aria-busy', 'false');
    showMessage(error.message, 'error');
  }
}

async function loadSubscriptions() {
  const token = ++state.requestToken;
  setActiveView('subscriptions');
  els.eyebrow.textContent = 'FEED';
  els.title.textContent = '登録チャンネルの新着';
  els.description.textContent = 'このアプリで登録したチャンネルの公開動画をまとめます。';
  const refresh = document.createElement('button');
  refresh.className = 'ghost';
  refresh.type = 'button';
  refresh.textContent = '新着を更新';
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    const originalText = refresh.textContent;
    refresh.textContent = '更新中…';
    showMessage('登録チャンネルの新着を確認しています…', 'loading');
    try {
      const data = await api('/api/subscriptions/refresh', { method: 'POST', body: '{}', timeoutMs: 130000 });
      showMessage(data.refresh?.failedChannels?.length ? '一部のチャンネルを更新できませんでした。' : '新着を更新しました。');
      if (token !== state.requestToken || state.currentView !== 'subscriptions') return;
      renderSubscribedChannels(data.channels || []);
      renderItems(
        data.items,
        '登録チャンネルの公開動画を取得してください。',
        data.channelCount ? '新着を取得しましょう' : '登録チャンネルはまだありません',
      );
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      refresh.disabled = false;
      refresh.textContent = originalText;
    }
  });
  els.actions.replaceChildren(refresh);
  setLoading(true, '登録チャンネルを読み込んでいます…');
  try {
    const data = await api('/api/subscriptions');
    if (token !== state.requestToken) return;
    showMessage('');
    renderSubscribedChannels(data.channels || []);
    renderItems(
      data.items,
      data.channelCount
        ? '「新着を更新」を押すと、公開動画を取得できます。'
        : '動画カードの「登録」を押すと、新着をここで確認できます。',
      data.channelCount ? '新着を取得しましょう' : '登録チャンネルはまだありません',
    );
  } catch (error) {
    if (token !== state.requestToken) return;
    els.content.setAttribute('aria-busy', 'false');
    showMessage(error.message, 'error');
  }
}

function setActiveView(view) {
  state.currentView = view;
  if (view !== 'home') { homeObserver.disconnect(); $('#homeMore').hidden = true; }
  els.channelProfile.hidden = view !== 'channel';
  if (view !== 'subscriptions') els.subscribedChannels.hidden = true;
  els.tabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

async function search(query) {
  const value = query.trim();
  if (!value) return;
  const token = ++state.requestToken;
  setActiveView('search');
  hideSuggestions();
  els.eyebrow.textContent = 'SEARCH';
  els.title.textContent = `「${value}」の検索結果`;
  els.description.textContent = '動画を再生すると、その傾向がホームのおすすめに反映されます。';
  els.actions.replaceChildren();
  renderSubscribedChannels();
  els.searchButton.disabled = true;
  setLoading(true, '動画を検索しています…');
  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: value }),
    });
    if (token !== state.requestToken) return;
    showMessage('');
    renderItems(data.items, '検索結果がありません。');
  } catch (error) {
    if (token !== state.requestToken) return;
    els.content.setAttribute('aria-busy', 'false');
    showMessage(error.message, 'error');
  } finally {
    els.searchButton.disabled = false;
  }
}

function hideSuggestions() {
  state.suggestionItems = [];
  state.suggestionIndex = -1;
  els.suggestions.hidden = true;
  els.suggestions.replaceChildren();
  els.input.setAttribute('aria-expanded', 'false');
  els.input.removeAttribute('aria-activedescendant');
}

function renderSuggestions(items) {
  state.suggestionItems = items;
  state.suggestionIndex = -1;
  els.suggestions.replaceChildren();
  if (!items.length) {
    els.suggestions.hidden = true;
    return;
  }
  items.forEach((value, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `suggestion-${index}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.textContent = value;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      els.input.value = value;
      search(value);
    });
    button.dataset.index = String(index);
    els.suggestions.append(button);
  });
  els.suggestions.hidden = false;
  els.input.setAttribute('aria-expanded', 'true');
}

async function requestSuggestions() {
  const query = els.input.value.trim();
  if (!query) {
    hideSuggestions();
    return;
  }
  try {
    const data = await api(`/api/suggestions?q=${encodeURIComponent(query)}&limit=8`);
    if (els.input.value.trim() === query) renderSuggestions(data.items || []);
  } catch {
    hideSuggestions();
  }
}

function moveSuggestion(delta) {
  if (!state.suggestionItems.length) return;
  state.suggestionIndex = (state.suggestionIndex + delta + state.suggestionItems.length) % state.suggestionItems.length;
  const buttons = [...els.suggestions.querySelectorAll('button')];
  buttons.forEach((button, index) => {
    const active = index === state.suggestionIndex;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  els.input.setAttribute('aria-activedescendant', `suggestion-${state.suggestionIndex}`);
  els.input.value = state.suggestionItems[state.suggestionIndex];
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  search(els.input.value);
});

els.input.addEventListener('input', () => {
  clearTimeout(state.suggestionTimer);
  state.suggestionTimer = setTimeout(requestSuggestions, 120);
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSuggestion(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSuggestion(-1);
  } else if (event.key === 'Escape') {
    hideSuggestions();
  }
});

els.input.addEventListener('blur', () => setTimeout(hideSuggestions, 100));
els.brand.addEventListener('click', loadHome);
els.tabs.forEach((tab) => tab.addEventListener('click', () => loadView(tab.dataset.view)));

els.playPause.addEventListener('click', async () => {
  if (!state.currentVideo) return;
  if (state.durationInvalid) return;
  if (moduleHost.seekGuard.togglePlayback()) {
    els.playPause.textContent = moduleHost.seekGuard.resumeAfterSeek ? '❚❚' : '▶';
    return;
  }
  if (els.audio.paused) {
    try { await els.audio.play(); } catch (error) { showMessage(error.message, 'error'); }
  } else {
    els.audio.pause();
  }
});
els.closePlayer.addEventListener('click', closePlayer);
els.reloadMedia.addEventListener('click', () => retryCurrentMedia({ manual: true }));
els.upNextButton.addEventListener('click', () => {
  if (state.nextItems.length) els.upNextDialog.showModal();
  else if (state.currentVideo) { els.upNextDialog.showModal(); loadNextCandidates(state.currentVideo.id); }
});
els.closeUpNext.addEventListener('click', () => els.upNextDialog.close());
$('#retryUpNext').addEventListener('click', () => { if (state.currentVideo) loadNextCandidates(state.currentVideo.id, true); });
els.back5.addEventListener('click', () => moduleHost.seekGuard.seek(Math.max(0, (moduleHost.seekGuard.target ?? els.audio.currentTime) - 5)));
els.forward5.addEventListener('click', () => moduleHost.seekGuard.seek(Math.min(timelineDuration() ?? Infinity, (moduleHost.seekGuard.target ?? els.audio.currentTime) + 5)));
els.rate.addEventListener('change', () => moduleHost.setBaseRate(els.rate.value));
els.loopButton.addEventListener('click', () => {
  els.audio.loop = !els.audio.loop;
  els.loopButton.textContent = els.audio.loop ? 'リピート ON' : 'リピート OFF';
});
const seekSlider = bindSeekSlider(els.seek, {
  guard: moduleHost.seekGuard,
  duration: timelineDuration,
  preview: time => { els.currentTime.textContent = formatTime(time); },
});
els.audio.addEventListener('play', () => { els.playPause.textContent = '❚❚'; });
els.audio.addEventListener('pause', () => {
  els.playPause.textContent = moduleHost.seekGuard.active && moduleHost.seekGuard.resumeAfterSeek ? '❚❚' : '▶';
});
els.audio.addEventListener('waiting', () => {
  if (!state.currentVideo) return;
  els.playPause.textContent = '…';
  setPlayerStatus('続きを読み込んでいます…', 'loading');
  armMediaStallRetry();
});
els.audio.addEventListener('stalled', () => {
  if (!state.currentVideo) return;
  setPlayerStatus('通信が停滞しています。再接続を待っています…', 'loading');
  armMediaStallRetry();
});
els.audio.addEventListener('loadedmetadata', () => {
  if (!recoverDurationMismatch()) restorePendingSeek();
});
els.audio.addEventListener('seeking', () => {
  if (!state.currentVideo) return;
  setPlayerStatus('移動先を読み込んでいます…', 'loading');
  armMediaStallRetry();
});
els.audio.addEventListener('seekflush', () => {
  setPlayerStatus('前の音声を破棄して、移動先を読み込んでいます…', 'loading');
  armMediaStallRetry();
});
els.audio.addEventListener('canplay', () => {
  if (!state.currentVideo) return;
  if (recoverDurationMismatch()) return;
  clearMediaTimers();
  restorePendingSeek();
  els.reloadMedia.hidden = true;
  setPlayerStatus('');
});
els.audio.addEventListener('playing', () => {
  if (recoverDurationMismatch()) return;
  clearMediaTimers();
  state.mediaRetryResetTimer = window.setTimeout(() => {
    state.mediaRetryCount = 0;
    state.mediaRetryResetTimer = null;
  }, 30000);
  els.reloadMedia.hidden = true;
  setPlayerStatus('');
});
els.audio.addEventListener('timeupdate', () => {
  if (seekSlider.isPreviewing()) return;
  els.currentTime.textContent = formatTime(els.audio.currentTime);
  const current = Number(els.audio.currentTime);
  if (!moduleHost.seekGuard.active) {
    if (Number.isFinite(current) && current >= 0) state.lastKnownTime = current;
    window.clearTimeout(state.mediaStallTimer);
    state.mediaStallTimer = null;
  }
  const duration = timelineDuration();
  if (duration !== null) {
    els.seek.value = String(Math.min(1000, Math.round((els.audio.currentTime / duration) * 1000)));
  }
});
els.audio.addEventListener('durationchange', () => {
  if (!recoverDurationMismatch()) updateDurationDisplay();
});
els.audio.addEventListener('error', () => {
  if (!state.currentVideo) return;
  const error = els.audio.error;
  const reasons = {
    1: '再生が中断されました',
    2: '音声データの通信に失敗しました',
    3: 'ブラウザが音声データをデコードできませんでした',
    4: '再生形式に対応していないか、音声データを取得できませんでした',
  };
  state.mediaErrorDetail = `${reasons[error?.code] || '原因不明の再生エラー'}（MEDIA_${error?.code || 0}）。`;
  console.error('ClipNest playback error', {
    videoId: state.currentVideo.id,
    code: error?.code,
    message: error?.message,
    currentTime: els.audio.currentTime,
    readyState: els.audio.readyState,
    networkState: els.audio.networkState,
    format: state.mediaFormat,
  });
  if (error?.code === 3 || error?.code === 4) {
    const alternate = nextAudioFormat(els.audio, state.attemptedMediaFormats);
    if (alternate) {
      const videoId = state.currentVideo.id;
      const resumeAt = moduleHost.seekGuard.target ?? Math.max(state.lastKnownTime, Number(els.audio.currentTime) || 0);
      clearMediaTimers();
      state.mediaFormat = alternate;
      state.attemptedMediaFormats.push(alternate);
      state.mediaRetryCount = 0;
      setPlayerStatus('別の音声形式で読み直しています…', 'loading');
      state.mediaRetryTimer = window.setTimeout(() => {
        state.mediaRetryTimer = null;
        if (state.currentVideo?.id === videoId) loadCurrentMedia({ resumeAt });
      }, 100);
      return;
    }
  }
  els.playPause.textContent = '▶';
  retryCurrentMedia();
});

els.modulesButton.addEventListener('click', () => {
  moduleHost.renderManager();
  els.modulesDialog.showModal();
});
els.closeModules.addEventListener('click', () => els.modulesDialog.close());

els.statusButton.addEventListener('click', async () => {
  $('#playbackDiagnostics').textContent = JSON.stringify({
    revision: 'seek-8', browser: navigator.userAgent,
    playbackRate: els.audio.playbackRate, baseRate: moduleHost.baseRate,
    mediaFormat: state.mediaFormat, durationRecoveries: state.durationRecoveries,
    videoId: state.currentVideo?.id, currentTime: els.audio.currentTime,
    mediaDuration: els.audio.duration, videoDuration: state.currentVideo?.duration,
    paused: els.audio.paused, muted: els.audio.muted, seeking: els.audio.seeking,
    readyState: els.audio.readyState, contextState: moduleHost.audioEngine.context?.state,
    outputDisconnected: Boolean(moduleHost.audioEngine.seekDisconnected),
    trace: moduleHost.seekGuard.trace,
  }, null, 2);
  els.statusDialog.showModal();
  els.statusText.textContent = '読み込み中…';
  try {
    const data = await api('/api/status');
    const status = data.ytDlp || {};
    const runtimeNames = Object.entries(status.runtimeDetails || {})
      .filter(([, runtime]) => runtime.available)
      .map(([name, runtime]) => `${name === 'node' ? 'Node.js' : 'Deno'} ${runtime.version || ''}${runtime.supported ? '' : '（要更新）'}`.trim());
    els.statusText.textContent = [
      `ClipNest ${data.appVersion || '—'}`,
      '',
      `yt-dlp: ${status.available ? status.currentVersion || '検出済み' : '未検出'}`,
      `使用元: ${status.source || '—'}`,
      `JavaScript: ${runtimeNames.join(' / ') || '未検出'}`,
      status.message || '',
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  } catch (error) {
    els.statusText.textContent = error.message;
  }
});
els.closeStatus.addEventListener('click', () => els.statusDialog.close());

async function startApp() {
  try {
    await moduleHost.loadAll();
  } catch (error) {
    console.error('モジュール初期化失敗:', error);
    showMessage(`追加機能の初期化に失敗しました: ${error.message}`, 'error');
  }
  await settingsUI.initialize();
  await loadHome();
}

startApp();
