# 角色舞台（stage-app）

一个完全独立的 Live2D 呈现进程。它不知道 DSH 存在，也不需要知道。

```
npm start        # 启动，打印带令牌的地址
npm run check    # 自检：舞台在不在
```

## 它拥有什么

| 资产 | 说明 |
|---|---|
| `stage/` | 渲染层、编译器、引擎、手臂联动、资产加载 |
| `src/` | 档案、模型仓库、指令箱、能力说明、表演规则、路径安全 |
| `models/` 之外 | 模型本体不在这里：默认读 `$DSH_HOME/live2d/models`，可用 `STAGE_MODELS` 改 |
| `data/` | 语义知识、表演库、参数清单 |
| `vendor/` | Cubism Core、PIXI |
| `demo/` | 示例模型（原厂 Hiyori） |

## 接口

所有接口都要令牌：`?token=…` 或请求头 `x-stage-token`。无令牌一律 403。

| 接口 | 作用 |
|---|---|
| `GET /` | 舞台页面（令牌由服务端注入） |
| `GET /api/capabilities` | 能力与硬规矩，含渲染好的文字 |
| `GET /api/catalog` | 真实的表情/动作/手势名，表情分「情绪」与「开关」两类 |
| `GET /api/profile` | 语义档案 |
| `GET /api/model` | 页面该加载哪个 model3（目录名与资源名常常不一致） |
| `GET /api/library` | 表演库列表 |
| `POST /api/compile` | 只校验计划，不执行 |
| `POST /api/perform` | 编译并入队，返回 jobId |
| `GET /api/pending` | 页面长轮询取活 |
| `POST /api/receipt` | 页面回执进度 |
| `GET /api/state` | 是否在线、当前任务、可见性、错误 |
| `POST /api/stop` | 停止当前表演 |
| `POST /api/kill` | Kill Switch：停演 + 拒绝后续一切表演 |
| `GET /api/audit` | 审计：谁在什么时候让它演了什么 |

## 为什么它可以独立

agent-diva 的研究包把呈现与具身划成独立的 **Mirror**：

> Mirror 是 DIVA 的可替换呈现与具身前端。它消费语义状态并产生受限用户输入，
> 但默认不获得通用外部执行权。

并且明确要求把 VRM/Live2D 渲染、模型与动画资产从 Core 迁出，通过稳定合同运行。
契约的核心是一条：**Mirror 接收语义表达提示，不接收硬编码动画文件名；
动作映射由 Mirror 自己决定。**

所以对外只有语义动作（`nod`、`smile`、`expression`、`gesture`…），
具体写哪个参数、写多少、怎么补间，全在 `stage/performance-compiler.mjs` 里。

## 安全

- 只监听 loopback（`STAGE_HOST` 可改，但改之前想清楚）
- 令牌：启动时随机生成，也可用 `STAGE_TOKEN` 指定；写到 `$DSH_HOME/live2d/stage-token`，权限 0600
- 令牌落盘是有意的取舍：本机自动化要能连上，而「落一份 0600 的文件」远好过「开一个无认证端口」。
  代价是同用户下的其它进程能读到它——这里写明，不假装不存在
- 路径：所有静态访问都过 `src/safe-join.mjs`，越界与非法编码一律拒绝
- 审计与 Kill Switch 都在

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `STAGE_PORT` | `5462` | 监听端口 |
| `STAGE_HOST` | `127.0.0.1` | 监听地址 |
| `STAGE_TOKEN` | 随机生成 | 固定令牌（自动化时有用） |
| `STAGE_MODELS` | `$DSH_HOME/live2d/models` | 模型目录 |
| `STAGE_PROFILES` | `<repo>/.artifacts/stage-profiles` | 档案缓存目录 |
| `STAGE_DEPTH` | `8` | 指令箱深度 |

## 交互

| 动作 | 效果 |
|---|---|
| 移动鼠标 | 目光跟随（Cubism 自己的 focus，缩放拖动后依然落在光标上） |
| 点头部（上 1/3） | 摸头反应：脸红或 ＞＜ + 侧头/摇头 |
| 点身上 | 被拍反应：屑屑眼或点头 + 微笑 |
| 拖动 | 平移视角（至少三成留在画布里） |
| 滚轮 | 以光标为锚点缩放 |
| 双击 | 复位 |
| 触摸 | 与鼠标一致；按下即跟随目光，滑动是平移不是点击 |

反应是**本地立即播**的，不经过 agent、也不排队。正在演一段编排时不去抢——
优先级按研究包：说话 > 点击 > 待机。

### 两个踩过的坑（都留了测试）

**一、指针捕获会把后续事件改道。** `stage.mjs` 拖动时调 `setPointerCapture`，
绑在画布上的 `pointermove` 从此收不到，于是「拖了一大段再松手」被当成点击，
每次都误触发反应。点击判定因此挂在 `window` 的**捕获阶段**——先于改道目标执行。

**二、舞台内部的取数要带令牌。** 页面加载走 `/api/model` 没问题，但反应要
`loadCatalog()` 去取 `/api/profile`，那是 stage.mjs 里的裸 `fetch`，不带令牌就 403。
现在由调用方注入 `fetchImpl`：谁调用谁带凭证，渲染层不去猜令牌。

## 验证

```bash
node stage-app/tools/tap-check.mjs     # 真浏览器点一下，读数不看图
```

它会起一个无头 Chrome，读包围盒，真的点头部和身体，再拖动一段，
然后报告「点中哪个区域 / 反应起手几次 / 拖动有没有误触 / 视角有没有动」。
凭据是数字（写参数次数、帧数、轨迹条数），不是「看起来像」。

注意启动参数里**不能有 `--disable-gpu`**：那会让 WebGL 不可用，PIXI 直接起不来。
无头环境用 SwiftShader 软件渲染，慢但真实。

## 来源与许可

本仓库原为 `dsh-superagent-template` 工作区中的一个模块，现拆出来独立建仓维护。

- **来源**：本项目原创 —— 渲染层、表演编译器、引擎、指令箱、能力说明、路径安全与 Kill Switch。
- **第三方资产**：
  - `vendor/live2dcubismcore.min.js` —— Live2D Cubism SDK for Web 的 Core。**专有许可，不随本仓库分发**，
    需按 Live2D 授权条款自行获取后放入 `vendor/`（见 [vendor/README.md](vendor/README.md)）。
    本仓库的 `.gitignore` 已把它排除。
  - `vendor/pixi.min.js`、`vendor/cubism4.min.js` —— PIXI 与 pixi-live2d-display。
  - `demo/Hiyori/` —— Live2D 官方示例模型，版权归 Live2D Inc.；使用与再分发前请确认其授权条款。
