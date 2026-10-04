# 远程联动（手机 ↔ 桌面）

让手机和桌面互为「远程设备」：**桌面的模型能操作手机，手机的模型能操作桌面**，
外加文件互通、会话互通、模型配置共用。

两端各自有一个插件，共享同一份线路协议源码：

| 端 | 插件 | 角色 |
| --- | --- | --- |
| 桌面 | `@dsh-desktop/link` | **监听**局域网端口，等手机接入 |
| 手机 | `@dsh-android/link` | **拨号**连桌面（手机没有稳定可达地址，也不该开入站端口） |

---

## 界面（推荐用这个，不用跟模型说话）

**桌面**：设置 → **远程联动**（在「桌面」和「桌面更新」旁边）
- 点「启动服务」→ 直接显示端口、局域网地址（可复制）和 6 位配对码（大字 + 可复制）
- 看已连设备是谁、平台、链路是否已有会话密钥
- 「换一个配对码」「停止服务」

**手机**：外壳页 → **远程联动** 卡片 → 点「配对」
- 弹出三个输入框：桌面地址 / 端口 / 配对码
- 连上后卡片显示「已连接：<桌面名>」，按钮变成「断开」
- 回到外壳页会自动刷新状态（手机可能在别处断开或连上）

两边的界面走的是**同一组 HTTP 路由**：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dsh-link/status` | 状态（两端） |
| POST | `/api/dsh-link/start` \| `/stop` \| `/code` | 桌面：起服务/停服务/换码 |
| POST | `/api/dsh-link/connect` | 手机：用 host/port/code 连 |

> **鉴权**：这些路由挂在 dsh 已鉴权的 Connection 上（和 `/api/session/uploadFileBinary` 同级）。
> 浏览器加载页面时用启动 token **换了一个签名 cookie**，之后同源请求自动带上 ——
> 所以桌面页面用普通 `fetch` 即可。手机外壳是 Kotlin，得自己走这一步：
> 先 `GET /?token=...` 从 `Set-Cookie` 取 `dsh-auth-*`，再带 cookie 调路由。
> 实测：带 token 查询参数直接调是 **401**，必须换成 cookie。

## 一分钟上手（命令行方式，界面之外的备选）

**桌面**（对模型说，或在设置里）：
```
link_host_start
```
返回：
```json
{ "running": true, "port": 45731, "code": "327872",
  "addresses": ["192.168.1.10"], "codeExpiresInSeconds": 300 }
```

**手机**：
```
link_connect { "host": "192.168.1.10", "port": 45731, "code": "327872" }
```

连上之后：

| 在桌面上可以做 | 在手机上可以做 |
| --- | --- |
| `phone_status` 手机状态 | `desktop_status` 桌面状态 |
| `phone_screen_shot` 截手机屏 | `desktop_screen_shot` 截桌面屏 |
| `phone_screen_elements` 手机可点元素（精确坐标） | `desktop_screen_windows` 桌面窗口列表 |
| `phone_click` / `phone_scroll` / `phone_type` / `phone_key` | `desktop_click` / `desktop_type` / `desktop_key` |
| `phone_push_file` 推文件到手机 | `link_push_file` 推文件到桌面 |
| `link_share_model` 把桌面模型配置发给手机 | `link_pull_model` 从桌面拉模型配置 |
| — | `desktop_sessions` / `desktop_session_read` 读桌面会话 |

---

## 配对流程

```
桌面 link_host_start
  → 生成 6 位配对码（默认 5 分钟有效，一次性）
  → 手机 link_connect { host, port, code }
  → 桌面校验通过，回 welcome **并发放长期令牌**
  → 手机把令牌存进 $DSH_HOME/link/client.json
  → 之后只写 host/port，手机启动时自动用令牌重连
