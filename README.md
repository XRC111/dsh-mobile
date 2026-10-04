# DSH Android

DeepSeek Harness 的 Android 原生封装：手机本地运行 `dsh web`，WebView 加载其原生 Web UI。
与 `dsh-desktop`（Windows Electron 外壳）同一设计铁律：**不修改 Harness 源码**，只做外壳。

## 架构

```
┌─ Android App (Kotlin) ────────────────────────────────────────┐
│  MainActivity  ── WebView 加载 http://127.0.0.1:<port>/?token │
│       ↑ StateFlow                                             │
│  NodeService   ── 前台服务（dataSync），轮询 node-state.json   │
│       ↑ 状态文件 (filesDir/node-state.json)                    │
│  node-runner.cpp ── JNI → node::Start()（libnode.so 专属线程） │
│       ↑                                                       │
│  launcher.cjs  ── Node 入口：                                 │
│    1. 首启解压 bundle/dsh-runtime.bin → filesDir/dsh-runtime  │
│    2. 设 DSH_HOME / NO_COLOR（与桌面版一致）                    │
│    3. 劫持 stdout：全量落 dsh.log + 抓 "dsh web: …?token=…"    │
│    4. chdir(runtimeDir) → import dsh bin.js --port 0          │
└───────────────────────────────────────────────────────────────┘
```

