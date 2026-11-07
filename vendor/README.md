# vendor/

放前端运行时要用的第三方脚本，由宿主 `/dsh-live2d/vendor/*` 发出去。

| 文件 | 来源 | 说明 |
|---|---|---|
| `live2dcubismcore.min.js` | Live2D Cubism SDK for Web | **专有许可，不随本仓库分发**。按 Live2D 授权条款自行下载后放到这里 |

没有这个文件时舞台会明确报「缺 Cubism Core」，不会静默白屏。
