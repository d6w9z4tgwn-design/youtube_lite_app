# GitHub公開・配布手順

このフォルダだけを専用リポジトリのルートにしてください。親のprojectsフォルダ、data、dist、release、仮想環境を丸ごとアップロードしないでください。

## 公開前の必須確認

1. ClipNest本体のライセンスを権利者が選び、ルートに正式な`LICENSE`を追加する。未確定では公開ビルドを停止します。第三者のファイルは本体のライセンスに置き換えません。
2. `python scripts/release.py audit --require-license`。ファイル名・代表的な秘密鍵形式を検査しますが、あらゆる秘密の検出や過去のGit履歴の検査を保証しません。`git diff --cached`と履歴を手作業でも確認してください。すでに追跡済みのDBは.gitignoreだけでは除外されません。
3. `python -m unittest discover -s tests`、Nodeテスト、対象OSでのビルド・起動・実際の検索と再生を確認する。
4. `version.py`を更新し、CHANGELOGに変更内容を記録する。タグは同じ番号の`v2.5.0`形式。
5. GitHubで専用リポジトリを作成し、公開対象だけを登録する。この作業は自動では行いません。

## ビルド

Python 3.11の新規仮想環境で実行します。日常使用の環境にはビルド依存を追加しないでください。

```sh
python3.11 -m venv .venv-build
source .venv-build/bin/activate
python -m pip install -r requirements-build.txt
python scripts/build.py
python scripts/smoke_build.py
```

Windowsでは`py -3.11 -m venv .venv-build`、`.venv-build\Scripts\Activate.ps1`で環境を作成・有効化し、同じPythonコマンドを実行します。

Whisper入りVoice試験版は`python -m pip install -r requirements-voice.txt`の後、`python scripts/build.py --voice --development`。`python scripts/smoke_build.py --voice`で認識ワーカーの依存ロードも確認できます。モデルとVOICEVOXエンジンは同梱しません。モデルは利用者の許可後に取得します。実モデルによる認識は別途確認してください。

**Voice版は現在配布不可の確認用です。** PyAVのwheelにはFFmpegの共有ライブラリやx264/x265などが含まれる場合があり、Pythonパッケージのライセンス表示だけでは配布条件を確認できません。採用するwheelのネイティブライブラリ、対応ソース、ビルド設定と各ライセンスの確認が必要です。確認完了前の公開ビルドはスクリプトで停止します。通常版はこれらを含みません。

ライセンス選定前の手元確認のみ`--development`を使用できます。生成物名に`-private`が付き、公開用Release作成ではこのオプションを使用しません。

