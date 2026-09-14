# SoundTouchJS

## Python runtime native libraries

The locally verified macOS standard build includes OpenSSL 3.6.3
(Apache-2.0), liblzma from XZ 5.8.3 (0BSD), libmpdec (BSD), and SQLite
(public domain), in addition to CPython. License texts are included in
`licenses/OpenSSL-Apache-2.0.txt`, `licenses/XZ-0BSD.txt`,
`licenses/mpdecimal-BSD.txt`, and `dependency-notices/Python-LICENSE.txt`.
Copyright remains with the OpenSSL Project Authors, XZ Utils authors and
contributors, and mpdecimal authors as identified in those notices.
Sources: https://github.com/openssl/openssl,
https://tukaani.org/xz/, https://www.bytereef.org/mpdecimal/,
https://www.sqlite.org/copyright.html.
Other OS/Python distributions can bundle different native library versions;
review their notices when preparing each release.

ClipNest本体のライセンスと以下の第三者ライセンスは別です。配布ビルドは
`dependency-notices/` にPythonパッケージの実際の版とライセンス文を含めます。
Python/yt-dlp/EJS/証明書データ等も確認してください。FFmpegコマンドとVOICEVOXエンジン、
Whisperモデルは同梱していません。任意で導入したソフト・モデル・音声にはそれぞれの条件があります。
Voice試験版にはPyAV由来のFFmpeg/コーデック共有ライブラリが入ります。
その配布条件・対応ソースの確認が未完了のため、Voice版は公開ビルドの対象外です。

`static/core/soundtouch_processor.js` is based on the bundled processor in
`@soundtouchjs/audio-worklet` version **2.1.1**, including bundled core and
worklet-base. Copyright Steve 'Cutter' Blades and contributors.

Source: https://github.com/cutterbl/SoundTouchJS

Package: https://registry.npmjs.org/@soundtouchjs/audio-worklet/-/audio-worklet-2.1.1.tgz

Package SHA-1: `93b6edf25608dbed63fae99b5ce71dd60198bf7d`

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain
one at https://mozilla.org/MPL/2.0/.

The full license is included in `licenses/MPL-2.0.txt`. The modified processor's
complete source is shipped as `static/core/soundtouch_processor.js` in both
the application resources and the source archive.

Local modification: export `SoundTouchProcessor` instead of registering its
default name; remove the reference to the unshipped source map. The modified
source is included in full. `pitch_processor.js` adapts ClipNest's semitone,
reset/stop, and browser-owned tempo handling. No runtime CDN is used.

# Signalsmith Stretch

`static/core/signalsmith_stretch.js` vendors Signalsmith Stretch Web **1.3.2**,
including its embedded WASM binary. MIT license; Copyright (c) 2022 Geraint Luff /
Signalsmith Audio Ltd. The complete license is in
`static/core/signalsmith_LICENSE.txt`.

Source/release: https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/main/web/release

Local modifications: explicit DSP reset/hold, transparent bypass and termination
for ClipNest seeking/cleanup; initialization rejection and a bounded startup
timeout. `quality_pitch.js` adapts native playback-rate pitch compensation and
selects 120 ms blocks / 15 ms intervals with split computation. All code and WASM
are served locally; no runtime CDN, account, or external audio upload is used.
