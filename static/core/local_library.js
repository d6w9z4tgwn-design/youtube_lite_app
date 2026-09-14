import { savedVideo } from './library_items.js';

export class LocalLibrary {
  constructor(storage = localStorage) {
    this.storage = storage;
    this.key = 'clipnest.library.v1';
    let raw;
    try { raw = JSON.parse(storage.getItem(this.key) || '{}'); } catch { raw = {}; }
    this.data = { lists: [], progress: {}, hiddenVideos: [], hiddenChannels: [] };
    for (const list of (Array.isArray(raw?.lists) ? raw.lists : []).slice(0, 100)) {
      if (!list || typeof list.id !== 'string' || this.data.lists.some(l => l.id === list.id)) continue;
      this.data.lists.push({ id: list.id.slice(0, 80), name: String(list.name || 'プレイリスト').slice(0, 80),
        items: [...new Map((Array.isArray(list.items) ? list.items : []).map(savedVideo).filter(Boolean).map(v => [v.id, v])).values()].slice(0, 200) });
    }
    if (!this.data.lists.some(l => l.id === 'later')) this.data.lists.unshift({ id: 'later', name: '後で見る', items: [] });
    for (const [id, p] of Object.entries(raw?.progress || {}).slice(-2000)) {
      if (/^[\w-]{11}$/.test(id) && p && Number.isFinite(p.time) && p.time >= 0 && p.time < 604800) this.data.progress[id] = p;
    }
    this.data.hiddenVideos = (Array.isArray(raw?.hiddenVideos) ? raw.hiddenVideos : []).filter(id => /^[\w-]{11}$/.test(id)).slice(0, 2000);
    this.data.hiddenChannels = (Array.isArray(raw?.hiddenChannels) ? raw.hiddenChannels : []).filter(id => /^UC[\w-]{22}$/.test(id)).slice(0, 1000);
  }
  save() { this.storage.setItem(this.key, JSON.stringify(this.data)); }
  create(name) {
    name = String(name).trim().slice(0, 80);
    if (!name) throw Error('名前を入力してください。');
    if (this.data.lists.length >= 100) throw Error('プレイリストは100個までです。');
    const list = { id: crypto.randomUUID(), name, items: [] };
    this.data.lists.push(list); this.save(); return list;
  }
  list(id) { const list = this.data.lists.find(l => l.id === id); if (!list) throw Error('プレイリストが見つかりません。'); return list; }
  add(id, raw) {
    const item = savedVideo(raw), list = this.list(id);
    if (!item) throw Error('動画情報が不正です。');
    if (list.items.some(v => v.id === item.id)) return;
    if (list.items.length >= 200) throw Error('各リストは200件までです。');
    list.items.push(item); this.save();
  }
  remove(id, videoId) { const list = this.list(id); list.items = list.items.filter(v => v.id !== videoId); this.save(); }
  move(id, index, delta) {
    const list = this.list(id), target = index + delta;
    if (index < 0 || target < 0 || index >= list.items.length || target >= list.items.length) return;
    [list.items[index], list.items[target]] = [list.items[target], list.items[index]]; this.save();
  }
  rename(id, name) { if (id === 'later') return; name = String(name).trim().slice(0, 80); if (!name) throw Error('名前を入力してください。'); this.list(id).name = name; this.save(); }
  delete(id) { if (id === 'later') throw Error('後で見るは削除できません。'); this.data.lists = this.data.lists.filter(l => l.id !== id); this.save(); }
  remember(item, time, duration) {
    if (!savedVideo(item) || !Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0 || item.isLive) return;
    this.data.progress[item.id] = { time: Math.min(time, duration), duration, updated: Date.now() };
    const entries = Object.entries(this.data.progress).sort((a, b) => b[1].updated - a[1].updated).slice(0, 2000);
    this.data.progress = Object.fromEntries(entries); this.save();
  }
  resume(item) {
    const p = this.data.progress[item.id];
    return p && p.time >= 5 && p.time < p.duration - 10 && p.time / p.duration < 0.95 ? p.time : 0;
  }
  hide(item, channel = false) {
    const key = channel ? 'hiddenChannels' : 'hiddenVideos', id = channel ? item.channelId : item.id;
    if (!id || !(channel ? /^UC[\w-]{22}$/ : /^[\w-]{11}$/).test(id)) return;
    if (!this.data[key].includes(id)) this.data[key].push(id);
    this.data[key] = this.data[key].slice(-2000); this.save();
  }
  visible(item) { return !this.data.hiddenVideos.includes(item.id) && !this.data.hiddenChannels.includes(item.channelId); }
  restoreHidden() { this.data.hiddenVideos = []; this.data.hiddenChannels = []; this.save(); }
}
