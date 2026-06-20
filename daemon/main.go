package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hugolgst/rich-go/client"
)

// Discord Application ID
const YouTubeClientID = "1517407446862401626"
const YouTubeMusicClientID = "1517872106094985297"
const PrimeVideoClientID = "1517904110765084824"

// LIVESTREAM_TIME_ID: ライブ配信の識別値 (拡張機能側と揃える)
const LivestreamTimeID = -1

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// ローカル接続 (拡張機能) のみ許可
		return true
	},
}

// Payload は拡張機能から受け取る JSON の最上位構造
type Payload struct {
	Action string      `json:"action"`
	Data   PayloadData `json:"data"`
}

// PayloadData は Presence を構成する動画メタデータ
type PayloadData struct {
	Title           string  `json:"title"`
	Author          string  `json:"author"`
	Album           string  `json:"album"`           // アルバム名 (YouTube Music 用)
	ThumbnailUrl    string  `json:"thumbnailUrl"`
	TimeLeft        float64 `json:"timeLeft"`        // 残り秒数。-1 はライブ配信
	Duration        float64 `json:"duration"`        // 総秒数。ライブ配信時は 0
	VideoUrl        string  `json:"videoUrl"`
	ChannelUrl      string  `json:"channelUrl"`
	ApplicationType string  `json:"applicationType"` // "youtube" | "youtubeMusic" | "primeVideo"
}

// Session は接続クライアントごとの再生状態を保持する
type Session struct {
	LastActive time.Time
	Payload    *PayloadData
}

var (
	debounceTimer *time.Timer
	mu            sync.Mutex
	lastPayload   *PayloadData

	// 複数セッション管理用の変数
	sessions   = make(map[*websocket.Conn]*Session)
	sessionsMu sync.Mutex
	activeConn *websocket.Conn

	// Discord RPC 接続状態
	discordConnected bool
	currentClientID  string
)

// ---- Discord RPC ----

func loginDiscord(clientID string) {
	err := client.Login(clientID)
	if err != nil {
		log.Printf("Discord RPC ログイン失敗 (Discord が起動していない可能性があります): %v\n", err)
		discordConnected = false
	} else {
		log.Printf("Discord RPC に接続しました (Client ID: %s)\n", clientID)
		discordConnected = true
		currentClientID = clientID
	}
}

// ---- メイン ----

func main() {
	loginDiscord(YouTubeClientID)
	defer client.Logout()

	http.HandleFunc("/", handleWebSocket)

	port := "3000"
	log.Printf("WebSocket サーバーを 127.0.0.1:%s で起動しています...\n", port)
	if err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
}

// ---- WebSocket ハンドラ ----

func getAppPriority(appType string) int {
	switch appType {
	case "primeVideo":
		return 3
	case "youtube":
		return 2
	case "youtubeMusic":
		return 1
	default:
		return 0
	}
}

