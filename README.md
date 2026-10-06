<div align="center">

# DSH Mobile

**DeepSeek Harness 的 Android 原生移植 — 手机本地运行 dsh，无需 Root**

与 [dsh-desktop](https://github.com/XRC111/dsh-desktop) 同一设计铁律：**不修改 Harness 源码，只做外壳**。

[![Release](https://img.shields.io/github/v/release/XRC111/dsh-mobile?label=Release&style=flat-square)](https://github.com/XRC111/dsh-mobile/releases/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%208.0%2B-3DDC84?style=flat-square)](#)
[![Arch](https://img.shields.io/badge/Architecture-arm64--v8a-orange?style=flat-square)](#)

</div>

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [架构设计](#架构设计)
- [Android 适配补丁](#android-适配补丁)
- [子进程与 Shell](#子进程与-shell)
- [Mobile Use（手机操作）](#mobile-use手机操作)
- [工作区](#工作区)
- [DSH 设置](#dsh-设置)
- [远程联动](#远程联动)
- [从源码构建](#从源码构建)
- [排障指南](#排障指南)
- [现状与限制](#现状与限制)
- [致谢](#致谢)
- [License](#license)

---

## 功能特性

### 核心能力

- **本地完整运行** — 手机上跑完整的 dsh web，不是远程连接、不是精简版，无需 Root
- **原生 Web UI** — WebView 加载 dsh 自带的 Web 界面，功能完整
- **零外部依赖** — 内嵌 Node 运行时（libnode.so）和完整 dsh 依赖树，装 APK 即用
- **前台服务保活** — dataSync 类型前台服务承载引擎，防国产 ROM 后台查杀
- **MiuiX 界面** — 外壳页采用小米 MIUI 设计语言（Compose Multiplatform 实现）

### Mobile Use

模型可以通过无障碍服务操作手机本身：

| 能力 | 工具 | 说明 |
|---|---|---|
| 截屏 | `screen_shot` | 走 API 30+ 系统接口，无需 MediaProjection |
| 读取界面元素 | `screen_elements` | 无障碍节点树，精确坐标 |
| 点击 | `mouse_click` | dispatchGesture 模拟手势 |
| 滑动 | `mouse_scroll` | 自定义路径/时长 |
| 输入文本 | `key_type` | 直接设置焦点控件文本 |
| 全局按键 | `key_press` | Back / Home / 最近任务 / 通知栏 |

工具名与桌面版 Computer Use 刻意保持一致，模型行为习惯可直接迁移。

### 其他功能

- **自定义工作区** — 可把工作目录设到共享存储（如 `/sdcard/Documents/dsh`），支持目录浏览
- **权限模式切换** — 图形界面调整 dsh 沙箱策略，无需手写 YAML
- **文件/附件上传** — WebView 文件选择器，支持系统文件选择
- **交付物下载** — 走系统 DownloadManager，带 cookie
- **外部链接** — 站外链接自动交给系统浏览器
- **远程联动** — 与 dsh-desktop 配对后，手机可操作桌面、桌面可操作手机

---

## 快速开始

### 安装

1. 下载最新 APK（[Releases](https://github.com/XRC111/dsh-mobile/releases)）
2. 传到手机或通过 adb 安装：

```bash
adb install app-debug.apk
```

> 仅支持 **arm64-v8a**（绝大多数 2019 年后的手机）。需要 Android 8.0（API 26）以上。

### 首次启动

1. 打开应用，首次会**解压内置运行时**（约 1–3 分钟，仅一次）
2. 解压完成后引擎自动启动
3. 点「进入 DSH」打开完整 Web UI
4. 通知栏常驻「DSH 引擎」前台服务（防止后台被杀）

### 外壳页说明

应用启动后先看到外壳页（不自动进 Web UI），在这里管理：

- 引擎运行状态
- 工作区目录选择
- Mobile Use 开关
- dsh 权限模式
- 远程联动配对
- 日志查看

---

## 架构设计

```
┌─ Android App (Kotlin + Compose) ───────────────────────────────┐
│                                                                │
│  MainActivity                                                  │
│    ├─ ShellScreen (Compose + MiuiX)  外壳页                     │
│    └─ WebView                        加载 dsh Web UI            │
│         ↑ StateFlow                                            │
│                                                                │
│  NodeService (前台服务 dataSync)                                │
│    ├─ 拷贝 APK assets 到 filesDir                              │
│    ├─ 启动 Node 线程                                           │
│    └─ 轮询 node-state.json 同步状态                             │
│         ↑                                                      │
│  node-runner.cpp (JNI)                                         │
│    └─ node::Start() → libnode.so 专属线程                       │
│         ↑                                                      │
│  launcher.cjs (Node 入口)                                      │
│    1. 首启解压 dsh-runtime.bin → filesDir/dsh-runtime           │
│    2. 设置 DSH_HOME / NO_COLOR / PATH 等环境                    │
│    3. 插件落位到 profile node_modules                           │
│    4. 原生模块自检                                              │
│    5. Worker 线程启动 dsh web --port 0                          │
│    6. 解析 stdout 拿到 URL + token，写状态文件                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 运行时分发

- **Node 引擎**：libnode.so（arm64-v8a），由 APK 直接映射加载
- **dsh 依赖树**：25,000+ 文件 / 约 170 MB 解压后，gzip 压缩到约 44 MB 放 APK assets
- **首启解压**：纯 JS 流式解压器（不依赖系统工具），展开到应用私有数据目录
- **更新策略**：运行时随 APK 版本更新，assets 指纹按内容 CRC32 校验（不是只比大小）

---

## Android 适配补丁

补丁文件：`assets/bundle/android-patch.yml`，通过 `--patch` 参数传给 dsh（与桌面版同机制）。

### 裁剪与调整项

| 条目 | 处理 | 原因 |
|---|---|---|
| `hmr` | 禁用 | 模块热重载需要开发环境，桌面/移动端均不需要 |
| `session-telemetry-otel` | 禁用 | 默认关闭遥测，同时切断 @opentelemetry 深层依赖（启动崩溃常见来源） |
| `sandbox-policy` | 覆盖 config | Android 无 bwrap/landlock，默认钉为 danger-full-access（见下） |
| `approval` | 覆盖 config | danger-full-access 下 approval 为 never |
| `bash-sandbox` | 禁用 + insert bash-mksh | Android 没有 bash，改用系统 mksh |
| `pwsh-sandbox` | 显式禁用 | 防止它先注册 shell 服务导致 bash-mksh 无法挂载 |
| `plugin-manager` | 禁用 | Android 上无法 exec pnpm/node，插件管理走构建期 |
| `directory-picker` | 禁用 + insert browse | 钉到纯 fs 的 browse 实现（host + client 成对） |
| `mobile-use` | insert | 手机操作插件 |
| `link` | insert | 远程联动插件 |
| `diag` | insert | Android 兼容性诊断工具 |

### 沙箱模式说明

dsh 的 Linux 沙箱链是 **bwrap → landlock**，Android 上两者都不存在。`confine()` 会 fail-closed 抛出 `SANDBOX_UNAVAILABLE`，默认 workspace-write 模式下**每条命令都会失败**。

因此补丁默认钉为 `danger-full-access`，这是**如实声明而非放宽安全策略**：

- Android 应用沙箱（独立 UID + SELinux 域）本身就是真正的安全边界
- dsh 自己的文件策略在这个平台上没有内核手段可强制执行
- 仍支持 `DSH_PERMISSION_MODE` 环境变量覆盖（用于实机验证 fail-closed 行为）

---

## 子进程与 Shell

### 子进程 Provider

**结论：使用 dsh 内置的 `dsh-subprocess-local`，不需要自研原生 addon。**

早期曾实现 `@dsh-android/subprocess-rs`（基于 Rust napi 原生模块），前提是"Android 不能用 child_process.spawn"。**那个前提是错的**：

- Android 10 禁止的是**应用私有目录内**的可执行文件 execve
- `/system/bin/sh`、toybox 等在**系统分区**的二进制本来就能执行
- 设备实测：`child_process.spawn('/system/bin/sh')` 返回 status=0

真正挡住内置 Provider 的 `node-pty` 顶层 import 已通过构建期 stub 解决（且它是懒加载，只有终端功能才会加载）。

**最终交付物中没有任何自研原生 addon**（除了用真实 syscall 的 flock），消除了整类"只在设备上暴露"的加载失败。

### Shell 执行器：bash-mksh

dsh 内置 bash executor 把 shell 路径硬编码为 `bash`，而 **Android 没有 bash**——系统 shell 是 mksh，位于 `/system/bin/sh`。

`@dsh-android/bash-mksh` 只覆盖 shell 路径这一件事，其余逻辑（输出预算、spill、SIGTERM→SIGKILL 阶梯、结果装饰）全部复用 dsh 实现：

```js
async execute(spec) {
  const shell = await resolveShell();  // bash 优先，否则 sh
  return this.executeArgv(spec, [shell, '-c', spec.command]);
}
```

### 构建期 Stub 注入

以下模块在打包时被替换/打桩（`pack-runtime.mjs`）：

| 模块 | 处理 | 原因 |
|---|---|---|
| `node-pty` | stub | 无 Android 预编译，终端功能不可用；bash 工具走非终端路径不受影响 |
| `sharp` (libvips) | stub（透传） | 无 Android 预编译；图片压缩退化为透传，附件功能正常 |
| `node-addon-require-builtin` | stub | optionalDependencies 无 android 平台；依赖 `--expose-internals` 走普通 require |
| Win32 专用包 | 空壳包 | 维持 import 链可加载，API 在 Android 上永不调用 |

### 平台原生适配

| 问题 | 修复 |
|---|---|
| **flock 白名单漏了 android** | 用 NDK 编译上游 `flock.c` 为 arm64（真实 `flock(2)`，不是 stub）；同时在 `JNI_OnLoad` 中 `dlopen(libnode.so, RTLD_GLOBAL)` 让 napi 符号进入全局组 |
| **硬链接被 SELinux 禁止** | `neverallow untrusted_app app_data_file:file link`；把会话持久化的硬链接发布改为 `open('wx')` 独占创建（O_EXCL），语义等价 |

---

## Mobile Use（手机操作）

### 架构：文件桥

MobileUseService 是 Android 无障碍服务（系统组件），dsh 工具跑在同进程的 Node 线程中。两者没有直接的 JS↔Java 通道，通过**文件请求/响应**通信：

```
filesDir/mobile-use/
├── <id>.req    # Node 写请求（tmp + rename 原子写）
└── <id>.res    # Service 写响应（tmp + rename 原子写）
```

选择文件桥的原因：
- Unix domain socket：LocalServerSocket 与 libuv AF_UNIX 互通性无法在开发机验证
- JNI 双向桥：需要写 .node 原生模块，工程量和风险大
- 文件 IO：两端都是最稳定的 API，单次往返约 60–120ms，对 UI 自动化节奏完全够用

### 安全：两道闸

1. **注册闸**：默认只注册只读工具（截屏/元素/状态）。点击、滑动、输入必须在设置中显式开启"允许输入"
2. **系统闸**：无障碍服务只能由用户在系统设置中手动开启，关闭即彻底失效，应用无法自行开关

每个操作都追加写入 `mobile-use.log`，可事后追溯模型执行了什么操作。

### 截屏实现

使用 API 30+ 的 `takeScreenshot()` 接口（无需 MediaProjection 授权）：

1. 系统回调返回 HardwareBuffer
2. `wrapHardwareBuffer` + `copy(ARGB_8888)` 转为软件位图
3. 压缩为 PNG 写入文件桥目录
4. 返回路径给 Node 端

---

## 工作区

### 自定义工作目录

默认工作区在应用私有目录（用户看不见、带不走）。可以选择真实文件夹：

1. 外壳页点「工作区」
2. 放到共享存储（如 `/sdcard/Documents/dsh`）需要 **「所有文件访问权」**（MANAGE_EXTERNAL_STORAGE，特殊权限，只能跳系统设置手动授予）
3. 授权后弹出内置目录浏览器（FolderPicker）选择目录
4. 选择写入 SharedPreferences + `filesDir/.workspace`
5. **重启应用生效**（正在运行的会话不应被后台改 cwd）

### 为什么不用 SAF

Storage Access Framework 返回 `content://` URI，而 dsh 需要真实文件系统路径（`process.chdir`、`fs`、shell 的 `cwd` 都吃路径）。有「所有文件访问权」后直接遍历 `java.io.File` 树更简单也更正确。

### 生效链路

```
UI 选择 → SharedPreferences + .workspace 文件
       → launcher.cjs 校验后 process.chdir(工作区)
       → 补丁 workspaceRoot: process.cwd()
       → 文件 API 作用域 + bash 默认 cwd 同时指向工作区
```

路径不可用（不存在/不是目录/不可写）时自动退回私有目录并记日志，不会让引擎因为坏路径起不来。

---

## DSH 设置

外壳页提供图形界面调整 dsh 启动配置，无需手写 YAML：

| 设置 | 对应补丁条目 | 说明 |
|---|---|---|
| 权限模式 | `sandbox-policy.mode` | 完全访问 / 仅工作区可写 / 只读（后两者在 Android 上会因沙箱缺失失败） |
| Mobile Use 允许输入 | `mobile-use.allowInput` | 关闭后只保留截屏和读取元素 |

设置同时保存 JSON（外壳回读）和生成补丁 YAML（dsh 使用），重启生效。

### 为什么补丁不写 home 层

dsh 文档说 `$DSH_HOME/cordis.patch.yml` 应用在所有 profile 层之上，但实测它被 `--patch` 覆盖层压过。因此外壳设置走**自己的 `--patch` 文件，顺序排在 android-patch.yml 之后**，靠分层顺序生效。

> **注意**：补丁是**整块替换 config，不是深合并**。生成补丁时每个条目必须把需要保留的键写全，漏掉的键会退回插件 schema 默认值。

---

## 远程联动

手机与桌面（dsh-desktop）互为远程设备：

- **手机 → 桌面**：用 `desktop_*` 工具操作桌面（截屏/窗口/点击/输入）、读取桌面会话、推送文件
- **桌面 → 手机**：桌面模型用 `phone_*` 工具操作手机（复用 mobile-use 文件桥）
- **模型配置共享**：可从桌面拉取模型配置，手机不用重复设置 API Key

### 配对流程

1. 桌面运行 `link_host_start`，生成 6 位配对码（一次性，5 分钟有效）
2. 手机外壳页点「配对」，输入桌面地址、端口和配对码
3. 桌面验证后发放长期令牌
4. 之后自动重连，不需要再次配对

网络支持：
- **直连模式**：手机和桌面在同一局域网，填桌面真实 IP
- **端口转发**：通过 EasyTier 等工具映射，地址填 127.0.0.1

### 安全边界（如实说明）

- 凭据字段（API Key 等）用握手时 ECDH 派生的会话密钥 **AES-256-GCM** 加密传输，被动嗅探拿不到
- **不防中间人攻击**（公钥没有签名验证），所以是"凭据加密传输"，不是端到端加密
- 普通消息（截图、坐标、命令）为明文
- 链路是局域网 TCP + 配对令牌，不经过第三方服务器

---

## 从源码构建

### 环境要求

| 需要 | 说明 |
|---|---|
| OS | **Windows**（打包用的 dsh 运行时是 win32 产物） |
| JDK | 17+ |
| Android SDK | Platform 36、Build-Tools 36.x |
| Android NDK | 28.2.13676358（r28c） |
| CMake | 3.22.1 |
| Node.js | 22+ |

### 准备构建输入

仓库不包含大体积二进制文件，需要准备：

| 文件 | 大小 | 获取方式 |
|---|---|---|
| `.vendor/nodejs-mobile-android/` | ~74 MB | 从 nodejs-mobile releases 下载解压 |
| `jniLibs/arm64-v8a/libnode.so` | ~84 MB | 取 nodejs-mobile 产物中的 `bin/arm64-v8a/libnode.so` |
| dsh 运行时源 | — | 安装一份 dsh-desktop，设置 `DSH_RUNTIME_SRC` 指向其 `resources/dsh-runtime` |

### 构建步骤

```powershell
# 1. 打包 dsh 运行时（生成 assets/bundle/dsh-runtime.bin）
node scripts/pack-runtime.mjs

# 2. 本机验证解压器（模拟手机首启，逐文件比对）
node scripts/verify-runtime.mjs

# 3. 构建 APK
node scripts/build-apk.mjs
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

### 测试

```powershell
npm run test:mobile-use       # 文件桥协议测试
npm run test:hardlinks        # 硬链接补丁测试
npm run test:link             # 联动协议测试
npm run test:link-copies      # 协议副本一致性
npm run audit:native          # 原生模块符号审计
```

### 构建注意事项

- assets 中的 gzip 包必须用 **`.bin` 后缀**——AAPT2 会自动解压 `.gz` 后缀文件导致 APK 体积暴涨
- 构建 APK 前**先删除旧产物**——覆盖写不截断会留下孤儿字节（小 APK 写成大文件）
- Gradle 一律走 `build-apk.mjs`，它会自动找 wrapper 和缓存目录

### 添加自定义插件

1. 把插件包放入 `plugins/<scope>/<name>/`（可含嵌套 node_modules）
2. `pack-runtime.mjs` 自动校验并打入 assets
3. 在 `android-patch.yml` 中加 insert 条目挂载

---

## 排障指南

### 日志位置

| 日志 | 路径（app 私有目录） | 内容 |
|---|---|---|
| dsh 日志 | `files/dsh.log` | launcher + dsh 全量日志 |
| Node stderr | `files/node-stderr.log` | Node 错误输出 |
| Mobile Use | `files/mobile-use.log` | 每个手机操作的记录 |
| 崩溃日志 | `files/crash.log` | 未捕获异常堆栈 |

通过 adb 读取（无需 Root）：

```bash
adb shell run-as com.dshdesktop.android cat files/dsh.log
adb shell run-as com.dshdesktop.android cat files/crash.log
```

### 常见问题

| 症状 | 原因与处理 |
|---|---|
| 启动卡在"解压运行时" | 首次解压需要几分钟；长时间卡住尝试重启，检查存储空间（需至少 500 MB 空闲） |
| 引擎启动失败 | 查看 `dsh.log` 最后几行；常见原因是运行时损坏，清除应用数据重试 |
| Mobile Use 点了没反应 | 无障碍服务只能在系统设置中手动开启，应用无法自行打开 |
| 从设置页回来状态没变 | 已知小问题，切走再切回来即刷新 |
| 工作区选不了 /sdcard | 需要先授予「所有文件访问权」，按提示跳系统设置开启 |
| 通知栏没有引擎通知 | Android 13+ 需要通知权限，不影响引擎运行 |
| bash 命令报"找不到 bash" | 应自动使用 mksh；若仍报错检查运行时是否完整，清除数据重解压 |
| 后台一会引擎就被杀 | 国产 ROM 需手动加后台白名单/允许自启动；前台服务已声明但部分 ROM 仍会限制 |

---

## 现状与限制

### 已可用

- dsh Web UI 全部界面和功能
- 会话管理、文件/文本附件上传
- 交付物/附件下载
- 目录浏览与工作区切换
- Mobile Use 全套（截屏/元素/点击/滑动/输入/按键）
- 远程联动（操作桌面、文件互通、配置共享）
- 外部链接转系统浏览器

### 平台限制（不可通过应用层解决）

| 限制 | 说明 | 已处理方式 |
|---|---|---|
| **无法执行 app 目录内二进制** | Android 10+ 禁止私有目录 execve | 只使用系统分区二进制（/system/bin/sh、toybox） |
| **无法创建硬链接** | SELinux neverallow | 改为 O_EXCL 独占创建，语义等价 |
| **无内核沙箱** | 无 bwrap / landlock | 默认 danger-full-access，依赖 Android 应用沙箱 |
| **无 bash** | 系统只有 mksh | bash-mksh 插件替换 shell 路径 |
| **无 PTY/终端** | node-pty 无 Android 版 | stub 处理；bash 工具走非终端路径不受影响 |
| **无图片压缩** | sharp/libvips 无 Android 版 | stub 透传，附件功能正常但不压缩 |

### 待完善

- Release 签名 / CI 自动构建
- 通知权限运行时请求引导
- Token 失效（dsh 重启）后的自动重配 UI
- x86/x86_64 模拟器支持（当前仅 arm64）

---

## 致谢

**作者与维护者**：[XRC111](https://github.com/XRC111)

**上游项目**：
- [DeepSeek Harness](https://github.com/deepseek-ai) — 核心运行时
- [nodejs-mobile](https://github.com/lilixu3/nodejs-mobile) — Android Node 运行时
- [MiuiX](https://github.com/compose-miuix-ui/miuix) — MIUI 风格 Compose UI 库

**姊妹项目**：[dsh-desktop](https://github.com/XRC111/dsh-desktop) — Windows 桌面版

---

## License

[MIT](./LICENSE)
