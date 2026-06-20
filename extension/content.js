/*
 * content.js
 * content_loader.js によってページコンテキストに inject される。
 * ページコンテキストで実行されるため YouTube の内部 JS API にアクセス可能。
 *
 * 動作:
 *   - 1秒ごとに movie_player の再生状態をポーリング
 *   - 再生中 (getPlayerState() == 1) かつ広告なしの場合のみデータ収集
 *   - 通常動画: oEmbed API でタイトル・チャンネル情報を取得 (失敗時はDOM fallback)
 *   - ライブ配信: DOMセレクタで情報を取得し timeLeft = -1 を設定
 *   - YouTube Music (music.youtube.com) にも対応
 *   - データは CustomEvent "SendToLoader" で content_loader.js へ送信
 */

(function () {
    const LOGGING = false;
    const NORMAL_MESSAGE_DELAY = 1000;
    const LIVESTREAM_TIME_ID = -1;

    // セレクタ定数 (参考: YouTubeDiscordPresence-main)
    const AD_SELECTOR                        = "div.ytp-ad-player-overlay-instream-info";
    const LIVESTREAM_ELEMENT_SELECTOR        = "div.ytp-chrome-bottom > div.ytp-chrome-controls > div.ytp-left-controls > div.ytp-time-display.notranslate.ytp-live > button";
    const MINIPLAYER_ELEMENT_SELECTOR        = "div.ytp-miniplayer-ui";
    const MAIN_LIVESTREAM_TITLE_SELECTOR     = "div.ytp-chrome-top > div.ytp-title > div.ytp-title-text > a.ytp-title-link";
    const MAIN_LIVESTREAM_AUTHOR_SELECTOR    = "#upload-info > #channel-name > #container > #text-container > #text > a";
    const MINIPLAYER_LIVESTREAM_AUTHOR_SELECTOR = "#video-container #info-bar #owner-name";
    const NO_MINIPLAYER_ATTRIBUTE            = "display: none;";
    const YES_MINIPLAYER_ATTRIBUTE           = "";

    let documentData = {};
    let videoPlayer  = document.getElementById("movie_player");

    if (LOGGING) console.log("YT-Presence: content.js injected into page context");

    // ---- Utility ----

    function getVideoId(url) {
        if (!url) return null;
        const match = url.match(/[?&]v=([^&]+)/);
        return match ? match[1] : null;
    }

    // ---- oEmbed (タイトル・チャンネル名の正式取得) ----

    const getOEmbedJSON = async (videoId) => {
        const response = await fetch(
            "https://www.youtube.com/oembed?url=http%3A//youtube.com/watch%3Fv%3D" + videoId + "&format=json"
        );
        if (!response.ok) throw new Error(response.statusText);
        return response.json();
    };

    // ---- ライブ配信 / ミニプレイヤー向け DOM fallback ----

    function getLivestreamData() {
        const miniplayerHTML = videoPlayer.querySelector(MINIPLAYER_ELEMENT_SELECTOR);
        const isMainPlayer   = !miniplayerHTML || miniplayerHTML.getAttribute("style") === NO_MINIPLAYER_ATTRIBUTE;
        const isMiniplayer   = miniplayerHTML  && miniplayerHTML.getAttribute("style") === YES_MINIPLAYER_ATTRIBUTE;

        let titleHTML  = null;
        let authorHTML = null;

        if (isMainPlayer || isMiniplayer) {
            titleHTML = videoPlayer.querySelector(MAIN_LIVESTREAM_TITLE_SELECTOR);
        }

        if (isMainPlayer) {
            authorHTML = document.querySelector(MAIN_LIVESTREAM_AUTHOR_SELECTOR);
        } else if (isMiniplayer) {
            authorHTML = document.querySelector(MINIPLAYER_LIVESTREAM_AUTHOR_SELECTOR);
        }

        documentData.title = titleHTML ? titleHTML.innerText : null;

        if (authorHTML) {
            documentData.author     = authorHTML.innerText;
            documentData.channelUrl = authorHTML.href;
        } else {
            documentData.author     = null;
            documentData.channelUrl = null;
        }
    }

    // ---- 再生時間の取得 ----

    function getTimeData() {
        const duration    = videoPlayer.getDuration    ? videoPlayer.getDuration()    : 0;
        const currentTime = videoPlayer.getCurrentTime ? videoPlayer.getCurrentTime() : 0;

        if (duration && currentTime !== undefined) {
            documentData.duration = duration;
            documentData.timeLeft = duration - currentTime;
            if (documentData.timeLeft < 0) documentData.timeLeft = 0;
        } else {
            documentData.duration = 0;
            documentData.timeLeft = null;
            if (LOGGING) console.log("YT-Presence: Unable to get timestamp data");
        }
    }

    // ---- バックグラウンドへのデータ送信 (CustomEvent 経由で content_loader.js へ) ----

    function sendDocumentData() {
        if (!documentData.title || !documentData.author) return;
        if (documentData.timeLeft === undefined || documentData.timeLeft === null) return;

        // YouTube Music 自動生成チャンネル名から " - Topic" を除去
        if (documentData.author.endsWith(" - Topic")) {
            documentData.author = documentData.author.slice(0, -8);
        }

        window.dispatchEvent(new CustomEvent("SendToLoader", { detail: { ...documentData } }));

        if (LOGGING) {
            console.log("YT-Presence: dispatched SendToLoader", documentData);
        }
    }

    // ---- メインのデータ収集ロジック ----

    function handleYouTubeData() {
        const isLivestream   = !!videoPlayer.querySelector(LIVESTREAM_ELEMENT_SELECTOR);
        const rawVideoUrl    = videoPlayer.getVideoUrl ? videoPlayer.getVideoUrl() : window.location.href;
        const videoId        = getVideoId(rawVideoUrl);
        const applicationType = window.location.href.includes("music.youtube") ? "youtubeMusic" : "youtube";

        documentData.videoId        = videoId;
        documentData.applicationType = applicationType;
        documentData.thumbnailUrl   = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : "";
        documentData.videoUrl       = videoId ? `https://www.youtube.com/watch?v=${videoId}` : window.location.href;

        if (!isLivestream) {
            // 通常動画: oEmbed で正確なタイトル・チャンネル名を取得
            getOEmbedJSON(videoId)
                .then(data => {
                    documentData.title      = data.title;
                    documentData.author     = data.author_name;
                    documentData.channelUrl = data.author_url;
                    getTimeData();
                    sendDocumentData();
                })
                .catch(error => {
                    // oEmbed 失敗時は DOM fallback
                    getLivestreamData();
                    getTimeData();
                    sendDocumentData();
                    if (LOGGING) console.error("YT-Presence: oEmbed failed, using DOM fallback", error);
                });
        } else {
            // ライブ配信: timeLeft = LIVESTREAM_TIME_ID (-1)
            getLivestreamData();
            documentData.timeLeft = LIVESTREAM_TIME_ID;
            documentData.duration = 0;
            sendDocumentData();
        }
    }

    // ---- ポーリングループ (1秒間隔) ----
    // getPlayerState() == 1 → 再生中
    // document.querySelector(AD_SELECTOR) == null → 広告なし

    setInterval(function () {
        if (!videoPlayer) {
            videoPlayer = document.getElementById("movie_player");
        }
        if (
            videoPlayer &&
            typeof videoPlayer.getPlayerState === "function" &&
            videoPlayer.getPlayerState() === 1 &&
            document.querySelector(AD_SELECTOR) === null
        ) {
            handleYouTubeData();
        }
    }, NORMAL_MESSAGE_DELAY);
})();