- **Node 运行时**：[nodejs-mobile](https://github.com/lilixu3/nodejs-mobile) v24.21.0-0
  （`libnode.so` arm64-v8a + Node 24 头文件），满足 dsh 的 `>=24.0.0` 引擎要求。
- **运行时分发**：dsh 依赖树 25,390 文件 / 169MB 打成单个 34.4MB 的 gzip tar 放
  APK assets（`.bin` 后缀），首启动由**纯 JS 流式解压器**展开到应用数据目录
  （本机实测 25,390 文件全量校验通过；Android 无 Windows 杀软丢文件问题）。

## Android 适配补丁（`assets/bundle/android-patch.yml`）

不碰 Harness 源码，走 `--patch` 覆盖层（与桌面 `desktop-patch.yml` 同机制）：

| 裁剪项 | 原因 |
| --- | --- |
| `hmr` | 需要 `--expose-internals`，嵌入式 Node 无法注入；桌面版已验证可安全禁用 |
| `session-telemetry-otel` | 遥测默认关闭 + 切断 @opentelemetry 深层依赖（启动崩溃最大来源） |
| `attachment-local` | **不再禁用** —— 见下方「会话创建失败」一节：禁用它会掐断 `ctx.attachments`，导致整条会话链不可用。sharp 走 stub 透传 |
| `directory-picker` → browse | 钉到纯 fs 的 browse 实现（host + client 成对挂载） |

## 子进程：用回内置 Provider（**不需要原生 addon**）

> ⚠️ **这一节是结论修正。** 早先这里实现过 `@dsh-android/subprocess-rs`
> （基于 `@rs-cross-spawn/android-arm64` 的原生 addon），前提是「Android 上不能用
> `child_process.spawn`」。**那个前提是错的。**
>
> 设备实测（launcher 启动自检）：
> ```
> native self-check: child_process /system/bin/sh -> status=0 stdout="CHILD_OK\n10130"
> ```
> `10130` 就是应用自己的 uid。原因是把两件事混成了一件：
> Android 10 禁的是 **app 私有目录内**的 execve，而 `/system/bin/sh` 在**系统分区**，
> 本来就能 exec。
>
> 真正挡住内置 Provider 的是 `node-pty` 的顶层 import —— 那个早就用 stub 解决了，
> 而且它实际是 `createLazyRequire` **懒加载**，只有终端功能才碰。
>
> 所以现在恢复用 `@deepseek-ai/dsh-subprocess-local`，交付物里**一个原生 addon 都没有**。
> `subprocess-rs` 的源码留在仓库里供参考与单测，但由 `pack-runtime.mjs` 的
> `EXCLUDED_PLUGINS` 排除，**不随 APK 落位** —— 它依赖的那个 addon 有 41 个未解析的
> `napi_*` 符号，在嵌入式 libnode 下 dlopen 必然失败（libnode 是从 APK 直接映射的，
> `DT_NEEDED "libnode.so"` 找不到可绑定的对象）。
>
> 下面保留原实现的说明，仅作背景。

### 原实现（subprocess-rs，已不随包发布）

`dsh-subprocess-local` 走 `node:child_process`，在 Android 上被两件事卡死：
顶层静态 import `node-pty`（无 `prebuilds/android-arm64`），且 POSIX 路径末端
是 `posix_spawn`/`execve`，而 Android 10 起**移除了 app 主目录的执行权限**。

本仓库自带一个符合 seam 的替代 Provider，注册为同一个 `ctx.subprocess`
服务，因此**所有消费方（bash executor / LSP host / PTC / subagent）代码不变**，
替换只是 profile 补丁里的一行：

```yaml
- id: subprocess
  disabled: true
- insert:
    - id: subprocess-rs
      name: '@dsh-android/subprocess-rs'
```

> 补丁行不能改 `name`（loader 校验 name 不一致会跳过整条），所以只能
> `disabled` + `insert`，不是改名。

### 底座：fork + execvp（**不是** dlopen）

底座是 `@rs-cross-spawn/android-arm64@0.1.4`（napi-rs，Rust `std::process::Command`
实现）。对 `rs-cross-spawn.node` 做符号分析确认：它 `fork()` 后走 **`execvp()`**
（配 CLOEXEC 错误管道），**不使用 `dlopen()`**，也不依赖 libuv——所以能装进没有
`node` 可执行文件的嵌入式运行时。

⚠️ **由此得到一个必须如实说明的结论**：既然它本质仍是 fork+exec，就**并不能
突破 app 主目录的 exec 禁令**。真正能起的只有 app 目录之外的系统分区二进制
（`/system/bin/sh`、toybox 小工具）；运行时自己解包到 `files/` 里的任何二进制
仍然执行不了。

换句话说，这次替换的收益是：**提供了一条 seam 合规、行为可预测的实现**，
让各消费方明确报出这个平台限制，而不是像以前那样在加载期就撞上缺失的
`node-pty` 而整个工具链不可用。命令执行能力本身仍受平台限制。

### 显式拒绝的能力（绝不静默降级）

该原生模块只暴露 stdout / stderr / exit 三个回调，**没有 stdin 写入端、没有
第四个控制 fd、没有 PTY**，所以 Provider 对下列请求一律**当场报错**：

| 请求 | 后果 | Android 上的实际情况 |
| --- | --- | --- |
| `stdio.stdin !== 'ignore'` | 拒绝 | 请求方要 exec 的也是 app 目录里的二进制 |
| `stdio.control === 'pipe'` | 拒绝 | 唯一请求方是 SSH helper，本就不可达 |
| `spawnTerminal()` | 拒绝 | app 进程没有可用 PTY，终端面为空 |

`terminate()` 对子进程发 SIGTERM，`graceMs` 后升级 SIGKILL；该模块无法对
**进程组**发信号，所以比父进程活得久的孙进程不会被回收。

bash 工具从不设 stdin（其注释写明：要 stdin 的模型请用 shell 语法），所以
bash 工具面不受影响。

### 落位：`$DSH_HOME/profiles/web/node_modules/`

插件由 `launcher.cjs` 在 dsh 启动前拷进 **profile 目录**的 `node_modules`
（`$DSH_HOME/profiles/web/node_modules/@dsh-android/subprocess-rs/`），带指纹戳，
源没变就跳过复制。

基准是 profile 目录而不是运行时目录：boot 把 Loader 的 `ctx.baseUrl` 设成
profile 根，插件树解析裸包名就以它为准。装错位置的实际报错长这样：

```
Cannot find package '@dsh-android/subprocess-rs'
  imported from .../dsh-home/profiles/web/
```

实测装到 `<runtimeDir>/node_modules` 时该行必然 `failed to import`；装到
profile 下才挂得上（未激活条目 10 → 3）。

### shell 执行器：`@dsh-android/bash-mksh`

`dsh-bash-local` 把 argv 硬编码成 `['bash','-c',command]`（lib/index.js:142），
`dsh-bash-sandbox` 只是继承它、不改 argv —— 沙箱分支同样写死 bash。而 **Android
根本没有 bash**：系统 shell 是 mksh，挂在 `/system/bin/sh`。

新插件只改 shell 二进制这一件事，`executeArgv`（输出预算、spill、
SIGTERM→SIGKILL 阶梯、deadline、结果装饰）全部复用 harness 自己的实现：

```js
async execute(spec) {
  const shell = await resolveShell()          // bash 优先，否则 sh
  return this.executeArgv(spec, [shell, '-c', spec.command])
}
```

`danger-full-access` 分支由继承来的 `SandboxBashExecutor` 委派给 `super.execute()`，
所以覆盖这一个方法就同时改掉了受限与不受限两条路径，不复制任何沙箱逻辑。

补丁里同时显式禁用 `bash-sandbox` **和** `pwsh-sandbox`：`ctx.shell` 只有一个实现，
`pwsh-sandbox` 在 Android 上按 platform 判定本应禁用，但它先注册上之后
`bash-mksh` 只能报 `service "shell" has been registered at <SandboxPwshExecutor>`。
显式钉死，不依赖 platform 判定的隐式行为。

单测 `npm run test:bash-mksh`（4 项：只有 sh 时用 sh、有 bash 时优先 bash、
都没有时明确报错并列出候选、PATH 为空时同样报错而不是产出 undefined）。

### ⚠️ 三个坑（实机日志带出来的）

**1. `--expose-internals` 是必需的，不是优化。**
dsh 的 profile 解析层（`dsh-app-boot` 的 `installRuntimeInterception` →
`internalModules()`）要 `require('internal/modules/esm/loader')` 这类内部模块来
接管模块解析。正常 Node 走 `requireBuiltin(内部 id)` 桥接，所以
`cordis-plugin-loader` 把那次调用包在 `try/catch` 里兜底。Android 上桥接不可用，
错误直接冒出来，整个 harness 死在 `host preparation failed`。

`launcher.cjs` 给 Worker 传 `execArgv: ['--expose-internals']` 走 `require(id)` 分支
（Worker 线程会继承，已实测）。

**2. `node-addon-require-builtin` 必须打 stub。**
它的 optionalDependencies 只有 darwin/linux/win32 三个平台，**没有
android-arm64** → `createEntryApi()` 在模块顶层就抛 `No usable native binding`。
而 `dsh-app-boot` 的 `internalModules()` 是**无条件** require 它的（不 try/catch），
所以缺了它连插件树都还没开始挂就 fatal。

`pack-runtime.mjs` 注入 `scripts/require-builtin-stub/`：把 `requireBuiltin`
落到普通 `require` 上（依赖上面的 `--expose-internals`），没开 flag 时抛一个指明
缺哪个 flag 的错误，而不是伪装成功。

**3. `!!js` 里的三元表达式必须整体加引号。**
```yaml
# ✗ 错：`: 'ask'` 被 YAML 当成紧凑映射的 key
policy: !!js (x ?? 'y') === 'z' ? 'never' : 'ask'
# ✓ 对
policy: !!js "(x ?? 'y') === 'z' ? 'never' : 'ask'"
```
不写引号的后果是 `approval` 整条 ValidationError：
`$.policy expected "ask" | "never" but got {"[object Object]":"ask"}`，
进而把 `permission` 一起拖成 pending。

### 沙箱模式钉成 `danger-full-access`（3c 节）

`dsh-sandbox-local` 的 Linux 链是 bwrap → landlock，Android 上两者都不存在，
`confine()` 会 **fail closed** 抛 `SANDBOX_UNAVAILABLE`：默认 workspace-write 下
**每条 bash 命令都会以"沙箱不可用"失败**。

所以补丁把默认模式钉成 `danger-full-access`——这是**如实声明而非放宽**：Android
应用沙箱（独立 uid + SELinux 域）本身就是真正的边界，DSH 自己的文件策略在这个
平台上没有内核手段可强制。`approval` 随之变成 `never`（已无"更宽模式"可升级审批）。
仍尊重 `DSH_PERMISSION_MODE` 环境变量，便于实机验证时改回 workspace-write 观察
fail-closed 行为。

原生依赖勘察结论（2026-09-24，dsh 0.1.5-rc.2）：

- `koffi`：全部用途都在 `process.platform === 'win32'` 分支内懒加载，注释明说
  "non-Windows processes never load Koffi" → **Android 上无害**。
- `node-addon-require-builtin`：`cordis-plugin-loader` 里 try/catch 兜底，
  无二进制时走 "no-internals path" → **无害**。
- `node-pty`：`dsh-subprocess-local` 顶层静态 import，加载时找
  `prebuilds/android-arm64/pty.node` → **缺文件，命令执行工具链不可用**。
  v0.1.0 已改为整条换掉 subprocess Provider（见上节），不再加载
  `dsh-subprocess-local`，因此不再撞上这个缺失的 `node-pty`；但终端/PTTY
  能力依旧没有（Provider 显式拒绝 `spawnTerminal`）。
- `dsh-win32-process` / `dsh-sandbox-windows-acl`：Win32 专用包，顶层有 koffi
  类型定义 + ABI guard（size 校验），Android 上根本装不起来 → `pack-runtime`
  自动把它们替换成**同名导出的空壳包**，只维持 import 链可加载，其 API 在
  Android 上永不被调用。已校验 3 处静态 import 全部覆盖（runner 7 个、
  index 2 个、sandbox-local 4 个导出名）。
- `sharp`：见上表，已 patch 禁用。

### 打包瘦身（EXCLUDED_DIRS）

运行时从 dsh 0.1.5-rc.2 升到 0.1.7-rc.2 后，`libreoffice-kit-win32-x64`（182MB）
和 `sherpa-onnx-win-x64`（22MB）等按平台解析的 optionalDependency 被一并带进来
（无静态 import，纯运行时按需 require）。`pack-runtime.mjs` 的 `EXCLUDED_DIRS`
把它们和其他平台变体全部排除：25,550 文件 / 201MB 展开 → **tar.gz 43.9MB**。

## mobile_use（无障碍操作手机）

对应桌面版的 `@dsh-desktop/computer-use`。工具名与桌面**刻意保持一致**
（`screen_shot` / `screen_elements` / `mouse_click` / `mouse_scroll` /
`key_press` / `key_type`），模型在两端的行为习惯可直接迁移。

宿主侧是 `MobileUseService`（`AccessibilityService`），提供截屏、节点树、
手势、全局按键、文本输入。

### 启用

状态页有「开启 mobile_use」按钮 → 跳系统无障碍设置 → 打开「DSH」的开关。

⚠️ 无障碍服务**无法由应用自行开启**，也没有任何运行时权限弹窗能授予它；
连 adb 都要写 secure settings（普通应用无权写）。所以只能引导用户手动拨开关。

### 为什么走文件桥

服务是 Android 组件（主线程侧），dsh 工具跑在**本进程的 Node 线程**里。
同进程但没有 JS↔Java 通道 —— `node-runner.cpp` 只负责 `node::Start`，
没有把 `JNIEnv` 暴露给 JS 的机制。三个选项：

| 方案 | 结论 |
| --- | --- |
| Unix domain socket | 延迟最低，但 `LocalServerSocket` 与 libuv 的 AF_UNIX 互通性**无法在开发机上验证**，赌不起 |
| JNI 双向桥 | 要写 `.node` 原生模块，工程量与风险都大 |
| **文件请求/响应** | ✅ 纯 File IO，两端都是最稳的 API |

协议（`filesDir/mobile-use/`）：请求 `<id>.req`、响应 `<id>.res`，双方都
**先写 `.tmp` 再 rename**（保证读到的一定是完整 JSON），各自读走后删除。
单次往返约 60-120ms —— 对「看一眼→动一下」的 UI 自动化节奏完全够用。

### 安全（两道闸）

1. **注册闸**：默认只注册只读工具（截图/元素/状态）。要点击和输入必须在
   patch 的 `config.allowInput` 里显式打开 —— 实测 `{}`/`undefined`/
   `allowInput:false` 都只注册 3 个，只有 `true` 才注册 7 个。
2. **系统闸**：无障碍服务只能由用户在系统设置里手动开启，关掉即彻底失效。

每个操作都追加一行 `filesDir/mobile-use.log`，便于事后追溯模型做了什么。

单测 `node plugins/@dsh-android/mobile-use/test/bridge.test.mjs`（4 项，
用假服务验证请求格式、原子写、响应读取、超时清理）。


## 外壳页（MiuiX）

应用启动后先看到**外壳页**，不自动打开 dsh 的 Web UI —— 那是引擎的界面，
不是这个应用的主页。外壳页管状态、工作区、mobile_use、日志，要用了再点「进入 DSH」。

界面用 [MiuiX](https://github.com/compose-miuix-ui/miuix)（小米 MIUI 设计语言的
Compose Multiplatform 实现）写，在小米机型上观感与系统设置一致。
WebView 仍是经典 View，两者在同一 Activity 里共存（`ComposeView` 叠在 `FrameLayout` 里）。

### 引入 MiuiX 的三个坑

1. **Kotlin 版本必须对齐**：miuix 0.7.2 用 Kotlin **2.2.21** 产出，本项目原本是
   2.2.20，低版本编译器读它的 metadata 会报 "compiled by a newer Kotlin"。
   已把 Kotlin 与 `org.jetbrains.kotlin.plugin.compose` 都提到 2.2.21。
   选 0.7.2 而不是最新的 0.8.8，是因为 0.8.8 要求 Kotlin 2.3.20 + Compose 1.10.3。
2. **`foundation` 要显式声明**：MiuiX 的 POM 把
   `org.jetbrains.compose.foundation:foundation` 标成 **runtime** scope，
   编译期拿不到 `Column` / `padding` / `PaddingValues` 这些符号，
   报一堆 "Unresolved reference"。必须自己加 `implementation`。
3. **界面层与 Android API 解耦**：`ShellScreen.kt` 只吃 `ShellState`（不可变数据类）
   和 `ShellActions`（lambda 集合），不认识 Activity、不认识 `NodeState`。
   `MainActivity` 负责把状态读成 `ShellState` 推进 Compose。

### APK 体积

加 Compose + MiuiX 后 APK 从 145.2MB **降到 119.8MB** —— 不是变小的错觉：
之前 dex 是**未压缩存储**的，这次打包方式变了，dex 改为 deflate（16MB → 6.2MB）。
Compose 自身净增约 3-4MB dex，被压缩收益盖过去了。

回归测试：`npm run test:provider`（14）、`npm run test:bash-mksh`（4）、
`npm run test:mobile-use`（4）。


## dsh 设置（外壳里调）

外壳页的「dsh 设置」区可以直接改 dsh 自己的启动配置，不用去编 YAML：

| 设置 | 作用 |
| --- | --- |
| 权限模式 | `sandbox-policy.mode` —— 完全访问 / 仅工作区可写 / 只读 |
| mobile_use 允许输入 | `mobile-use.allowInput` —— 关掉后只留截屏与读取界面元素 |

改完写进 `filesDir/dsh-user-patch.yml`，重启应用生效。

### ⚠️ 为什么不是写 `$DSH_HOME/cordis.patch.yml`

dsh 文档说 home 层「applied over every profile's own layer」，直觉上该写那里。
**实测它被 `--patch` 压过。** 用 `--dump-config` 验证：

```
dsh --profile web --patch android-patch.yml --dump-config
# → sandbox-policy.mode 仍是 android-patch.yml 的值，
#   行尾标注 "patched by cordis.patch.yml, android-patch.yml"（按应用顺序）
```

所以外壳设置必须走**自己的 `--patch`，并排在 `android-patch.yml` 之后**：

```js
const dshArgv = ['--profile', 'web', '--patch', patch]
if (fs.existsSync(userPatch)) dshArgv.push('--patch', userPatch)
dshArgv.push('--no-open', '--port', '0')
```

靠顺序赢，而不是靠 home 层的名义优先级。已用 `--dump-config` 确认三项设置都生效。

### ⚠️ 补丁是整块替换 config，不是深合并

`applyEntryPatches` 对非 insert 行做的是 `target[key] = value` —— 给 `config`
就会**整个换掉**原来的 config。所以生成补丁时每一行都必须把它要保留的键写全，
漏掉的键会退回插件 schema 的默认值（比如 `sandbox-policy` 必须同时写
`mode` 和 `workspaceRoot`）。

## 工作区（用户指定文件夹）

默认工作区是应用私有目录，用户看不见也带不走。现在可以选一个真实文件夹：

1. 状态页（引擎未就绪时）有「工作区：<路径>」按钮；
2. 想放到共享存储（如 `/sdcard/Documents/dsh`）需要 **「所有文件访问权」**
   （`MANAGE_EXTERNAL_STORAGE`）。这是特殊权限，**不能弹窗授予**，只能跳
   `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION` 让用户在设置页手动打开；
   不授予也能用，工作区就留在私有目录内。
3. 授权后弹出内置目录浏览器（`FolderPicker`）选目录，选择存 SharedPreferences，
   同时写一份到 `filesDir/.workspace`；
4. 重启应用生效（正在跑的会话不该被后台改 cwd）。

**为什么不用 SAF 的 `ACTION_OPEN_DOCUMENT_TREE`**：它返回 `content://` URI，
而 dsh 要的是真实文件系统路径（`process.chdir` / `fs` / bash 的 `cwd` 都吃路径）。
有了「所有文件访问权」后直接遍历 `File` 树反而更简单也更正确。

**生效链路**（一处 chdir 同时改掉文件 API 与命令执行）：

```
UI 选择 → SharedPreferences + filesDir/.workspace
       → launcher.cjs resolveWorkspace() 校验后 process.chdir(工作区)
       → 补丁 workspaceRoot: process.cwd()  → 即工作区
       → ① dsh-api-workspace-files 拿它做文件作用域根
         ② tool-bash 的 resolveWorkdir 以 policyWorkspaceRoot 为默认 cwd
```

路径不可用（不存在/不是目录/不可写）时**退回私有目录并记日志**，绝不让引擎
因为一个坏路径起不来 —— UI 侧也先做 `isUsable` 校验，把问题挡在设置之前。


## 会话创建失败（attachments 缺失）

实机症状：新建会话直接失败

```
新建会话失败：gateway/service-unavailable:
typert gateway: session/create: active Service "sessionController" is unavailable
```

根因不在 sessionController，而在它上游的 **`attachments` 服务根本没人提供**。
`ctx.attachments` 只有 `dsh-attachment-local` 提供，而我早先因为「它顶层 import sharp，
而 libvips 没有 Android 预编译」就把整条插件 `disabled: true` 了 —— 这是错的：

- sharp 本来就有 `pack-runtime` 注入的 **stub**（透传式变换，无 libvips）；
- 该插件在 stub 下能正常加载（实测 22 个导出齐全）；
- 禁用它的连带代价是整条依赖链 pending：
  `session-controller` → `file-upload` / `ui-deliverables` / 会话创建。

改成**保持启用**后，启动日志从「3 个条目未激活」变成**一条警告都没有**，
`session/create` 可用。

教训：用「整个插件禁用」解决一个**库依赖**问题，代价会顺着服务依赖图放大。
有 stub 就该用 stub。


## Android 平台适配：两处「上游假设桌面」的硬编码

### flock：白名单漏了 android（已修）

实机症状：**本轮运行失败 / flock is not supported on android-arm64**

根因在 `@deepseek-ai/node-addon-system/lib/flock.js` 第一行：

```js
if (platform !== 'linux' && platform !== 'darwin') throw ...
```

而 Android 上报的 `process.platform` 是 **`'android'`** —— 直接被拦。但 Android
本就是 Linux，bionic 提供 `<sys/file.h>` 的 `flock(2)`。这不是平台能力问题，
纯粹是白名单没写 android，却挡住了 `dsh-session-persistence-jsonl` 的会话写锁。

官方只发布 darwin/linux 四个 platform 包，且 linux 版按 glibc/musl 分目录 ——
**两者在 Android 上都加载不了**（bionic 既非 glibc 也非 musl，DT_NEEDED 对不上）。
所以只能自己编：

- `scripts/build-flock-addon.mjs`：用 NDK 把上游自带的 `src/flock.c` 编成
  android-arm64（只编 flock.c —— 它自带 `NAPI_MODULE_INIT` 且只导出 `tryLock`；
  landlock-run 是独立入口，Android 上用不了）；产物 11KB，仅依赖 `libc.so`/`libdl.so`。
- `scripts/node-addon-system-flock/flock.js`：把 android 加进白名单，并按 bionic
  解析单文件（不再走 glibc/musl 子目录）。

`pack-runtime.mjs` 把两者注入运行时。**这不是打桩，用的是真的 `flock(2)`。**

#### ⚠️ 嵌入式 libnode 下 .node 插件必须能解析 napi_\*

第一次跑仍然失败：

```
dlopen failed: cannot locate symbol "napi_create_function" referenced by
  .../node-addon-system-android-arm64/bin/system.node
```

桌面 node 里 addon 能解析 `napi_*`，是因为符号由**主可执行文件**导出，而主可执行
文件天然在全局符号组。这里是嵌入式 `libnode.so`：`System.loadLibrary` 默认
**RTLD_LOCAL**，libnode.so 只是 node_runner 的依赖，符号不进全局组 —— 于是所有
dlopen 进来的 addon 都找不到 napi_*。

两处修复，建议都留着：

1. **`node-runner.cpp` 的 `JNI_OnLoad` 里 `dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL)`**
   —— 把已加载的 libnode.so 提升进全局组。**这一次修好所有插件**，包括第三方
   预编译 `.node`（那些我们没有源码、没法重链）。
2. `build-flock-addon.mjs` 给 system.node 链接 `-lnode`，让它的 DT_NEEDED
   里明确写上 `libnode.so`（libnode 的 SONAME 就是这个名字，运行时会绑到已加载那份）。

> 注意：这个坑对 `@rs-cross-spawn/android-arm64` 同样成立（它有 41 个未解析的
> napi 符号、DT_NEEDED 里也没有 libnode）。它是**懒加载**的，所以在第一次真正
> spawn 之前不会暴露 —— 上面第 1 条修的就是它。

### pnpm：插件管理器在 Android 上无法工作（已关闭）

实机症状：在「添加插件」里输入包名，报

```
Command failed with EACCES: pnpm view … spawn pnpm EACCES
```

`dsh-plugin-manager` 的每一步都是 `execa('pnpm', [...])`，需要一个**可执行的**
包管理器。Android 上这条路是死的：

1. 运行时里根本没有 pnpm；
2. 就算有，app 主目录（`/data/user/0/<pkg>/files`）在 Android 10+ 禁 exec；
3. 运行时里也没有 node CLI —— `libnode.so` 是**库**不是可执行文件，
   所以「用 node 跑 pnpm.js」同样不通。

因此把 `plugin-manager` 显式关闭。关掉是安全的：消费方都写成
`ctx.get('pluginManager') === undefined ? {} :`（见 dsh-host-plugin-inventory），
少了它只是 UI 报 `managementAvailable=false`，没有连锁 pending。

### 装插件走构建期

把插件包放进本仓库 `plugins/<scope>/<name>/`，`pack-runtime.mjs` 的
`stageShellPlugins()` 会校验 `package.json.name` 与入口文件后一起落位到
APK 的 `assets/bundle/plugins/`，`launcher.cjs` 再拷进
`$DSH_HOME/profiles/web/node_modules/`。

插件可以自带嵌套 `node_modules`（原生 `.node` 二进制也随包走）。
要挂载它，在 `android-patch.yml` 里加一行 insert 即可。


### 硬链接：app 永远建不了（已改为独占创建）

实机症状：**本轮运行失败**

```
EACCES: permission denied, link '.../session.v4.jsonl.zstd.<hash>.tmp'
  -> '.../session.v4.jsonl.zstd'
```

AOSP SELinux 策略里有一条 neverallow：

```
# Do not allow untrusted_app to hard link to any files.
# Hard links also contribute to security bugs.
neverallow untrusted_app app_data_file:file link;
```

**app 进程永远不能在私有目录建硬链接**，与平台权限、targetSdk、用户授权都无关
（和 Android 10 的 exec 禁令同一类）。而 `dsh-session-persistence-jsonl` 用 `link()`
做「**独占发布**」：目标已存在时 link 报 `EEXIST`，调用方据此判定冲突。

`scripts/patch-session-link.mjs` 把那一处换成等价实现：

1. 先试 `link()` —— 支持硬链接的平台上不复制字节，更省；
2. 只有 `EACCES`/`EPERM`/`EOPNOTSUPP`/`ENOTSUP` 才回落；
3. 回落路径用 `open(currentPath, 'wx')`（`O_CREAT|O_EXCL`）**独占创建**，
   创建动作本身是原子的，输的一方同样拿到 `EEXIST` —— 语义完全保持。

其它错误（如 `ENOSPC`）不回落，直接抛，避免掩盖真正的问题。

该补丁对原文做**精确匹配替换**：dsh 升级后若这段实现变了，pack-runtime 会**报错
退出**而不是静默跳过 —— 静默跳过正是之前几次事故的共同模式。

单测 `npm run test:session-link`（5 项）。它从**打进运行时的那份代码**里把函数抽出来跑，
而不是复制一份实现，所以测的是产物本身。

## ⚠️ 构建产物陷阱：APK 会留旧字节

把一个更小的 APK 写到已存在的大 APK 上时，写入方**不截断**文件，旧 APK 中段
会留下不属于任何 zip 条目的孤儿字节。实测：

```
真实内容 119.8MB  →  写出 163.6MB（中段 43.8MB 是孤儿）
```

APK 仍可解析、可安装，但体积虚高且极难排查（zip 目录表完全自洽）。
`scripts/build-apk.mjs` 现在**先删旧产物**再调 Gradle。

## 首次构建（clone 下来怎么跑起来）

### 1. 前置

| 需要 | 说明 |
| --- | --- |
| Windows | 只支持 Windows：打包用的 dsh 运行时是 win32 平台的产物 |
| JDK 17+ | 有 `JAVA_HOME` 更好；没有则让 Gradle 自行探测 |
| Android SDK | platform 36、build-tools 36.1.0 |
| Android NDK | `28.2.13676358` |
| CMake | `3.22.1` |
| Node.js 22+ | 跑打包脚本 |

NDK 与 CMake 可从 Google 仓库取（**校验 SHA1 后再用**）：

| 组件 | 归档 | SHA1 |
| --- | --- | --- |
| NDK r28c | `android-ndk-r28c-windows.zip` | `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d` |
| cmake 3.22.1 | `cmake-3.22.1-windows.zip` | `292778f32a7d5183e1c49c7897b870653f2d2c1b` |

NDK 解压后目录名是 `android-ndk-r28c`，**需重命名为 `28.2.13676358`**。

写 `local.properties`（不进仓库）：

```properties
sdk.dir=C:\\path\\to\\Android\\SDK
```

### 2. 补齐两个大体积构建输入

仓库**刻意不含**它们（合计 200MB+，都能再生成）：

| 文件 | 大小 | 怎么来 |
| --- | --- | --- |
| `.vendor/nodejs-mobile-android.zip` | 74MB | 从 [lilixu3/nodejs-mobile](https://github.com/lilixu3/nodejs-mobile) releases 下载，解压到 `.vendor/nodejs-mobile-android` |
| `app/src/main/jniLibs/arm64-v8a/libnode.so` | 84MB | 取上一个解压产物里的 `bin/arm64-v8a/libnode.so` |
| `dsh-runtime.bin` | 44MB | **不用手动准备** —— 由 `pack-runtime.mjs` 从一份 win32 的 dsh 运行时打包生成 |

那份 win32 dsh 运行时这样给：

```powershell
# 装一份 DSH Desktop，然后把它自带的运行时指出来
$env:DSH_RUNTIME_SRC = "C:\\path\\to\\DSH Desktop\\resources\\dsh-runtime"
```

（也可以在 win32 上自己 `npm install` 一份 —— 但必须在 win32 上跑，因为要拉
win32 专属的可选依赖。）

### 3. 构建

```powershell
# 打包运行时（生成 app/src/main/assets/bundle/dsh-runtime.bin）
node scripts/pack-runtime.mjs

# 本机验证解压器（模拟手机首启链路，逐文件比对）
node scripts/verify-runtime.mjs

# 构建 APK
node scripts/build-apk.mjs
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

### 关于 Gradle

一律走 `node scripts/build-apk.mjs`，它按这个顺序找 Gradle：

1. **仓库自带的 wrapper**（`./gradlew`，已随仓库提交，推荐）
2. `$DSH_GRADLE` 指定的路径
3. PATH 上的 `gradle`

`GRADLE_USER_HOME` 依次尝试：`$GRADLE_USER_HOME` → `$DSH_GRADLE_HOME` →
`D:/Android/.gradle` → `~/.gradle` → 仓库内 `.gradle-home`，
挑**第一个已经有 `wrapper/dists` 的**，避免 wrapper 联网重下 220MB。

> ⚠️ `gradle/wrapper/gradle-wrapper.properties` 里的 `distributionUrl` **不能随便改**：
> wrapper 用它算哈希决定缓存目录，换 URL 会让缓存失效并触发重新下载。
> 本仓库这个 URL 与哈希 `2x09zxy9y9fz2e9j6blrf3xag` 对应，是腾讯云镜像。

### 两个容易踩的坑

⚠️ **assets 里的 gzip 包必须用 `.bin` 后缀**：AAPT2 会把 `.gz` 后缀的 assets
解压存储并去掉 `.gz`（36MB tar.gz → APK 内 190MB 裸 tar，且文件名变化）。
解压器带魔数嗅探（`1f 8b`），两种形态都能解。

⚠️ **APK 会留旧字节**：把一个更小的 APK 写到已存在的大 APK 上时，写入方不截断，
中段会留下几十 MB 孤儿字节（119.8MB 的产物写成 163.6MB，仍可安装但体积虚高）。
`build-apk.mjs` 每次先删旧产物。

## 远程联动（手机 ↔ 桌面）

让手机和桌面互为「远程设备」：**桌面的模型能操作手机，手机的模型能操作桌面**，
外加文件互通、会话互通、模型配置共用。详见 [`docs/REMOTE-LINK.md`](docs/REMOTE-LINK.md)。

| 端 | 插件 | 角色 |
| --- | --- | --- |
| 桌面 | `@dsh-desktop/link` | **监听**局域网端口，等手机接入 |
| 手机 | `@dsh-android/link` | **拨号**连桌面（手机地址会变，也不该开入站端口） |

配对：桌面 `link_host_start` 生成 6 位码（一次性、5 分钟）→ 手机 `link_connect` →
桌面发放长期令牌 → 之后自动重连。

**界面**：桌面「设置 → 远程联动」；手机外壳页「远程联动」卡片。两边走同一组 HTTP 路由。

> **安全边界（照实说）**：凭据字段用握手时 ECDH 派生的会话密钥 AES-256-GCM 封装，
> 被动嗅探拿不到 API Key；但**不防中间人**（公钥没有签名）。所以是「凭据加密传输」，
> 不是端到端加密。普通消息（截图、坐标）是明文。

## 现状与限制

可用：dsh Web UI 全部界面、会话管理、文件/文本附件上传（file chooser）、
交付物下载（DownloadManager）、目录浏览（browse）、外部链接转系统浏览器。

不可用 / 待办：

- **执行 app 目录内的二进制**（平台硬限制，与权限/Android 版本无关）：能跑系统分区
  二进制（`/system/bin/sh`、toybox），跑不了运行时解包到 `files/` 里的任何程序。
- **硬链接**（SELinux `neverallow`）：app 永远建不了硬链接，受影响的 4 个包共 6 个
  调用点已在构建期改成「独占创建」（`scripts/patch-hardlinks.mjs`），语义等价。
- **bash 方言差异**：`bash-mksh` 改用 mksh 跑命令，能覆盖绝大多数 POSIX 命令，
  但 bash 特有语法（`[[ ]]`、数组、`local -n`、process substitution `<(...)`）
  在 mksh 下不成立。模型写的脚本若依赖这些会失败。
- **stdin / control 通道 / 终端**：内置 Provider 没有 PTY 实现（`node-pty` 是 stub）。
  非终端路径不受影响 —— `bash` 工具走的就是非终端 spawn。
- 图片压缩附件（sharp，需 libvips Android 移植，暂无计划）
- release 签名 / CI
- token 失效（dsh 重启）时的引导重配 UI

## 安装使用

1. `adb install app-debug.apk` 或直接把 APK 传到手机安装（arm64 设备）。
2. 首次启动会显示「解压运行时」，一次性，预计 1-3 分钟。
3. 就绪后自动进入 dsh Web UI。通知栏常驻「DSH 引擎」前台服务（防 phantom killer）。
4. 日志排查：`adb shell run-as com.dshdesktop.android cat files/dsh.log`。
