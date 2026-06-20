package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

//go:embed yt-presence.exe
var executablePayload []byte

func main() {
	fmt.Println("===========================================")
	fmt.Println("  YT-Presence インストーラー")
	fmt.Println("===========================================")
	fmt.Println("インストールを開始します...")

	// 1. APPDATA フォルダの取得
	appDataDir, err := os.UserConfigDir()
	if err != nil {
		fmt.Printf("[エラー] APPDATAフォルダの取得に失敗しました: %v\n", err)
		pause()
		return
	}

	installDir := filepath.Join(appDataDir, "YT-Presence")
	exePath := filepath.Join(installDir, "yt-presence.exe")

	// 2. フォルダ作成
	if err := os.MkdirAll(installDir, 0755); err != nil {
		fmt.Printf("[エラー] インストールフォルダの作成に失敗しました: %v\n", err)
		pause()
		return
	}

	// 3. 既存のプロセスを終了する (アップデート対応)
	fmt.Println("既存のプロセスを確認しています...")
	exec.Command("taskkill", "/F", "/IM", "yt-presence.exe").Run()
	time.Sleep(1 * time.Second) // 終了待ち

	// 4. exe の展開
	fmt.Println("ファイルを配置しています...")
	err = os.WriteFile(exePath, executablePayload, 0755)
	if err != nil {
		fmt.Printf("[エラー] ファイルの書き込みに失敗しました: %v\n", err)
		pause()
		return
	}

	// 5. スタートアップにショートカット作成
	fmt.Println("スタートアップ（自動起動）に登録しています...")
	startupDir := filepath.Join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
	shortcutPath := filepath.Join(startupDir, "YT-Presence.lnk")

	psScript := fmt.Sprintf(`
$s = (New-Object -COM WScript.Shell).CreateShortcut('%s')
$s.TargetPath = '%s'
$s.WorkingDirectory = '%s'
$s.WindowStyle = 7
$s.Save()
`, shortcutPath, exePath, installDir)

	cmd := exec.Command("powershell", "-NoProfile", "-Command", psScript)
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("[警告] スタートアップへの登録に失敗しました: %v\n%s\n", err, string(output))
	} else {
		fmt.Println("スタートアップへの登録が完了しました。")
	}

	// 6. プログラムの起動
	fmt.Println("バックグラウンドで yt-presence を起動します...")
	// 非同期で起動
	startCmd := exec.Command(exePath)
	startCmd.Dir = installDir
	err = startCmd.Start()
	if err != nil {
		fmt.Printf("[エラー] アプリの起動に失敗しました: %v\n", err)
		pause()
		return
	}

	// アンインストール用のバッチも配置しておく
	createUninstaller(installDir, shortcutPath)

	fmt.Println()
	fmt.Println("✅ インストールが正常に完了しました！")
	fmt.Println("PCを起動するたびに、YT-Presence がバックグラウンドで自動的に起動します。")
	fmt.Println("※コマンドプロンプトの黒い画面は表示されず、裏で動き続けます。")
	fmt.Println()
	pause()
}

func createUninstaller(installDir, shortcutPath string) {
	uninstallBatPath := filepath.Join(installDir, "uninstall.bat")
	batContent := fmt.Sprintf(`@echo off
chcp 65001 >nul
echo YT-Presence をアンインストールしています...
taskkill /F /IM yt-presence.exe >nul 2>&1
del "%s" >nul 2>&1
echo 削除が完了しました。このフォルダ (%s) は手動で削除してください。
pause
`, shortcutPath, installDir)
	os.WriteFile(uninstallBatPath, []byte(batContent), 0755)
}

func pause() {
	fmt.Println("Enterキーを押して終了してください...")
	var b [1]byte
	os.Stdin.Read(b[:])
}
