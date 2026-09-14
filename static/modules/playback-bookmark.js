import { panel, button, text, timeLabel, listen } from '/core/module_ui.js';
import { savedVideo } from '/core/library_items.js';
export default {
  id: 'playback-bookmark', name: 'Playback Bookmark', version: '1.0.0', enabledByDefault: true,
  description: '再生位置とメモを保存。別の動画を開いていても保存位置へ戻れます。',
  activate(ctx) {
    const { body } = panel(ctx, 'Playback Bookmark', 'このブラウザに保存します。保存位置を押すと動画を開いて移動します。');
    const raw = ctx.storage.get('items', []);
    let items = (Array.isArray(raw) ? raw : []).filter((x) => savedVideo(x.video) && Number.isFinite(x.time) && x.time >= 0).slice(0, 300);
    let pending = null;
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 300; input.placeholder = 'この位置へのメモ'; input.setAttribute('aria-label', 'ブックマークのメモ'); body.append(input);
    const list = document.createElement('ul'); list.className = 'module-list';
    const save = () => { ctx.storage.set('items', items); render(); };
    const seekPending = () => {
      if (pending && pending.video.id === ctx.getCurrentVideo()?.id && Number.isFinite(ctx.audio.duration)) { ctx.player.seek(pending.time); pending = null; }
    };
    const jump = async (item) => {
      pending = item;
      if (ctx.getCurrentVideo()?.id !== item.video.id) {
        const opening = ctx.player.play(savedVideo(item.video));
        // play() starts loading synchronously; metadata event restores the saved position.
        pending = item;
        await opening;
      }
      seekPending();
    };
    const render = () => {
      list.replaceChildren();
      if (!items.length) text(list, '保存した位置はありません。', 'li');
      items.forEach((item, index) => {
        const row = document.createElement('li'); row.className = 'module-list-row';
        button(row, `${timeLabel(item.time)} · ${String(item.note || item.video.title)}`, () => jump(item)).classList.add('module-item-title');
        button(row, '削除', () => { items.splice(index, 1); save(); }); list.append(row);
      });
    };
    button(body, '現在位置を保存', () => {
      const video = savedVideo(ctx.getCurrentVideo());
      if (!video) { ctx.notify('動画を選択してください。', 'info'); return; }
      items.unshift({ video, time: Number(ctx.audio.currentTime) || 0, note: input.value.trim() });
      items = items.slice(0, 300); input.value = ''; save();
    });
    body.append(list);
    listen(ctx, ctx.audio, 'loadedmetadata', seekPending);
    listen(ctx, ctx.events, 'player:videochange', () => { if (pending?.video.id !== ctx.getCurrentVideo()?.id) pending = null; });
    render();
  },
};
