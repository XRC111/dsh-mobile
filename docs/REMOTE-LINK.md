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
| `link_host_devices` / `link_invoke` / `link_topology` | `link_devices` / `link_invoke` / `link_topology` |

---

## 多设备（mesh）

原先的联动是**固定一对一**：桌面起服务、手机拨号，一条连接 —— 「谁是对方」是隐含的。
多设备层（mesh）让每台设备都能回答三个问题：

| 问题 | 落在哪 | 存在哪 |
| --- | --- | --- |
| **我是谁** | `mesh-identity.js` —— 稳定 `deviceId`（X25519 公钥的 SHA-256 前 8 字节）+ 密钥对 | `$DSH_HOME/link/identity.json` |
| **我认识谁** | `mesh-registry.js` —— 已配对设备清单 | `$DSH_HOME/link/registry.json` |
| **现在连上了谁** | `mesh-manager.js` —— 运行期连接集合 | 内存 |

### 两种拓扑

| 拓扑 | 谁拨谁 | 适用 |
| --- | --- | --- |
| **star**（默认） | 桌面/hub 只 listen，各 client 拨入；client 之间不直连 | 没有 overlay 虚拟网卡时**物理上唯一可行**的 —— 手机在运营商 CGNAT 后面，别人连不进来 |
| **mesh** | 每台都 listen + 拨每一个已知 peer | 装了 EasyTier/Tailscale 等 overlay、每台都有虚拟 IP 时 |

两种模式下**工具寻址完全一样**（都是 `link_invoke({ device, ... })`），所以切换拓扑对
模型和界面是透明的。

### 不重复建连：按 deviceId 字典序仲裁

mesh 里如果两端同时互拨，会各建一条重复连接（表现为同一设备出现两次、调用结果错乱）。
办法是纯函数仲裁：

```js
shouldDial(aId, bId) === (aId < bId)   // 只有字典序小的主动拨大的
```

双方握手时都知道对方的 id，所以这个结论**不需要额外协议消息**，天然无冲突 ——
而且交换参数必然取反，不会出现「两边都拨」或「两边都不拨」。

### 自动连接（驱动）

上面那些是「能力」，**驱动**才是让它们自己动起来的部分 —— 没有它，拓扑切了也不会互连：
`dialTargets()` 只是算出一份「该拨谁」的清单，没有任何东西去拨。

驱动做三件事：

| 时机 | 动作 |
| --- | --- |
| 切到 mesh / 启动时已是 mesh | `startAutoConnect()`：开始监听 + 立刻拨一轮 |
| 每 5 秒 | 把 `dialTargets()` 逐个拨上；**连上的自动从清单消失** |
| 切回 star / 插件卸载 | `stopAutoConnect()`：关定时器、关监听、断连接 |

几个刻意的取舍：

- **退避重试，不猛拨**：对端没起来时（手机还没开机）每秒一次会白烧电量。
  失败次数越多间隔越长（2ⁿ × 基础间隔，上限 60 秒），日志也抑制（前 2 次 +
  每 5 次报一条）。连上就清零。
- **star 下手机不监听**：star 的设计前提就是「手机不做入站」，平白开端口是放大
  攻击面。切回 star 时会真的把监听关掉，不只是改个标记。
- **桌面侧只拨不听**：桌面的监听由 `link_host_start` 负责（那是用户手动的），
  驱动用 `listen: false` 只做拨号，避免起第二个监听器撞端口。
- **定时器 `unref()`**：不阻止进程退出 —— 桌面关窗口时不该被它吊住。

### 拓扑与令牌都要落盘

两个都是「用户/设备已经确立的状态」，丢了会让用户以为「设了没用」：

| 落盘内容 | 位置 | 丢了会怎样 |
| --- | --- | --- |
| 拓扑选择 | `registry.json` 的 `topology` | 重启后回到 star，而 mesh 需要**两端都是** mesh 才互连 —— 一边悄悄回落就永远连不上 |
| 本端签发过的令牌 | `tokens.json` | 对方拿着有效令牌也连不进来，只能重新配对 —— 而配对码是**一次性**的，等于每次重启都要人跑去对端点一次「换一个配对码」 |

> `tokens.json` 权限尽力设成 0600（Windows 上不支持就算了）。它和
> `host.json` 一样是明文长期凭据 —— 能读这个文件的人本来就能读 `$DSH_HOME`
> 下的会话与凭据，不额外扩大暴露面。

### 多设备寻址

多台在线时，`phone_*` / `desktop_*` 工具都接受一个可选的 `device` 参数：

- 只有一台在线 → 不用填（老行为不变）；
- 多台在线且没填 → **明确报错并列出候选**，而不是随便挑一台
  （随便挑的后果是「点错了别人的手机」，比报错严重得多）；
- 填了 deviceId 或设备名 → 打到那一台；名字有歧义时报错要求用 deviceId。

设备清单用 `link_host_devices`（桌面侧）/ `link_devices`（手机侧）查。