func evaluateActiveSession() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	now := time.Now()
	var bestConn *websocket.Conn
	var bestPriority = -1
	var bestSession *Session

	// 1. 期限切れセッション (3秒以上更新がない) を削除
	for conn, sess := range sessions {
		if now.Sub(sess.LastActive) > 3*time.Second {
			delete(sessions, conn)
			if activeConn == conn {
				activeConn = nil
			}
		}
	}

	// 2. 現在アクティブなセッションがまだ有効 (3秒以内) かつ再生中であれば仮決定
	var activeStillValid bool
	if activeConn != nil {
		if sess, exists := sessions[activeConn]; exists && now.Sub(sess.LastActive) <= 3*time.Second && sess.Payload != nil {
			activeStillValid = true
			bestConn = activeConn
			bestSession = sess
			bestPriority = getAppPriority(sess.Payload.ApplicationType)
		}
	}

	// 3. 他のセッションを走査し、より高い優先度のセッションがあれば割り込む (Preempt)
	for conn, sess := range sessions {
		if conn == activeConn {
			continue
		}
		if sess.Payload == nil {
			continue
		}
		priority := getAppPriority(sess.Payload.ApplicationType)
		if !activeStillValid || priority > bestPriority {
			bestConn = conn
			bestSession = sess
			bestPriority = priority
			activeStillValid = true
		}
	}

	// 4. Presence の更新またはクリアの実行
	if bestConn != nil && bestSession != nil && bestSession.Payload != nil {
		activeConn = bestConn
		queueUpdate(bestSession.Payload)
	} else {
		activeConn = nil
		clearPresence()
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("WebSocket upgrade error:", err)
		return
	}
	defer func() {
		sessionsMu.Lock()
		delete(sessions, c)
		if activeConn == c {
			activeConn = nil
		}
		sessionsMu.Unlock()
		c.Close()
		evaluateActiveSession()
	}()

	log.Println("拡張機能からの接続を確立しました")
	go keepAlive(c)

	for {
		_, message, err := c.ReadMessage()
		if err != nil {
			log.Println("WebSocket read error:", err)
			break
		}

		var p Payload
		if err := json.Unmarshal(message, &p); err != nil {
			log.Println("JSON unmarshal error:", err)
			continue
		}

		log.Printf("受信アクション: %s (ApplicationType: %s)\n", p.Action, p.Data.ApplicationType)

		switch p.Action {
		case "CLEAR_PRESENCE":
			sessionsMu.Lock()
			delete(sessions, c)
			if activeConn == c {
				activeConn = nil
			}
			sessionsMu.Unlock()
			evaluateActiveSession()
		case "UPDATE_PRESENCE":
			sessionsMu.Lock()
			sessions[c] = &Session{
				LastActive: time.Now(),
				Payload:    &p.Data,
			}
			sessionsMu.Unlock()
			evaluateActiveSession()
		}
	}
}

// keepAlive は WebSocket 接続を維持するための Ping を定期送信する
func keepAlive(c *websocket.Conn) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
			return
		}
	}
}

// ---- Debounce (高頻度更新の抑制) ----

// queueUpdate は連続して届く UPDATE_PRESENCE を 2 秒デバウンスして適用する
func queueUpdate(data *PayloadData) {
	mu.Lock()
	defer mu.Unlock()

	lastPayload = data

	if debounceTimer != nil {
		debounceTimer.Stop()
	}

	debounceTimer = time.AfterFunc(500*time.Millisecond, func() {
		mu.Lock()
		p := lastPayload
		mu.Unlock()

		if p != nil {
			updateDiscordPresence(p)
		}
	})
}

// ---- Discord Presence 更新 ----

