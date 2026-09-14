# ClipNest モジュール開発

ソース版では、プレーヤーの追加機能を `static/modules/*.js` として分離できます。
サーバー再起動後、`static/modules` 直下の `.js` ファイルは自動検出され、画面右上の「機能」から有効・無効を切り替えられます。

## 最小モジュール

`static/modules/my-feature.js` を作ります。

```javascript
'use strict';

export default {
  id: 'my-feature',
  name: 'My Feature',
  description: '機能の説明',
  version: '1.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const group = ctx.ui.createControlGroup('My Feature');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost module-button';
    button.textContent = '実行';

    const onClick = () => {
      ctx.notify(`現在位置: ${ctx.audio.currentTime.toFixed(1)} 秒`, 'info');
    };
    button.addEventListener('click', onClick);
    group.append(button);

    ctx.onCleanup(() => button.removeEventListener('click', onClick));
  },
};
```

これだけで自動認識されます。本体の `app.js` や `index.html` にモジュール名を追加する必要はありません。

## `ctx` から利用できるもの

- `ctx.audio`: ClipNestが再生に使っているHTMLAudioElement。
- `ctx.audioEngine`: Web Audio APIの共有AudioGraph。DSP系モジュールはこれを使います。
- `ctx.events`: `player:play`, `player:pause`, `player:timeupdate`, `player:loadedmetadata`, `player:ratechange`, `player:volumechange`, `player:ended`, `player:videochange`, `module:statechange` を受け取れます。
- `ctx.storage`: モジュール専用の設定保存。`get`, `set`, `remove` を利用できます。
- `ctx.getCurrentVideo()`: 現在の動画情報を取得します。
- `ctx.notify(text, kind)`: ClipNestのメッセージ欄へ通知します。
- `ctx.ui.createControlGroup(title)`: プレーヤーへモジュール専用UIを追加します。
- `ctx.onCleanup(fn)`: モジュール無効化時に実行する後始末を登録します。
- `ctx.player.play(video)` / `seek(seconds)`: プレーヤー本体で動画を開く・位置を移動する。
- `ctx.player.getRate()` / `setRate(rate)`: 共通の基本テンポ（0.5〜3倍）。
- `ctx.player.setRateFactor(factor)`: モジュール専用の一時的速度倍率。無効化時に解除され、合計速度は4倍を上限とします。
- `ctx.audioEngine.tap(node, 'input' | 'output')`: 処理前・処理後の信号を分析ノードに接続し、解除関数を返す。
- `ctx.audioEngine.loadWorklet(url)`: 同じAudioWorkletを重複ロードしない。
- `ctx.registerControl(key, setter)` / `ctx.modules.set(id, key, value)`: Audio Labと共有する操作を登録・実行する。
- `ctx.modules.enable(id)`: 必要なモジュールを有効化する。

`/core/module_ui.js` は設定パネル、スライダー、イベント・ノードの後始末を共通化します。`player:videochange` は実際に動画IDが変わった場合のみ発生するため、初期値は `ctx.getCurrentVideo()` で読み取ってください。

## Web Audioエフェクト

AudioNodeを追加する場合、`HTMLMediaElement`から直接 `createMediaElementSource()` を呼ばないでください。
ClipNestは全モジュールで1個のMediaElementSourceを共有します。

```javascript
activate(ctx) {
  const audioContext = ctx.audioEngine.ensure();
  const filter = audioContext.createBiquadFilter();
  filter.type = 'lowshelf';
  filter.frequency.value = 200;
  filter.gain.value = 6;

  const unregister = ctx.audioEngine.registerEffect(
    'module.my-bass-boost',
    filter,
    250,
  );
  ctx.onCleanup(unregister);
}
```

複数のAudioNodeを1つの機能として登録する場合は、第4引数へ最終出力ノードを渡します。

```javascript
firstNode.connect(lastNode);
const unregister = ctx.audioEngine.registerEffect(
  'module.my-chain',
  firstNode,
  250,
  lastNode,
);
```

モジュールを再生中に有効化した場合も、音声処理チェーンはその場で再構築されます。分析用のtap接続も維持されます。

第3引数の数値は処理順です。小さいほど先に処理されます。

## 同梱モジュール

- A-Bリピート・音量ブースト・Playback Queueは `static/core/player_*.js` にある標準機能です。追加機能一覧には表示しません。設定保存キーは移行前と共通です。
- `stereo-pan.js`: StereoPannerNodeによる左右バランス。
- `equalizer.js`: フラット、低音、声、高音、夜向けの音質プリセット。
- `loudness-normalizer.js`: DynamicsCompressorNodeによる音量差の軽減。
- `sleep-timer.js`: 指定時間後の自動一時停止。