### 身份为什么用密钥对而不是只用令牌

令牌是**共享秘密**：一旦泄密，所有用过它的设备都能冒名顶替。密钥对是每台一对，
连接时互相验证公钥，配对过一次就长期可信，也能在注册表里明确「哪台是哪台」。

> 这不替代通道自身的 ECDH 加密（见 `secret.js`），而是**身份**层。

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

令牌同时写进 mesh 注册表（`registry.json` 的 `token` 字段），这样多设备重连
不必重新输码。注意 `toPublic()` **刻意剥掉令牌** —— 那个形态会进 HTTP 响应与 UI；
落盘用的是完整记录。落盘和对外展示是两件事。

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

## 跨网络使用（异地组网）

联动的传输层**不关心底下是什么网络** —— 它绑双栈（IPv6 + IPv4）并枚举所有网卡，
所以任何 overlay 装上就能用，不需要改代码。

### 两种接法

| 方式 | 手机填什么 | 说明 |
| --- | --- | --- |
| **直连** | 桌面的真实地址 | 局域网 IP、**公网 IPv6**，或组网工具给的虚拟 IP（如 Tailscale 的 `100.x`、EasyTier 的 `10.126.126.x`） |
| **端口转发** | **`127.0.0.1`** + 本地端口 | 用 EasyTier `--no-tun --port-forward tcp://127.0.0.1:<本地端口>/<远端虚拟IP>:45731`（或 `ssh -L`）把远端端口映射到本机 |

**这两种搞混是最容易犯的错**：填了 `127.0.0.1` 却没开转发 → 连到手机自己 → 只报
「连接被拒绝」，从报错完全看不出原因。所以插件会**交叉校验**并说清：

```
直连模式下填了回环地址 —— 这会连到手机自己，不是桌面。
如果你已经用 EasyTier/ssh 把桌面端口映射到了本机，请把连接方式改成「端口转发」。
```

界面上：桌面「设置 → 远程联动」列出地址时会**标注类型与网卡**
（`192.168.1.10 · 局域网 · 以太网` / `10.126.126.5 · EasyTier · easytier`），
并把最可能对的那个标为「推荐」；手机配对对话框里选连接方式。

### 地址标注做了什么

以前只列 IPv4、一串裸 IP，装上组网工具后用户根本不知道该填哪个。现在：

- **按网卡名识别**（最可靠）：`tailscale0` / `easytier` / `ztxxxxxxxx` / `wg0` / `docker0` …
- **按地址段辅助**（网卡名给不出结论时）：`100.64.0.0/10`（Tailscale 的 CGNAT）、
  `10.126.126.0/24`（EasyTier 默认）、`172.17.0.0/16`（Docker）… 这类标成「（可能）」，
  因为段是工具的默认值、用户可能改过。
- **机器内部网络沉底**：Docker / WSL / 虚拟机网卡是宿主机内部的，**外部设备连不到**，
  排在候选里只会误导。
- **不可用地址标出来但仍返回**：链路本地（`169.254.*`、`fe80::*`）会让用户明白
  「为什么没列出来」，而不是以为程序漏了。

### IPv6

手机在移动数据、或 IPv6-only 的 Wi-Fi 下**只有 IPv6 地址**。所以服务端默认监听
`::`（双栈，一个监听器同时收 IPv4 与 IPv6），仅在系统不支持时退回 `0.0.0.0`。

⚠️ 需要注意的一点：一台机器常同时有多个全球 IPv6，其中**临时/隐私地址会轮换**
（Windows 默认开启 `UseTemporaryAddresses`）。`os.networkInterfaces()` 拿不到
「这个地址是临时还是稳定」——那需要系统 API——所以插件**不假装能判断**，而是当
公网 IPv6 多于一个时明确提示：「如果过一阵连不上，换列表里的另一个试试」。

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
npm run test:link-netinfo      # 地址分类：组网工具识别/不误判/排序（8 项）
npm run test:link              # 协议层：分帧/半包/双向调用/超时/令牌/密钥（16 项）
npm run test:link-integration  # 端到端：配对/双向控制/文件/会话/模型（7 项）
npm run test:link-copies       # 协议副本防漂移（4 项）
npm run test:link-mesh         # mesh 核心：身份/注册表/拨号仲裁/拓扑（15 项）
npm run test:link-mesh-integration  # mesh 端到端：多设备/去重/寻址/令牌重连（5 项）
npm run test:link-mesh-driver  # mesh 驱动：自动互连/断线自愈/退避/持久化（7 项）
npm run test:link-contract     # 两端方法名与参数契约对齐（5 项）
npm run test:link-stream       # 流式调用：事件/错误/断线（4 项）
```

> mesh 的**协议副本**（`mesh-*.js`）和协议层一样逐字节校验：`deviceId` 算法与拨号
> 仲裁一旦两端不同，表现是「有时能连、有时连出两条」，比直接报错难查得多。
