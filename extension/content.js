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

    const isYouTubeSite = window.location.hostname.includes("youtube.com");
    const isPrimeVideoSite = window.location.hostname.includes("primevideo.com") || window.location.hostname.includes("amazon.");

    let cachedPvTitle = "";
    let cachedPvSubtitle = "";
    let cachedPvThumbnail = "";

    if (LOGGING) console.log("YT-Presence: content.js injected into page context", { isYouTubeSite, isPrimeVideoSite });

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

    function cleanYouTubeMusicTitle(title) {
        if (!title) return title;
        const originalTitle = title;

        // 1. カッコ系の中身を除外 (【】 や [])
        let cleaned = title
            .replace(/【.*?】/g, "")
            .replace(/\[.*?\]/g, "")
            .trim();

        // 2. | や ｜ の後を除外
        cleaned = cleaned.replace(/\s*[|｜].*$/, "").trim();

        // 3. covered by や cover by などの以降を除外
        cleaned = cleaned.replace(/\s*(?:covered\s+by|cover\s+by|covered|cover)\s+.*$/i, "").trim();

        // 4. スラッシュの後のカバーアーティスト名を除外
        if (documentData.author) {
            const authorClean = documentData.author.toLowerCase().trim();
            const slashRegex = /\s*[/／]\s*(.*)$/;
            const match = cleaned.match(slashRegex);
            if (match && match[1]) {
                const afterSlash = match[1].toLowerCase().trim();
                if (afterSlash.includes(authorClean) || authorClean.includes(afterSlash)) {
                    cleaned = cleaned.replace(slashRegex, "").trim();
                }
            }
        }

        // カッコや記号の残骸をクリーンアップ
        cleaned = cleaned.replace(/^[\s(（/\\|｜]+|[\s)）/\\|｜]+$/g, "").trim();

        // 5. カバー判定
        const isCover = /cover|歌ってみた|翻唱/i.test(originalTitle);
        if (isCover) {
            if (cleaned) {
                cleaned = cleaned + " (covered)";
            }
        }

        return cleaned || title;
    }

    function applyPresenceOverrides(applicationType) {
        // 1. YouTube Music 専用の処理 (MediaSession / DOM アルバム)
        if (applicationType === "youtubeMusic") {
            if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
                const meta = navigator.mediaSession.metadata;
                if (meta.title)  documentData.title  = meta.title;
                if (meta.artist) documentData.author = meta.artist;
                if (meta.album)  documentData.album  = meta.album;
            }

            if (!documentData.album) {
                const albumLink = document.querySelector('ytmusic-player-bar a[href*="browse/MPREb"]');
                if (albumLink && albumLink.innerText) {
                    documentData.album = albumLink.innerText.trim();
                }
            }

            // リンク先を YouTube Music のドメインに変更 (重複置換を防ぐため正規表現を使用)
            if (documentData.channelUrl) {
                documentData.channelUrl = documentData.channelUrl.replace(/^(https?:\/\/)(?:www\.)?youtube\.com/, "$1music.youtube.com");
            }
            if (documentData.videoUrl) {
                documentData.videoUrl = documentData.videoUrl.replace(/^(https?:\/\/)(?:www\.)?youtube\.com/, "$1music.youtube.com");
            }
        }

        // 2. 共通のタイトルクリーンアップ (YouTube Music & YouTube)
        if (documentData.title) {
            documentData.title = cleanYouTubeMusicTitle(documentData.title);
        }
    }

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
                    documentData.album      = "";

                    applyPresenceOverrides(applicationType);

                    getTimeData();
                    sendDocumentData();
                })
                .catch(error => {
                    // oEmbed 失敗時は DOM fallback
                    getLivestreamData();
                    documentData.album      = "";

                    applyPresenceOverrides(applicationType);

                    getTimeData();
                    sendDocumentData();
                    if (LOGGING) console.error("YT-Presence: oEmbed failed, using DOM fallback", error);
                });
        } else {
            // ライブ配信: timeLeft = LIVESTREAM_TIME_ID (-1)
            getLivestreamData();
            documentData.album      = "";

            applyPresenceOverrides(applicationType);

            documentData.timeLeft = LIVESTREAM_TIME_ID;
            documentData.duration = 0;
            sendDocumentData();
        }
    }

    // ---- Prime Video 向けの処理 ----

    function cleanPrimeVideoTitle(title) {
        if (!title) return "";
        let cleaned = title;
        // Amazon/Prime Video 特有の接頭辞/接尾辞をトリム
        cleaned = cleaned.replace(/^Amazon\..*?:\s*/i, "");
        cleaned = cleaned.replace(/^Watch\s+/i, "");
        cleaned = cleaned.replace(/\s*を観る\s*\|\s*Prime\s+Video.*$/i, "");
        cleaned = cleaned.replace(/\s*\|\s*Prime\s+Video.*$/i, "");
        cleaned = cleaned.replace(/\s*-\s*Prime\s+Video.*$/i, "");
        return cleaned.trim();
    }

    function cleanPrimeVideoSubtitle(subtitle) {
        if (!subtitle) return "";
        let cleaned = subtitle.trim();
        // シーズン・エピソード接頭辞を除去
        // 日本語パターン: シーズン1、エピソード11
        cleaned = cleaned.replace(/^シーズン\s*\d+\s*[、,，]?\s*エピソード\s*\d+\s*/, "");
        // 英語パターン: Season 1, Episode 11 or Season 1, Ep. 11
        cleaned = cleaned.replace(/^Season\s*\d+\s*[、,，]?\s*(?:Episode|Ep\.)\s*\d+\s*/i, "");
        // その他の一般的なパターン (S1 E11 など)
        cleaned = cleaned.replace(/^S\d+\s*E\d+\s*/i, "");
        return cleaned.trim();
    }

    function handlePrimeVideoData() {
        // 1. 再生中の <video> 要素を探す
        const videos = Array.from(document.querySelectorAll("video"));
        const video = videos.find(v => !v.paused && v.currentTime > 0);
        if (!video) return;

        // 2. 広告再生中かチェックする
        const isAd = document.querySelector(
            ".atvwebplayersdk-adtimeindicator-text, " +
            ".atvwebplayersdk-ad-overlay, " +
            ".ad-overlay, " +
            ".ad-showing, " +
            ".videoAdUi, " +
            ".ytp-ad-player-overlay"
        ) !== null;
        if (isAd) return;

        // 3. タイトル・サブタイトルの取得
        const titleEl = document.querySelector(".atvwebplayersdk-title-text, .atvwebplayersdk-title");
        const subtitleEl = document.querySelector(".atvwebplayersdk-subtitle-text, .atvwebplayersdk-subtitle");

        let title = titleEl ? titleEl.textContent : "";
        let subtitle = subtitleEl ? subtitleEl.textContent : "";

        if (title) {
            title = cleanPrimeVideoTitle(title);
            if (title && title !== "Prime Video" && title !== "Amazon プライム・ビデオ") {
                cachedPvTitle = title;
            }
        }

        // キャッシュを優先し、なければ document.title フォールバック
        title = cachedPvTitle || cleanPrimeVideoTitle(document.title);

        if (subtitle) {
            subtitle = cleanPrimeVideoSubtitle(subtitle);
            if (subtitle) {
                cachedPvSubtitle = subtitle;
            }
        }

        subtitle = cachedPvSubtitle;

        // 時間情報の取得
        const duration = video.duration || 0;
        const currentTime = video.currentTime || 0;
        const timeLeft = duration > 0 ? (duration - currentTime) : 0;

        documentData.title = title || "Amazon Prime Video";
        documentData.author = subtitle || ""; // Discord Rich Presence の 2行目(State)にサブタイトルを表示するため author にマップ
        documentData.album = "";
        documentData.videoId = "";
        documentData.applicationType = "primeVideo";
        documentData.thumbnailUrl = cachedPvThumbnail || ""; // キャッシュした高解像度ポスター画像URLを渡す
        documentData.videoUrl = window.location.href;
        documentData.channelUrl = "";
        documentData.duration = duration;
        documentData.timeLeft = timeLeft;

        sendDocumentData();
    }

    // ---- ポーリングループ (1秒間隔) ----

    setInterval(function () {
        if (isYouTubeSite) {
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
        } else if (isPrimeVideoSite) {
            // 再生開始前でも、詳細ページ等から作品タイトルとポスターサムネイルを常時キャッシュしておく
            if (document.title && document.title !== "Prime Video" && document.title !== "Amazon プライム・ビデオ") {
                const cleaned = cleanPrimeVideoTitle(document.title);
                if (cleaned && cleaned !== "Prime Video" && cleaned !== "Amazon プライム・ビデオ") {
                    cachedPvTitle = cleaned;
                }
            }
            const titleEl = document.querySelector('[data-automation-id="title"], h1[data-testid="title"], .atvwebplayersdk-title-text');
            if (titleEl && titleEl.textContent && titleEl.textContent.trim() !== "Prime Video" && titleEl.textContent.trim() !== "Amazon プライム・ビデオ") {
                const cleaned = cleanPrimeVideoTitle(titleEl.textContent);
                if (cleaned) {
                    cachedPvTitle = cleaned;
                }
            }

            // ポスター画像を検索してキャッシュ (pv-target-images フォルダの画像が Amazon の番組/映画ポスターのCDNパス)
            const imgEl = document.querySelector('img[src*="pv-target-images/"]');
            if (imgEl && imgEl.src) {
                cachedPvThumbnail = imgEl.src;
            }

            handlePrimeVideoData();
        }
    }, NORMAL_MESSAGE_DELAY);
})();