- Windows: `dist/ClipNest/ClipNest.exe`。`_internal`を含むフォルダ全体をZIPで配布。exeだけを取り出すと起動できません。
- macOS: `dist/ClipNest.app`。`release`のZIPはdittoでアプリ内のシンボリックリンクと実行権限を保持します。
- Pythonとyt-dlp/EJSを同梱。FFmpegコマンド・Node/Deno・VOICEVOXエンジンは同梱しません。共通の「設定 → 動作環境を確認」では基本動作の依存関係のみを確認します。VOICEVOX・Whisperは「機能 → VOICEVOX 吹替 → 設定を開く」で接続・動作環境・必要な準備を確認できます。FFmpegを独自に同梱する場合はそのビルドのライセンス条件とソース提供義務等を別途確認してください。
- `requirements-build.txt`は基本の版を固定します。Voice依存とビルド環境の全推移依存までは完全固定ではありません。配布物内`dependency-notices/packages.json`に実際の依存一覧・ライセンスを記録します。リリース毎に確認してください。
- macOSのビルドはビルド元OS・CPUに依存します。手元の最新macOSで作ったアプリの古いOS対応は保証しません。Windows向けはWindowsで生成してください。[PyInstallerの説明](https://pyinstaller.org/en/stable/)

## GitHub Actions

- CI: Linux / Windows / macOSでPythonと軽量JSテスト、公開対象検査。
- Release: Windows x64、macOS Apple Silicon / Intelで通常版をビルド。バージョン・起動・DB作成・同梱yt-dlpを検査。Voice版は配布条件の確認待ちで対象外です。
- `workflow_dispatch`は成果物を保存するだけ。`v*`タグをpushすると、すべてのビルド成功後にZIP・ソースZIP・SHA256SUMSを添付した**未公開のRelease下書き**を作成します。
- 下書きの成果物を別端末で確認し、ライセンス・必要環境・署名状況を記載して、所有者がPublishを押してください。ワークフローが存在するだけではビルド成功を意味しません。
- 公開ブランチへの保護ルール、Actions権限、秘密情報スキャン、Private vulnerability reportingはGitHubの設定で有効化してください。

## 署名・自動更新（未実装）

Windowsの証明書、Apple Developer ID / notarization資格情報は必要に応じて所有者が用意してください。現状はDeveloper ID署名・公証なし（macOSの動作用adhoc署名が付く場合があります）。SmartScreen/Gatekeeperで警告・起動ブロックが出る可能性があります。警告を無条件に回避するようには案内しません。

ClipNest本体の自動アップデートは未実装です。将来は配布先の確定、署名検証、更新前バックアップ、ロールバックを含めて設計します。yt-dlpの任意更新とは別機能です。

## データ移行・バックアップ

アプリを終了してからユーザーデータフォルダ全体をコピーしてください。実行中のSQLiteファイル単体のコピーはWALを取りこぼすことがあります。旧`data/clipnest.sqlite3`は新しい保存先にDBが存在しない時のみSQLiteバックアップAPIでコピーし、旧DBは削除しません。旧プロセスを終了してから新版を起動してください。

初めて配布版へ移行する場合は、旧ソース版を一度新版の`python app.py`で起動して移行するか、終了済みの旧DBとWALを新保存先へバックアップから復元してください。配布アプリは任意の場所にある旧ソースフォルダを探し回りません。

ブラウザのプレイリスト・モジュール設定等は同じブラウザの同じ`http://127.0.0.1:8000`に保持されます。別ブラウザ／ポート変更・サイトデータ削除では引き継がれません。DBバックアップには含まれません。

旧Whisperモデルは自動コピーしません。再取得を避けたい場合は、停止した旧版の`data/asr_models`を新保存先の`asr_models`へコピーしてください。`CLIPNEST_DATA_DIR`を指定した起動では、テスト環境に実データを持ち込まないよう旧DBの自動移行を行いません。

## 手元での検証結果（2026-09-07）

- Pythonテスト107件、音量・シーク・ローカルライブラリ・字幕のNodeテスト成功。
- 設定画面、再生画面・ライブラリ、レスポンシブ表示、追加モジュールのブラウザテスト成功。
- macOS 26.6 / arm64で通常版とVoice試験版をビルド。同梱yt-dlp、HTTP・画面素材、初回DB/設定、終了処理、Voiceの認識ワーカー依存ロードを確認。
- 同梱yt-dlpで公開動画のタイトル取得成功。公式更新版2026.08.19の取得・SHA-256照合・実行成功。更新試験は一時フォルダ内で行い、普段の環境は変更していません。
- 配布ZIP内に個人DB、settings.json、Cookieデータ、モデル、ログが含まれないことを確認。
- Windows / Intel Macの実ビルド、GitHub Actions実行、署名・公証、Voiceの実モデル認識は未確認。LICENSE選定とVoiceのバイナリ配布条件確認は未完了。GitHubへの作成・push・公開は行っていません。

## 設定・追加機能の再点検（2026-09-08）

- 共通設定と吹替設定のAPI・画面を分離。既存settings.jsonの値を保持し、片方の保存で他方の設定を上書きしないことを確認。
- 共通の動作環境チェックではVOICEVOXへ接続せず、Whisper不足も警告しません。追加機能を有効にするだけでモデルをダウンロードしません。
- 追加機能一覧から設定を開く導線を統一。EQ・左右バランス・音量均一化・タイマーの操作欄も、動画選択前に調整でき、閉じると元のプレイヤーへ戻ります。音声要素・音量バーは複製しません。
- 通常版で未搭載の文字起こしを無条件に利用できるとする案内や、一般画面の開発者向け表記を修正。設定保存とyt-dlp更新の通知を分離。
- Pythonテスト112件、軽量Nodeテスト4本、設定・機能別設定・吹替・追加モジュール・ライブラリ／再生画面・レイアウトのブラウザテスト6本が成功。
- macOS arm64の通常版・Voice非公開試験版を再ビルド。新しい画面素材と設定API、同梱ワーカー、初回作成、正常終了を確認。ZIP内の個人DB・設定・ログ・Cookie・ASRモデル保存フォルダの混入なし。
- 公開対象99ファイルの検査成功。`audit --require-license`は未確定LICENSEを理由に停止することを確認。上記の未確認事項は引き続き残っています。

反映時はブラウザの再読み込みだけでなく、旧ClipNestプロセスを終了し、修正版のアプリを起動してください。
