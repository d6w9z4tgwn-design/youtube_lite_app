# 開発への参加

Python 3.11以上でREADMEのソース版セットアップを実行してください。秘密情報や自分のDBをテストfixtureに使わないでください。

```sh
python -m unittest discover -s tests
node tests/seek_guard.cjs
node tests/player_volume.cjs
node tests/local_library.mjs
node tests/subtitles.cjs
python scripts/release.py audit
```

ブラウザテストはPlaywrightとChromeを用意し、テスト専用の`CLIPNEST_DATA_DIR`とポートでサーバーを起動してください。`CLIPNEST_URL`で対象URL、`PLAYWRIGHT_PATH`でPlaywrightの場所を指定できます。APIをfixture化したテストと、実際の動画へアクセスするテストを区別してください。

音声プレーヤーのaudio要素を作り直したり移動したりしないでください。Safariのシーク抑制・音声グラフ・モジュールの状態を保持する必要があります。速度・ピッチ変更は音質とシークの回帰確認を行ってください。

変更に合わせてテスト・CHANGELOG・説明を更新し、第三者コードの出典・ライセンスは残してください。公開ライセンス決定前のソースは、第三者ファイルの個別条件を除き自由な再配布を許可した状態ではありません。
