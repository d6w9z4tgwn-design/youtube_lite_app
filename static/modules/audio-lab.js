import { panel, button, text } from '/core/module_ui.js';
const RECIPES = {
  '会話をクリアに': [['equalizer', 'preset', 'voice']],
  '夜のリスニング': [['equalizer', 'preset', 'night']],
  '広い音場': [['spatial-audio', 'angle', 0], ['spatial-audio', 'distance', 1]],
  '語学・耳コピ': [['pitch-tempo', 'tempo', 0.8], ['pitch-tempo', 'pitch', 0]],
};
export default {
  id: 'audio-lab', name: 'Audio Lab', version: '1.0.0', enabledByDefault: false,
  description: '音声補正・音場・Pitchをまとめて操作。各モジュールと同じ設定を共有します。',
  activate(ctx) {
    const { body } = panel(ctx, 'Audio Lab', 'プリセットは記載のモジュールを有効化して設定します。その他の有効なエフェクトも重ねて適用されます。');
    const status = text(body, 'プリセットを選択してください。'); status.setAttribute('role', 'status');
    for (const [name, recipe] of Object.entries(RECIPES)) {
      const row = document.createElement('div'); row.className = 'lab-recipe';
      button(row, name, async () => {
        try {
          for (const [id, key, value] of recipe) { await ctx.modules.enable(id); ctx.modules.set(id, key, value); }
          status.textContent = `${name}を適用しました。`;
        } catch (error) { status.textContent = error.message; }
      });
      text(row, [...new Set(recipe.map((r) => r[0]))].join(' / '), 'small'); body.append(row);
    }
    text(body, 'まとめて調整', 'h3');
    const eqRow = document.createElement('label'); eqRow.className = 'audio-toggle';
    text(eqRow, 'EQプリセット', 'span');
    const eq = document.createElement('select'); eq.className = 'module-select'; eq.setAttribute('aria-label', 'Audio Lab EQプリセット');
    for (const [value, label] of [['flat', 'フラット'], ['bass', '低音強調'], ['voice', '声を明瞭に'], ['bright', '高音強調'], ['night', '夜向け']]) eq.add(new Option(label, value));
    eqRow.append(eq);
    button(eqRow, '適用', async () => {
      try { await ctx.modules.enable('equalizer'); ctx.modules.set('equalizer', 'preset', eq.value); status.textContent = 'EQプリセットを適用しました。'; }
      catch (error) { status.textContent = error.message; }
    }); body.append(eqRow);
    for (const [label, id, key, min, max, step, value] of [
      ['音場の方向 °', 'spatial-audio', 'angle', -180, 180, 5, 0],
      ['音程 半音', 'pitch-tempo', 'pitch', -12, 12, 1, 0],
    ]) {
      const row = document.createElement('label'); row.className = 'audio-toggle'; text(row, label, 'span');
      const input = document.createElement('input'); Object.assign(input, { type: 'number', min, max, step, value }); input.setAttribute('aria-label', label); row.append(input);
      button(row, '適用', async () => {
        if (!input.checkValidity()) { input.reportValidity(); return; }
        try { await ctx.modules.enable(id); ctx.modules.set(id, key, Number(input.value)); status.textContent = `${label}を適用しました。`; }
        catch (error) { status.textContent = error.message; }
      }); body.append(row);
    }
  },
};
