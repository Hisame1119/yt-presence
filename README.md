# YT-Presence

YouTube および YouTube Music の視聴状況を Discord の Rich Presence に表示するツールです。
このリポジトリには、Chrome 拡張機能とバックグラウンドで動作する常駐アプリが含まれています。

## 📥 別PCでのセットアップ方法 (最短手順)

このリポジトリをダウンロード（または `git clone`）するだけで、他のPCでもすぐに使い始めることができます。

### 1. 常駐アプリ（daemon）のインストール
リポジトリの直下にある **`yt-presence-installer.exe`** をダブルクリックして実行します。
- 黒い画面が立ち上がり、自動的にインストールとスタートアップ（自動起動）の登録が行われます。
- 「インストールが正常に完了しました！」と表示されたら Enter キーを押して閉じます。
- ※以降はPCを起動するたびに裏で自動的に実行されます。

### 2. Chrome拡張機能の導入
1. Google Chrome を開き、URLバーに `chrome://extensions/` と入力して拡張機能の管理画面を開きます。
2. 画面右上の **「デベロッパー モード」** をオンにします。
3. 画面左上の **「パッケージ化されていない拡張機能を読み込む」** をクリックします。
4. このリポジトリ内にある **`extension`** フォルダを選択します。

### 3. 初期設定（アイコンの準備）※任意
Discord側で綺麗なアイコンを表示させるために、Discord Developer Portal への画像の登録が必要です。

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス。
2. YouTube 用アプリと YouTube Music 用アプリをそれぞれ用意します。
3. 両方のアプリの `Rich Presence` -> `Art Assets` に、用意した画像（`youtube.png`, `youtube-music.png`）をアップロードします。
4. その際、画像の名前を必ず `youtube` および `youtube-music` と設定して保存してください。

## 🗑 アンインストール方法
アプリの常駐を解除したい場合は、`%APPDATA%\YT-Presence` フォルダの中にある `uninstall.bat` を実行してください。

## 💻 (開発者向け) ソースコードからビルドする場合
1. `daemon` フォルダに移動し、`go build -mod=vendor -ldflags="-H windowsgui -s -w" -o yt-presence.exe ./main.go` を実行してデーモンをビルドします。
2. `daemon/installer` フォルダに移動し、`go build -o yt-presence-installer.exe ./main.go` を実行してインストーラーをビルドします。
