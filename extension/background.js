/*
 * background.js (Service Worker)
 *
 * 役割:
 *   - content_loader.js からの UPDATE_PRESENCE_DATA メッセージを受信
 *   - タイトルフィルタ (filterEnabled 設定) を適用
 *   - WebSocket 経由でローカル daemon へ Presence データを送信
 *   - ポーズ時 / 動画終了時 / タブ閉鎖時は CLEAR_PRESENCE を送信
 *   - 複数タブを tabEnabledList で管理し「最初に再生したタブ」を優先
 */

// ---- 定数 ----

const LOGGING               = true;
const WS_URL                = "ws://127.0.0.1:3000";
const UPDATE_PRESENCE_MSG   = "UPDATE_PRESENCE_DATA";
const RECONNECT_INTERVAL_MS = 10000; // 最低でも10秒間隔で再接続を試みる

// ---- WebSocket 状態 ----

let ws                  = null;
let isConnected         = false;
let lastConnectAttempt  = 0;
let pendingMessage      = null; // オフライン中は最新の1件だけ保持

// ---- Presence 状態 ----

let currentMessage  = {};
let previousMessage = {};
let lastUpdated     = Number.MAX_SAFE_INTEGER;
let isIdle          = true;

// ---- 設定 ----

let settings = {
    enabled:       true,
    filterEnabled: true, // タイトルフィルタ (【公式】, [Official] 等を除去)
    tabEnabledList: {}
};

// ストレージから設定を読み込む
chrome.storage.local.get(["enabled", "filterEnabled"], (result) => {
    if (result.enabled !== undefined)       settings.enabled       = result.enabled;
    if (result.filterEnabled !== undefined) settings.filterEnabled = result.filterEnabled;

    if (settings.enabled) connectWebSocket();
});

// ---- タイトルフィルタ ----

const FILTER_PATTERNS = [
    /【.*?】/g,
    /\[.*?\]/g,
    /（(?=[^）]*(?:official|audio|lyric|video|mv|pv|hd|teaser|trailer|公式|音源|映像|ビデオ))[^）]*）/gi,
    /\((?=[^\)]*(?:official|audio|lyric|video|mv|pv|hd|teaser|trailer))[^\)]*\)/gi,
    /[-–]\s*YouTube\s*$/i,
    /\bOfficial\s+(?:Music\s+)?Video\b/gi,
    /\bOfficial\s+Audio\b/gi,
    /\bMusic\s+Video\b/gi,
    /\bLyric(?:s)?\s+Video\b/gi,
];

function applyTitleFilter(title) {
    if (!settings.filterEnabled || !title) return title;
    let cleaned = title;
    for (const pattern of FILTER_PATTERNS) {
        cleaned = cleaned.replace(pattern, "");
    }
    return cleaned.replace(/\s{2,}/g, " ").trim() || title; // 空になったら元のタイトルを返す
}

// ---- WebSocket 接続管理 ----

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    const now = Date.now();
    if (now - lastConnectAttempt < RECONNECT_INTERVAL_MS) {
        return;
    }
    lastConnectAttempt = now;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        if (LOGGING) console.log("YT-Presence: WebSocket connected");
        isConnected = true;

        // 接続確立後にキューの最新メッセージを送信
        if (pendingMessage) {
            ws.send(JSON.stringify(pendingMessage));
            pendingMessage = null;
        }
    };

    ws.onclose = () => {
        if (LOGGING) console.log("YT-Presence: WebSocket disconnected");
        isConnected = false;
        ws = null;
    };

    ws.onerror = () => {
        if (ws) ws.close();
    };
}

function sendToServer(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        pendingMessage = msg; // 最新の1件だけ保持
        connectWebSocket();
    }
}

// ---- Presence データの構築 ----

// daemon が Discord Timestamps を組み立てられるよう timeLeft / duration を渡す
function buildPresencePayload() {
    let title = currentMessage.title || "";
    if (currentMessage.applicationType !== "primeVideo") {
        title = applyTitleFilter(title);
    }

    return {
        action: "UPDATE_PRESENCE",
        data: {
            title:           title.substring(0, 128) || "‌‌", // 空文字対策 (ゼロ幅スペース)
            author:          (currentMessage.author || "").substring(0, 128),
            thumbnailUrl:    currentMessage.thumbnailUrl || "",
            timeLeft:        currentMessage.timeLeft ?? -1,
            duration:        currentMessage.duration ?? 0,
            videoUrl:        currentMessage.videoUrl || "",
            channelUrl:      currentMessage.channelUrl || "",
            applicationType: currentMessage.applicationType || "youtube",
            album:           (currentMessage.album || "").substring(0, 128),
        }
    };
}

// ---- ポーリング: 変化があれば daemon へ送信 ----

const POLL_INTERVAL_MS         = 1000;
const IDLE_THRESHOLD_MS        = 3 * POLL_INTERVAL_MS;  // 3秒間更新がなければアイドル
const PRESENCE_REFRESH_MS      = 15000;                 // 15秒ごとにタイムスタンプ refresh
const SEEK_THRESHOLD_SECS      = 5;                     // シーク検出のしきい値 (秒)

let lastPresenceSentAt = 0;

