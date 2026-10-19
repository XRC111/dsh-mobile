<div align="center">

# DSH Mobile

**DeepSeek Harness 的 Android 原生移植 —— 手机本地运行 dsh，无需 Root**

与 [dsh-desktop](https://github.com/XRC111/dsh-desktop) 遵循同一设计铁律：**不修改 Harness 源码，只做外壳**。

[![Release](https://img.shields.io/github/v/release/XRC111/dsh-mobile?label=Release&style=flat-square)](https://github.com/XRC111/dsh-mobile/releases/)
[![Platform](https://img.shields.io/badge/Platform-Android%208.0%2B-3DDC84?style=flat-square)](#系统要求)
[![Arch](https://img.shields.io/badge/Architecture-arm64--v8a-orange?style=flat-square)](#系统要求)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)

</div>

---

## 简介

DSH Mobile 把完整的 [DeepSeek Harness](https://github.com/deepseek-ai) 运行时搬进 Android 应用：内嵌 `libnode.so` 与 dsh 依赖树，在手机上以 Node 线程运行 `dsh web`，WebView 加载其官方界面。

不是远程连接、不是精简版，**没有 Root、没有 Termux、没有外部服务器**。

> 非官方社区移植，与 DeepSeek 官方无隶属关系。

## 目录

- [功能特性](#功能特性)
- [下载与安装](#下载与安装)
- [首次启动](#首次启动)
- [架构设计](#架构设计)
- [Android 适配](#android-适配)
- [Mobile Use](#mobile-use)
- [工作区](#工作区)
- [远程联动](#远程联动)
- [从源码构建](#从源码构建)
- [排障指南](#排障指南)
- [现状与限制](#现状与限制)
- [License](#license)

---

## 功能特性

### 核心

| 能力 | 说明 |
| --- | --- |
| **本地完整运行** | 手机上跑完整 dsh web，功能与桌面版一致 |
| **原生 Web UI** | WebView 加载 dsh 自带界面 |
| **零外部依赖** | 内嵌 Node 运行时与完整依赖树，装 APK 即用 |
| **前台服务保活** | `dataSync` 类型前台服务承载引擎，降低被 ROM 查杀概率 |
| **MiuiX 界面** | 外壳页采用 MIUI 设计语言（Compose Multiplatform） |

### Mobile Use

模型可通过无障碍服务操作手机本身：

| 能力 | 工具 | 实现 |
| --- | --- | --- |
| 截屏 | `screen_shot` | API 30+ 系统截图接口，无需 MediaProjection |
| 读取界面 | `screen_elements` | 无障碍节点树，带精确坐标 |
| 点击 | `mouse_click` | `dispatchGesture` |
| 滑动 | `mouse_scroll` | 自定义路径与时长 |
| 输入 | `key_type` | 直接设置焦点控件文本 |
| 全局按键 | `key_press` | Back / Home / 最近任务 / 通知栏 |

工具名与桌面版 Computer Use 保持一致，模型行为可直接迁移。

### 其他

- 自定义工作区（可指向共享存储，内置目录浏览器）
- 图形化切换 dsh 权限模式，无需手写 YAML
- 文件/附件上传、交付物下载（走系统 DownloadManager，带 cookie）
- 外部链接交给系统浏览器
- 与桌面版配对后双向远程操作

---

## 下载与安装

1. 从 [Releases](https://github.com/XRC111/dsh-mobile/releases) 下载最新 APK
2. 安装：

```bash
adb install app-debug.apk
```

### 系统要求

- Android 8.0（API 26）及以上
- **arm64-v8a**（2019 年后的绝大多数机型）
- 首次启动需约 500 MB 空闲空间

## 首次启动

1. 打开应用，首次会**解压内置运行时**（1–3 分钟，仅一次）
2. 解压完成后引擎自动启动
3. 点「进入 DSH」打开完整 Web UI
4. 通知栏出现常驻「DSH 引擎」前台服务

启动后先进入**外壳页**，可管理引擎状态、工作区、Mobile Use、权限模式、配对与日志。

---

## 架构设计

```
┌─ Android App (Kotlin + Compose) ───────────────────────────────┐
│  MainActivity                                                  │
│    ├─ ShellScreen (Compose + MiuiX)   外壳页                    │
│    └─ WebView                         加载 dsh Web UI           │
│                                                                │
│  NodeService (前台服务 dataSync)                                │
│    ├─ 拷贝 APK assets 到 filesDir                               │
│    ├─ 启动 Node 线程                                           │
│    └─ 轮询 node-state.json 同步状态                             │
│         ↑                                                      │
│  node-runner.cpp (JNI) → node::Start() → libnode.so            │
│         ↑                                                      │
│  launcher.cjs (Node 入口)                                       │
│    1. 首启解压 dsh-runtime.bin                                  │
│    2. 设置 DSH_HOME / PATH 等环境                               │
│    3. 插件落位到 profile node_modules                           │
│    4. 原生模块自检                                              │
│    5. 启动 dsh web --port 0                                     │
│    6. 解析 stdout 拿到 URL + token，写状态文件                  │
└────────────────────────────────────────────────────────────────┘
```

### 运行时分发

| 项 | 说明 |
| --- | --- |
| Node 引擎 | `libnode.so`（arm64-v8a），由 APK 直接映射加载 |
| dsh 依赖树 | 25,000+ 文件 / 约 170 MB，gzip 压缩到约 44 MB |
| 首启解压 | 纯 JS 流式解压器，不依赖系统工具 |
| 校验 | assets 指纹按内容 CRC32，不是只比大小 |

---

## Android 适配

补丁文件 `assets/bundle/android-patch.yml`，通过 `--patch` 传给 dsh（与桌面版同机制）。

### 裁剪与调整

| 条目 | 处理 | 原因 |
| --- | --- | --- |
| `hmr` | 禁用 | 移动端不需要热重载 |
| `session-telemetry-otel` | 禁用 | 默认关遥测，并切断深层依赖 |
| `sandbox-policy` | 覆盖 | Android 无 bwrap/landlock，见下 |
| `approval` | 覆盖 | `danger-full-access` 下为 never |
| `bash-sandbox` | 禁用 + 插入 bash-mksh | Android 没有 bash |
| `pwsh-sandbox` | 禁用 | 防止抢占 shell 服务 |
| `plugin-manager` | 禁用 | 无法 exec pnpm/node |
| `directory-picker` | 替换为 browse | 钉到纯 fs 实现 |
| `mobile-use` / `link` / `diag` | 插入 | 手机操作 / 远程联动 / 诊断 |

### 为什么默认 danger-full-access

dsh 的 Linux 沙箱链是 **bwrap → landlock**，Android 两者都没有，`confine()` 会 fail-closed 抛 `SANDBOX_UNAVAILABLE`，`workspace-write` 下每条命令都会失败。

默认钉为 `danger-full-access` 是**如实声明**：Android 应用沙箱（独立 UID + SELinux 域）本身就是安全边界。仍可用 `DSH_PERMISSION_MODE` 覆盖以验证 fail-closed 行为。

### 子进程与 Shell

- 使用 dsh 内置 `dsh-subprocess-local`：`/system/bin/sh` 在系统分区，本来就可执行
- `bash-mksh` 只覆盖 shell 路径（`bash` → `mksh`），输出预算、spill、信号阶梯全部复用上游
- 构建期对 `node-pty`、`sharp` 等无 Android 预编译的模块打桩
- 唯一自研原生代码：`flock`（真实系统调用）与 JNI 加载器

### 平台限制的绕法

| 限制 | 处理 |
| --- | --- |
| Android 10+ 禁止私有目录 execve | 只用系统分区二进制 |
| SELinux 禁止硬链接 | 改为 `O_EXCL` 独占创建，语义等价 |
| 无 PTY | stub `node-pty`，bash 工具走非终端路径 |

---

## Mobile Use

### 文件桥

无障碍服务与 Node 线程同进程但无直接 JS↔Java 通道，通过**文件请求/响应**通信：

```
filesDir/mobile-use/
├── <id>.req    # Node 写请求（tmp + rename 原子写）
└── <id>.res    # Service 写响应（tmp + rename 原子写）
```

单次往返约 60–120 ms，对 UI 自动化足够。

### 两道闸

1. **注册闸**：默认只注册只读工具（截屏/元素/状态），输入类需在设置中显式开启
2. **系统闸**：无障碍服务只能由用户手动开启，应用无法自行开关

每次操作追加写入 `mobile-use.log`，可追溯。

---

## 工作区

默认工作区在应用私有目录。可切换到共享存储（如 `/sdcard/Documents/dsh`）：

1. 需要 **「所有文件访问权」**（MANAGE_EXTERNAL_STORAGE，需跳系统设置授予）
2. 授权后用内置目录浏览器选择
3. 写入 SharedPreferences + `filesDir/.workspace`
4. **重启应用生效**

不使用 SAF 的原因：dsh 需要真实文件系统路径（`process.chdir`、`fs`、shell cwd），`content://` URI 无法满足。

路径不可用时自动退回私有目录并记日志，不会让引擎起不来。

---

## 远程联动

手机与桌面互为远程设备：

- **手机 → 桌面**：`desktop_*` 工具操作桌面（截屏/窗口/点击/输入）、读取会话、推送文件
- **桌面 → 手机**：`phone_*` 工具操作手机（复用 mobile-use 文件桥）
- **配置共享**：可从桌面拉取模型配置，手机不用重复填 API Key

### 配对

1. 桌面执行 `link_host_start`，生成 6 位配对码（一次性，5 分钟）
2. 手机外壳页输入桌面地址、端口与配对码
3. 桌面验证后发放长期令牌
4. 之后自动重连

网络：局域网直连，或通过 EasyTier 等端口转发（地址填 `127.0.0.1`）。

> 安全边界：凭据用 ECDH 派生的会话密钥 AES-256-GCM 加密传输；**不防中间人**（公钥未签名），普通消息为明文，链路不经过第三方服务器。

---

## 从源码构建

### 环境要求

| 需要 | 说明 |
| --- | --- |
| OS | **Windows**（打包用的 dsh 运行时是 win32 产物） |
| JDK | 17+ |
| Android SDK | Platform 36 / Build-Tools 36.x |
| Android NDK | 28.2.13676358 |
| CMake | 3.22.1 |
| Node.js | 22+ |

### 准备构建输入

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `.vendor/nodejs-mobile-android/` | ~74 MB | nodejs-mobile releases |
| `jniLibs/arm64-v8a/libnode.so` | ~84 MB | 同上 |
| dsh 运行时源 | — | 安装 dsh-desktop，设 `DSH_RUNTIME_SRC` 指向其 `resources/dsh-runtime` |

### 构建

```powershell
node scripts/pack-runtime.mjs     # 生成 assets/bundle/dsh-runtime.bin
node scripts/verify-runtime.mjs   # 本机模拟首启解压，逐文件比对
node scripts/build-apk.mjs        # 产物：app/build/outputs/apk/debug/app-debug.apk
```

### 测试

```powershell
npm run test:mobile-use    # 文件桥协议
npm run test:hardlinks     # 硬链接补丁
npm run test:link          # 联动协议
npm run audit:native       # 原生模块符号审计
```

### 注意事项

- assets 里的 gzip 包必须用 `.bin` 后缀，否则 AAPT2 会自动解压
- 构建前删除旧产物，避免覆盖写留下孤儿字节
- Gradle 一律走 `build-apk.mjs`

---

## 排障指南

| 日志 | 路径（app 私有目录） |
| --- | --- |
| dsh 日志 | `files/dsh.log` |
| Node stderr | `files/node-stderr.log` |
| Mobile Use | `files/mobile-use.log` |
| 崩溃日志 | `files/crash.log` |

```bash
adb shell run-as com.dshdesktop.android cat files/dsh.log
```

| 症状 | 处理 |
| --- | --- |
| 卡在"解压运行时" | 首次需几分钟；检查至少 500 MB 空间 |
| 引擎启动失败 | 看 `dsh.log` 末尾；多为运行时损坏，清除数据重试 |
| Mobile Use 没反应 | 无障碍服务需在系统设置手动开启 |
| 设置页返回后状态没变 | 已知小问题，切走再切回来 |
| 选不了 `/sdcard` | 先授予「所有文件访问权」 |
| 通知栏没有引擎通知 | Android 13+ 需通知权限，不影响运行 |
| 报"找不到 bash" | 应自动用 mksh；检查运行时完整性 |
| 后台被查杀 | 国产 ROM 需手动加白名单/允许自启 |

---

## 现状与限制

**已可用**：完整 Web UI、会话与附件、下载、工作区切换、Mobile Use 全套、远程联动、外部链接。

**平台限制（不可应用层解决）**

| 限制 | 原因 | 处理 |
| --- | --- | --- |
| 无法执行私有目录二进制 | Android 10+ execve 限制 | 只用系统二进制 |
| 无法创建硬链接 | SELinux neverallow | O_EXCL 等价实现 |
| 无内核沙箱 | 无 bwrap/landlock | 默认 full-access，依赖应用沙箱 |
| 无 bash / PTY | 系统只有 mksh | bash-mksh + stub |
| 无图片压缩 | sharp 无 Android 版 | 透传 |

**待完善**：Release 签名与 CI 自动构建、通知权限引导、Token 失效后自动重配、x86 模拟器支持。

## License

MIT

## 致谢

上游：[DeepSeek Harness](https://github.com/deepseek-ai)、[nodejs-mobile](https://github.com/lilixu3/nodejs-mobile)、[MiuiX](https://github.com/compose-miuix-ui/miuix)。

姊妹项目：[dsh-desktop](https://github.com/XRC111/dsh-desktop)。
