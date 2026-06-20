document.addEventListener("DOMContentLoaded", () => {
    const enableToggle = document.getElementById("enableToggle");
    const filterToggle = document.getElementById("filterToggle");
    const statusDiv    = document.getElementById("connectionStatus");

    // ---- 設定の読み込み ----
    chrome.storage.local.get(["enabled", "filterEnabled"], (result) => {
        enableToggle.checked = result.enabled       !== false; // デフォルト: true
        filterToggle.checked = result.filterEnabled !== false; // デフォルト: true
    });

    // ---- 設定の保存 & バックグラウンドへ通知 ----

    enableToggle.addEventListener("change", (e) => {
        const isEnabled = e.target.checked;
        chrome.storage.local.set({ enabled: isEnabled });
        chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", enabled: isEnabled });
    });

    filterToggle.addEventListener("change", (e) => {
        const isFilterEnabled = e.target.checked;
        chrome.storage.local.set({ filterEnabled: isFilterEnabled });
        chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", filterEnabled: isFilterEnabled });
    });

    // ---- Daemon 接続状態の確認 ----
    chrome.runtime.sendMessage({ type: "GET_WS_STATUS" }, (response) => {
        if (response && response.connected) {
            statusDiv.textContent = "✓ Daemon: Connected";
            statusDiv.className   = "status connected";
        } else {
            statusDiv.textContent = "✗ Daemon: Disconnected";
            statusDiv.className   = "status disconnected";
        }
    });
});
