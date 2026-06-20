module yt-presence

go 1.26.4

// vendor ディレクトリを優先使用 (rich-go に ActivityType パッチを適用済み)

require (
	github.com/gorilla/websocket v1.5.3
	github.com/hugolgst/rich-go v0.0.0-20240715122152-74618cc1ace2
)

require gopkg.in/natefinch/npipe.v2 v2.0.0-20160621034901-c1b8fa8bdcce // indirect