各モジュールは「機能」画面から個別にOFFにできます。有効なモジュールは同じ行の「設定を開く」から、動画選択前でも設定パネルを開けます。`panel()`と`inlinePanel()`は`openPanel`コントロールを登録することでこの導線に対応します。`inlinePanel()`は既存のプレイヤー操作欄を一時的に表示し、閉じると元へ戻します。操作欄を複製せず、音声要素は移動しません。

音声加工・選択した話者などの設定値はブラウザのlocalStorageへモジュール別に保存されます。VOICEVOX接続先とWhisperモデルのみサーバー側のsettings.jsonに保存し、`/api/dubbing/settings`で読み書きします。共通の`/api/settings`は既定速度だけを扱い、互いの項目を上書きできません。旧settings.jsonのキーは変更しないため保存済みの値を保持します。

## 2.4で追加した機能

| モジュール | 操作・処理 |
| --- | --- |
| Spectrum Analyzer | 処理後の対数周波数スペクトルと波形。パネル表示時のみ描画。 |
| 3D Audio / HRTF | 方向・高さ・距離、自動回転。イヤホン向け。 |
| Playback Bookmark | 動画・時刻・メモを保存し、別動画からもその位置へ移動。上限300件。 |
| Pitch / Tempo Control | テンポ0.5〜3倍と音程±12半音。既定はSignalsmith Stretch。SoundTouch・ブラウザ標準も選択可。 |
| VOICEVOX 吹替 | 字幕またはローカル文字起こしを選択した声で読み上げ、再生位置に同期。 |
| Audio Lab | 共有設定へまとめてプリセット・数値適用。重複したエフェクトは作りません。 |

キューは標準機能です（上限100件）。ブックマークは初期状態で有効、ほかの新規エフェクトは「機能」から有効にしてください。閉じた設定パネルでも有効なエフェクトは継続します。Audio Labを閉じたり無効化しても、そこから有効化した各エフェクトは維持されます。

削除した5モジュールの復元用ソースは `archive/removed_modules/` に保管しています。アプリの機能一覧・Audio Labからは使用できません。

Pitch / Tempo Control 3.0.0の既定方式はSignalsmith Stretch Web 1.3.2（WASM）です。SoundTouchJSのWSOLA（波形整合）とLanczos補間による旧方式も、比較用に残しています。

「速度変更の方式」でSignalsmith・SoundTouch・ブラウザ標準を選択できます。前二者では音声要素の `playbackRate` で再生位置を進めつつ `preservesPitch=false` とし、速度による音程変化と指定半音を選択したDSPで一括補正します（補正比率 `2^(半音/12) / 再生速度`）。補正比率が1ならDSPをバイパスします。ブラウザの音程保持との二段処理を避け、通常プレーヤーの速度設定にも連動します。

「ブラウザ標準」は従来と同じ音程保持で、SoundTouchは指定半音の変更のみを行います。モジュールをOFFにするとブラウザ標準へ戻ります。音質の優劣は音源と速度・ブラウザによって異なるため比較してください。どちらも極端な速度では音質が変わり、SoundTouchにも処理遅延があります。フォルマント保持は行いません。VOICEVOXの別音声には適用しません。依存コードとライセンスは `THIRD_PARTY_NOTICES.md`、方式の参考は [SoundTouchJS AudioWorklet](https://github.com/cutterbl/SoundTouchJS/tree/master/packages/audio-worklet) を参照してください。

Safari系は2倍以下を推奨します。WebKitの実音声テストで3倍から再生を始めると、DSPに届く前の音声が無音になるケースを確認しました。ブラウザ標準でも再現し、この開始時の問題は未解決です。実音声の検証範囲は0.5・1.5・2倍です（DSP単体では3倍も確認）。

## 検証

`python3 -m unittest discover -s tests` でAPI等、`node tests/dsp_processors.cjs` で既知信号によるPitch・メーターの数値検証を実行します。

Playwrightを導入した環境では、起動中のClipNestに対し `node tests/browser_modules.cjs` で標準3機能と追加10モジュールのUI・連携を確認できます。Playwrightが別の場所にある場合は `PLAYWRIGHT_PATH`、サーバーURLを変える場合は `CLIPNEST_URL` を設定してください。テストは別ブラウザの保存領域と固定音声を使い、ユーザーの履歴を変更しません。Chromeでは実音声デバイスを使用しない出力先でAudioGraphの進行を検証します。