func updateDiscordPresence(data *PayloadData) {
	if data == nil {
		return
	}

	isLivestream     := data.TimeLeft == LivestreamTimeID
	isYouTubeMusic   := data.ApplicationType == "youtubeMusic"
	isPrimeVideo     := data.ApplicationType == "primeVideo"

	// ---- Client ID 動的切り替え ----
	targetClientID := YouTubeClientID
	if isYouTubeMusic {
		targetClientID = YouTubeMusicClientID
	} else if isPrimeVideo {
		targetClientID = PrimeVideoClientID
	}

	if discordConnected && currentClientID != targetClientID {
		// アプリが切り替わったので一度ログアウトして再接続する
		client.Logout()
		discordConnected = false
	}

	// Discord が切断されていれば再接続を試みる
	if !discordConnected {
		loginDiscord(targetClientID)
		if !discordConnected {
			return
		}
	}

	// ---- State: チャンネル名（"by " なし）----
	stateText := data.Author
	if isLivestream {
		stateText = "[LIVE] " + data.Author
	}

	// ---- Large Image (サムネイル or サービスアイコン) ----
	largeImage := "youtube"      // Discord App Asset のデフォルト名

	if data.ThumbnailUrl != "" {
		largeImage = data.ThumbnailUrl
	}
	if isYouTubeMusic && data.ThumbnailUrl == "" {
		largeImage = "youtube-music"
	}
	if isLivestream && data.ThumbnailUrl == "" {
		largeImage = "youtube"
	}
	if isPrimeVideo {
		largeImage = "prime-video"
	}

	// ---- Small Image (YouTube / YouTube Music サービスアイコン) ----
	// Discord Developer Portal の "Art Assets" にアップロードした画像名
	smallImage := ""
	smallText  := ""
	if isYouTubeMusic {
		smallImage = "youtube-music"
		smallText  = "YouTube Music"
	} else if isPrimeVideo {
		// Prime Video has no small image
	} else {
		smallImage = "youtube"
		smallText  = "YouTube"
		if isLivestream {
			smallText = "YouTube LIVE"
		}
	}

	// ---- Activity Type ----
	// 2 = Listening (YouTube Music), 3 = Watching (YouTube)
	activityType := 3
	if isYouTubeMusic {
		activityType = 2
	}

	// ---- Timestamps ----
	now := time.Now()
	var timestamps *client.Timestamps

	if isLivestream {
		// ライブ配信: 開始時刻のみ (エンドタイムなし)
		startTime := now
		timestamps = &client.Timestamps{
			Start: &startTime,
		}
	} else if data.Duration > 0 && data.TimeLeft >= 0 {
		// 通常動画: 再生位置から start / end を計算
		startTime := now.Add(-time.Duration((data.Duration-data.TimeLeft)*float64(time.Second)))
		endTime   := now.Add(time.Duration(data.TimeLeft * float64(time.Second)))
		timestamps = &client.Timestamps{
			Start: &startTime,
			End:   &endTime,
		}
	}

	// ---- Buttons ----
	var buttons []*client.Button
	if data.VideoUrl != "" {
		label := "Watch Video"
		if isYouTubeMusic {
			label = "Listen Along"
		} else if isLivestream {
			label = "Watch Livestream"
		} else if isPrimeVideo {
			label = "Watch on Prime Video"
		}
		buttons = append(buttons, &client.Button{
			Label: label,
			Url:   data.VideoUrl,
		})
	}
	if data.ChannelUrl != "" {
		buttons = append(buttons, &client.Button{
			Label: "View Channel",
			Url:   data.ChannelUrl,
		})
	}

	largeText := "YouTube"
	if isYouTubeMusic {
		if data.Album != "" {
			largeText = data.Album
		} else {
			largeText = "YouTube Music"
		}
	} else if isPrimeVideo {
		largeText = "Amazon Prime Video"
	}

	// ---- Activity 構築 ----
	activity := client.Activity{
		Type:       activityType, // 2=Listening (YouTube Music), 3=Watching (YouTube)
		Details:    pad(data.Title, 128),
		State:      pad(stateText, 128),
		LargeImage: largeImage,
		LargeText:  pad(largeText, 128),
		SmallImage: smallImage,
		SmallText:  smallText,
		Timestamps: timestamps,
	}
	if len(buttons) > 0 {
		activity.Buttons = buttons
	}

	err := client.SetActivity(activity)
	if err != nil {
		log.Printf("Presence 更新失敗: %v\n", err)
		// 失敗時は再接続を試みる
		discordConnected = false
	} else {
		log.Printf("Presence 更新: %s [%s]\n", data.Title, stateText)
	}
}

// ---- Presence クリア ----

func clearPresence() {
	mu.Lock()
	if debounceTimer != nil {
		debounceTimer.Stop()
	}
	lastPayload = nil
	mu.Unlock()

	err := client.ClearActivity()
	if err != nil {
		log.Printf("Presence クリア失敗 (再接続試行): %v\n", err)
		discordConnected = false
		if currentClientID != "" {
			loginDiscord(currentClientID)
		}
	} else {
		log.Println("Presence をクリアしました")
	}
}

// ---- ユーティリティ ----

// pad は Discord の文字数制限 (最大 128 文字) に合わせてトリムし、
// 1 文字未満ならゼロ幅スペースで埋める
func pad(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) == 0 {
		return "\u200b" // ゼロ幅スペース (空文字はエラーになるため)
	}
	if len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return s
}
