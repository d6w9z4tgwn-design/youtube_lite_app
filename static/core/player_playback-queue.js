import { panel, button, text, listen } from '/core/module_ui.js';
import { savedVideo } from '/core/library_items.js';
export default {
  builtIn: true,
  id: 'playback-queue', name: 'Playback Queue', version: '2.0.0', enabledByDefault: true,
  description: 'カードから動画を追加し、並べ替え・削除・連続再生。キューはこのブラウザに保存。',
  activate(ctx) {
    const { body, opener } = panel(ctx, 'Playback Queue', '各動画の「＋ キュー」で追加。自動再生ONではキューを優先し、空なら関連候補へ進みます。動画リピート中は次へ進みません。');
    const stored = ctx.storage.get('items', []);
    let items = (Array.isArray(stored) ? stored : []).map(savedVideo).filter(Boolean).slice(0, 100);
    let auto = true, advancing = false, revision = 0, pending = null;
    const visited = new Set();
    const autoplay = document.querySelector('#autoplayButton');
    const setAuto = value => {
      auto = Boolean(value); revision++; pending = null;
      ctx.storage.set('auto', auto);
      autoplay.textContent = `自動再生 ${auto ? 'ON' : 'OFF'}`;
      autoplay.setAttribute('aria-pressed', String(auto));
    };
    setAuto(ctx.storage.get('auto', true));
    listen(ctx, autoplay, 'click', () => setAuto(!auto));
    ctx.registerControl('auto', setAuto);
    const cancel = () => { revision++; pending = null; };
    listen(ctx, ctx.events, 'player:videochange', () => {
      cancel();
      const id = ctx.getCurrentVideo()?.id;
      if (!id) visited.clear();
      else visited.add(id);
    });
    for (const event of ['seeking', 'play', 'pause', 'emptied']) listen(ctx, ctx.audio, event, cancel);
    ctx.onCleanup(cancel);
    const actions = document.createElement('div'); actions.className = 'module-actions'; body.append(actions);
    const list = document.createElement('ol'); list.className = 'module-list'; body.append(list);
    const save = () => { ctx.storage.set('items', items); render(); };
    const play = async (index = 0) => {
      if (advancing || !items[index]) return;
      advancing = true;
      const [video] = items.splice(index, 1); save();
      try { await ctx.player.play(video); } catch (error) { items.splice(index, 0, video); save(); ctx.notify(error.message, 'error'); }
      finally { advancing = false; }
    };
    const render = () => {
      list.replaceChildren(); opener.textContent = `キュー ${items.length}`;
      if (!items.length) text(list, 'キューは空です。動画カードから追加できます。', 'li');
      items.forEach((item, index) => {
        const row = document.createElement('li'); row.className = 'module-list-row';
        button(row, item.title, () => play(index)).classList.add('module-item-title');
        const up = button(row, '↑', () => { [items[index - 1], items[index]] = [items[index], items[index - 1]]; save(); }); up.disabled = index === 0; up.setAttribute('aria-label', `${item.title}を前へ`);
        const down = button(row, '↓', () => { [items[index + 1], items[index]] = [items[index], items[index + 1]]; save(); }); down.disabled = index === items.length - 1; down.setAttribute('aria-label', `${item.title}を後へ`);
        button(row, '削除', () => { items.splice(index, 1); save(); }).setAttribute('aria-label', `${item.title}をキューから削除`);
        list.append(row);
      });
    };
    button(actions, '次を再生', () => play());
    const add = (raw) => {
      const item = savedVideo(raw);
      if (!item) { ctx.notify('再生する動画を選択してください。', 'info'); return; }
      if (items.length >= 100) { ctx.notify('キューは100件までです。', 'info'); return; }
      items.push(item); save(); ctx.notify('キューに追加しました。', 'info');
    };
    button(actions, '再生中の動画を追加', () => add(ctx.getCurrentVideo()));
    ctx.player.onEnqueue(add);
    ctx.player.onPlayList(async videos => {
      if (advancing) throw Error('次の動画を準備中です。');
      const next = videos.map(savedVideo).filter(Boolean);
      if (!next.length) throw Error('プレイリストは空です。');
      if (next.length > 100) throw Error('連続再生は100件までです。');
      items = next; save(); setAuto(true); await play();
    });
    listen(ctx, ctx.events, 'player:ended', async () => {
      if (!auto || ctx.audio.loop || !ctx.audio.ended || advancing || pending !== null) return;
      if (items.length) { await play(); return; }
      const id = ctx.getCurrentVideo()?.id;
      if (!id) return;
      visited.add(id);
      const token = revision;
      pending = token;
      try {
        const candidates = await ctx.player.getRelatedVideos(id);
        if (token !== revision || !auto || ctx.audio.loop || !ctx.audio.ended || ctx.getCurrentVideo()?.id !== id) return;
        // Queue edits during the related request still take priority.
        if (items.length) { await play(); return; }
        const next = candidates.map(savedVideo).find(item => item && !visited.has(item.id));
        if (!next) {
          ctx.notify('自動再生できる未再生の関連候補がないため、停止しました。', 'info');
          return;
        }
        await ctx.player.play(next);
      } catch (error) {
        if (token === revision) ctx.notify(`自動再生できませんでした: ${error.message}`, 'error');
      } finally { if (pending === token) pending = null; }
    });
    render();
  },
};
