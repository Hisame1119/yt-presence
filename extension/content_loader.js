/*
 * content_loader.js
 * 拡張機能コンテキストで実行される。
 * 役割:
 *   1. content.js をページコンテキストへ inject する
 *      (ページコンテキストでないと YouTube の内部 JS API にアクセスできないため)
 *   2. content.js が dispatch した CustomEvent "SendToLoader" を受け取り、
 *      chrome.runtime.sendMessage でバックグラウンドへリレーする
 */

const LOGGING = false;
const UPDATE_PRESENCE_MESSAGE = "UPDATE_PRESENCE_DATA";

// ページコンテキストの content.js からデータを受け取りバックグラウンドへ転送
window.addEventListener("SendToLoader", function (message) {
    // 拡張機能が再読み込みされると chrome.runtime が無効になる場合がある
    // その場合は送信をスキップする (YouTube タブを再読み込みすれば解消)
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return;
    }
    try {
        chrome.runtime.sendMessage({
            messageType: UPDATE_PRESENCE_MESSAGE,
            title: message.detail.title,
            author: message.detail.author,
            timeLeft: message.detail.timeLeft,
            duration: message.detail.duration,
            videoId: message.detail.videoId,
            videoUrl: message.detail.videoUrl,
            channelUrl: message.detail.channelUrl,
            applicationType: message.detail.applicationType,
            thumbnailUrl: message.detail.thumbnailUrl,
            album: message.detail.album,
        }, (response) => {
            if (LOGGING) {
                console.log("YT-Presence: content_loader -> background relay done", message.detail);
            }
        });
    } catch (e) {
        // Extension context invalidated (拡張機能再読み込み後にタブ再読み込みが必要)
        if (LOGGING) console.warn("YT-Presence: Extension context invalidated. Please reload the YouTube tab.", e);
    }
}, false);

// content.js をページの DOM へ inject する (Web Accessible Resource として登録済み)
var mainScript = document.createElement("script");
mainScript.src = chrome.runtime.getURL("/content.js");
(document.head || document.documentElement).appendChild(mainScript);
mainScript.onload = function () {
    this.remove();
};