setInterval(function () {
    if (!settings.enabled) {
        if (!isIdle) {
            sendToServer({ action: "CLEAR_PRESENCE" });
            isIdle = true;
        }
        return;
    }

    // currentMessage.scriptId が tabEnabledList にないタブはスキップ
    const tabEnabled = currentMessage.scriptId == null ||
                       settings.tabEnabledList[currentMessage.scriptId] !== false;

    const delaySinceUpdate = Date.now() - lastUpdated;

    if (!tabEnabled || delaySinceUpdate >= IDLE_THRESHOLD_MS) {
        if (!isIdle) {
            sendToServer({ action: "CLEAR_PRESENCE" });
            currentMessage.scriptId = null;
            isIdle = true;
        }
        return;
    }

    // まだ1度も有効なデータを受け取っていない場合は送信しない
    if (!currentMessage.title) {
        return;
    }

    // ---- 送信条件の判定 ----

    // (1) タイトル / 作者 / サムネイルが変化した → 即座に更新
    const metaChanged = (
        previousMessage.title        !== currentMessage.title        ||
        previousMessage.author       !== currentMessage.author       ||
        previousMessage.thumbnailUrl !== currentMessage.thumbnailUrl
    );

    // (2) シーク検出: 自然な経過と実際の timeLeft が SEEK_THRESHOLD 以上ずれていたら再送
    //    (Discord Timestamps は一度設定すれば自動カウントダウンするため通常は不要)
    let seekDetected = false;
    if (!metaChanged && previousMessage.timeLeft !== undefined && currentMessage.timeLeft !== -1) {
        const elapsed        = (Date.now() - lastPresenceSentAt) / 1000;
        const expectedLeft   = (previousMessage.timeLeft || 0) - elapsed;
        const diff           = Math.abs(expectedLeft - (currentMessage.timeLeft || 0));
        seekDetected = diff > SEEK_THRESHOLD_SECS;
    }

    // (3) 15秒ごとのリフレッシュ (Timestamps のズレを補正)
    const refreshDue = lastPresenceSentAt > 0 && (Date.now() - lastPresenceSentAt) >= PRESENCE_REFRESH_MS;

    if (metaChanged || seekDetected || refreshDue || lastPresenceSentAt === 0) {
        sendToServer(buildPresencePayload());

        previousMessage.title        = currentMessage.title;
        previousMessage.author       = currentMessage.author;
        previousMessage.timeLeft     = currentMessage.timeLeft;
        previousMessage.thumbnailUrl = currentMessage.thumbnailUrl;
        lastPresenceSentAt = Date.now();
        isIdle = false;
    }
}, POLL_INTERVAL_MS);


// ---- content_loader.js / popup からのメッセージ受信 ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // WebSocket 接続状態の照会 (popup から)
    if (message.type === "GET_WS_STATUS") {
        sendResponse({ connected: isConnected });
        return true;
    }

    // 設定変更通知 (popup から)
    if (message.type === "SETTINGS_CHANGED") {
        if (message.enabled !== undefined) {
            settings.enabled = message.enabled;
            if (!settings.enabled) {
                sendToServer({ action: "CLEAR_PRESENCE" });
                currentMessage.scriptId = null;
                isIdle = true;
            } else {
                connectWebSocket();
            }
        }
        if (message.filterEnabled !== undefined) {
            settings.filterEnabled = message.filterEnabled;
        }
        sendResponse(null);
        return true;
    }

    // Presence データ (content_loader.js から)
    if (message.messageType === UPDATE_PRESENCE_MSG) {
        if (!settings.enabled) {
            sendResponse(null);
            return true;
        }

        const tabId = sender.tab ? sender.tab.id : null;

        // 別タブが既に "アクティブ" な場合は無視
        // != null は undefined と null の両方を弾く (初期値 {} の scriptId は undefined)
        if (currentMessage.scriptId != null && currentMessage.scriptId !== tabId) {
            sendResponse(null);
            return true;
        }

        // tabEnabledList に登録されていないタブはデフォルト有効
        if (tabId !== null && !(tabId in settings.tabEnabledList)) {
            settings.tabEnabledList[tabId] = true;
        }

        if (tabId !== null && settings.tabEnabledList[tabId] === false) {
            sendResponse(null);
            return true;
        }

        currentMessage.scriptId      = tabId;
        currentMessage.title         = message.title;
        currentMessage.author        = message.author;
        currentMessage.timeLeft      = message.timeLeft;
        currentMessage.duration      = message.duration;
        currentMessage.videoId       = message.videoId;
        currentMessage.videoUrl      = message.videoUrl || ("https://www.youtube.com/watch?v=" + message.videoId);
        currentMessage.channelUrl    = message.channelUrl;
        currentMessage.applicationType = message.applicationType;
        currentMessage.thumbnailUrl  = message.thumbnailUrl;
        currentMessage.album         = message.album || "";

        lastUpdated = Date.now();
        sendResponse(null);
        return true;
    }

    return true;
});

// ---- タブ管理 ----

// タブが閉じられたらアクティブタブのみ Presence をクリア
chrome.tabs.onRemoved.addListener((tabId) => {
    // tabEnabledList から削除
    if (tabId in settings.tabEnabledList) {
        delete settings.tabEnabledList[tabId];
    }

    if (tabId === currentMessage.scriptId) {
        if (LOGGING) console.log("YT-Presence: active YouTube tab closed, clearing");
        sendToServer({ action: "CLEAR_PRESENCE" });
        currentMessage.scriptId = null;
        isIdle = true;
    }
});

function isSupportedUrl(url) {
    if (!url) return false;
    return url.includes("youtube.com") || url.includes("primevideo.com") || url.includes("amazon.co.jp") || url.includes("amazon.com");
}

// サポート対象タブが別サイトに遷移した場合もクリア
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (
        tabId === currentMessage.scriptId &&
        changeInfo.url &&
        !isSupportedUrl(changeInfo.url)
    ) {
        if (LOGGING) console.log("YT-Presence: active tab navigated away, clearing");
        sendToServer({ action: "CLEAR_PRESENCE" });
        currentMessage.scriptId = null;
        isIdle = true;
    }
});

// Chrome 起動時にタブリストをリセット
chrome.runtime.onStartup.addListener(() => {
    settings.tabEnabledList = {};
    currentMessage = {};
    isIdle = true;
});