```

**为什么分「码」和「令牌」**：码是给人念的，必须短、且**一次性**；令牌是给机器
重连用的，长且长期有效。混成一个，要么码太长没法念，要么长期凭据太弱。

---

## 安全模型（请照实理解，别当成"端到端加密"）

| 性质 | 有没有 | 说明 |
| --- | --- | --- |
| 被动嗅探能拿到 API Key | ❌ 拿不到 | 凭据字段用握手时 **ECDH（P-256）+ HKDF** 派生的会话密钥 **AES-256-GCM** 封装后才进帧 |
| 篡改载荷能蒙混过关 | ❌ 不能 | GCM 校验会失败 |
| 防中间人 | ❌ **不防** | hello/welcome 里的公钥没有签名，能劫持链路的攻击者可以各换一把 |
| 局域网里猜到配对码就能连 | ✅ 能 | 所以码只有 6 位、一次性、5 分钟过期 |
| 令牌落盘是否明文 | ✅ 明文 | 存在 `$DSH_HOME/link/host.json`。能读这个文件的人本来就能读你的会话与凭据，不额外扩大暴露面 |

**所以准确的界面说法是「凭据加密传输」，不是「端到端加密」。**
要挡中间人需要预共享指纹或带外校验 —— 对「自己局域网内的两台设备」性价比太低。

> 普通消息（截图、窗口列表、点击坐标）**不加密**。它们本来就要出现在界面和你
> 的日志里，加密只会让排障变难。

---

## 共用模型

`link_pull_model { includeCredentials: true }` 会把桌面的模型配置拉到手机：

- `llm-deepseek/*` —— 模型清单与 provider 配置，**明文**传输（不含秘密）；
- `.credentials.yaml` —— **只在你明确要求时**才传，且**必须**走会话密钥密封；
  连接没有会话密钥时**直接跳过**（宁可失败也不明文送 Key）。

**落地前一律备份**成 `<文件>.linkbak`。写坏用户凭据的代价远大于多留一个文件。

只允许写这两类路径，且做越界检查 —— 白名单之外直接拒绝。

---

## 实现要点（为什么这么写）

**为什么自己写传输、不用 WebSocket**
两端都不能在安装期跑 `npm install`（手机是 nodejs-mobile，没有包管理器；桌面插件
由外壳整体落位）。Node 自带的 `net` + 行分隔 JSON（NDJSON）满足全部约束，且
分帧逻辑只有「找换行」，出错时肉眼能看懂流量。

**为什么手机是拨号方**
手机局域网地址会变（切 Wi-Fi、DHCP 续租），桌面存不住；手机也不该为这个功能开
入站端口 —— 那是把攻击面平白放大。

**为什么截图走 base64**
链路是 JSON，不能带二进制。手机侧的截图服务返回的是**文件路径**，所以由手机
读出来转 base64；桌面侧 `capture()` 返回 `{ png: Buffer, ... }`，同样是转 base64。

**为什么桌面侧的 `computer.*` 直接 import `computer-use/lib/win32.js`**
而不是用 `ctx.tools.execute` 去调它注册的工具 —— 那是给模型用的分发入口，插件
之间调用会绕开它的前置检查，而且 PTC 模式下无 `parent` 的调用会被判
`UNKNOWN_TOOL`。直接引实现层更直白，也更容易在缺它时优雅降级：缺 `computer-use`
时联动照常工作（手机仍能连上、文件仍能传），只是 `computer.*` 明确报一句
「桌面 computer-use 插件不可用」。

**协议副本为什么要防漂移**
两端各带一份源码副本，一旦不一致就会出现「桌面按新协议发、手机按旧协议解」——
两端各自都自洽，只有连起来才错。`scripts/link-protocol-copies.test.mjs` 逐字节比对。

---

## 代码放在哪（两个仓库，一个规范源）

桌面侧插件同时存在于两个仓库，**规范源只有一个**：

| 位置 | 角色 |
| --- | --- |
| `dsh-android/desktop-plugins/@dsh-desktop/link` | **规范源** —— 改代码改这里。线路协议与双端集成测试都在这边 |
| `dsh-desktop/resources/dsh-plugins/link` | 分发副本 —— 外壳落位到 `profiles/node_modules/@dsh-desktop/link` |

手工同步迟早出现「一边改了另一边没改」，表现是「功能时好时坏」，最难查。所以：

```bash
node scripts/sync-desktop-plugin.mjs   # 规范源 → 仓库副本 + 已安装目录
```

`scripts/link-protocol-copies.test.mjs` 会逐字节校验分发副本，不一致就红。

> `D:` 上的 `dsh-desktop` 仓库位置可用环境变量 `DSH_DESKTOP_REPO` 覆盖。

## 安装与验证

```bash
# 桌面：装进正在运行的那份 DSH Desktop
#   （会同步仓库副本、落 resources/dsh-plugins、改 desktop-patch.yml；
#     改前自动把 desktop-patch.yml 备份成 .linkbak）
npm run install:desktop-link

# 手机
npm run pack:runtime && npm run build:apk
```

**接进内置插件**靠两件事，都已完成：
1. 插件目录放进 `dsh-desktop/resources/dsh-plugins/link` —— 外壳的
   plugin-installer 会自动发现它（它扫该目录下所有带 `package.json` 的子目录，
   目标路径由 `pkg.name` 推出：`@dsh-desktop/link` → `profiles/node_modules/@dsh-desktop/link`）；
2. 在 `dsh-desktop/resources/desktop-patch.yml` 追加挂载条目 —— 那是构建期的
   补丁源文件，`scripts/pack-hot.mjs` 与 `prepare-payload.mjs` 都从它取。

测试：
```bash
npm run test:link              # 协议层：分帧/半包/双向调用/超时/令牌/密钥（16 项）
npm run test:link-integration  # 端到端：配对/双向控制/文件/会话/模型（7 项）
npm run test:link-copies       # 协议副本防漂移（3 项）
```
