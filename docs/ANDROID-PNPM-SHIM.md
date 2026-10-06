# Android 上的 pnpm 替身（pnpm-lite）

为什么手机端装不了插件、我们怎么让它能装、以及这套东西的边界在哪。

## 一句话根因

**这台设备上不存在「可写 + 可执行」的位置**，任何 `spawn('pnpm')` 都必然失败。

不是「没装 pnpm」，是**装上也 exec 不动**。

## 实测证据

| 位置 | 可写 | 能 exec | 原因 |
| --- | --- | --- | --- |
| `/data/data/<pkg>/files` | ✅ | ❌ `exit=126` | Android 10+ SELinux `untrusted_app` 禁 app data execve |
| `/sdcard`、`/storage/emulated/0` | ✅ | ❌ `exit=126` | 挂载带 **`noexec`**（`/proc/mounts` 实证） |
| `/data/local/tmp` | ❌ | — | 不可写 |
| `/system/bin`、`/system/xbin`、`/product/bin` | ❌ | ✅ | 唯一可执行目录，只读 |

决定性的一条在市场自己的日志里 —— `.dsh-market/log.ndjson`：

```json
{"event":"setup-pnpm","detail":"corepack enable: exit=127 spawn corepack EACCES"}
{"event":"setup-pnpm","detail":"npm -g: exit=127 spawn npm EACCES"}
```

**`EACCES`（权限拒绝）而不是 `ENOENT`（找不到）**。缺文件是表象，execve 被禁才是本质 ——
所以「把 pnpm 放进设备」这条路物理上不成立。

顺带一条决定了修复能走通的分界线：

```
sh /abs/script.sh   → exit=0    ✅ 解释执行，只要能 open
PATH 找 script      → exit=126  ❌ 要 execve
./script            → exit=126  ❌
```

`/system/bin/sh` 能**读** app 目录里的脚本，但任何 PATH/execve 查找都会失败。`execa`/`spawn` 走的是后者。

## 方案：进程内实现 pnpm 语义

既然不能 execve，就在 dsh 自己的 Node 进程里做 pnpm 该做的事：

```
registry packument → 解析版本 → 下载 tarball → 校验 integrity
→ gunzip + 解 ustar → 落 node_modules → 写 package.json → 需要时写 compatibility.json
```

两个文件：

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `pnpm-lite.mjs` | `app/src/main/assets/bundle/` | 替身本体（690 行，纯 JS 零原生依赖） |
| 补丁定义 | `app/src/main/assets/nodejs-project/launcher.cjs` | 5 个挂载点 + 落位逻辑 |

启动时由 `launcher.cjs` 的 `installPnpmLite()` 落到 `$DSH_HOME/profiles/web/pnpm-lite.mjs`，
并给已装的 dshmarket 打补丁。

### 落位路径不能错

`pnpm-lite.mjs` 用**自己所在目录**推断 profile 根（`PROFILE_DIR = fileURLToPath(import.meta.url)`），
补丁里的 `import(new URL('../../../pnpm-lite.mjs', import.meta.url))` 从
`node_modules/dshmarket/lib/` 上溯三级 —— 两者指向同一个目录：`profiles/web/`。

放错层级（放进 `node_modules/` 或 `assets/`）时 pnpm-lite 找不到 profile、
dshmarket 也 import 不到它，而且**不报错**，只是安装静默失效。

## 为什么是 5 个挂载点，不是 1 个

| # | 函数 | 作用 | 不改会怎样 |
| --- | --- | --- | --- |
| 1 | 文件头 | 顶层 await 动态 import，拿到 `FAKE` | 没有 `FAKE` 变量，4 处全部语法错误 |
| 2 | `runDshPlugin` | **安装执行** | 照旧 spawn pnpm → EACCES |
| 3 | `probePnpm` | **安装前置门禁** | UI 先探测 pnpm，不可用就只显示「设置 pnpm」—— 门禁卡住，根本到不了执行 |
| 4 | `provisionPnpm` | 装 pnpm 的引导流程 | 同上 |
| 5 | `cancelActive` | UI 的取消按钮 | 点了没反应，装一半停不下来 |

只改 `runDshPlugin` 是**不够的** —— 2/3/4 一起构成「能不能开始装」的门禁。

## 失败时退回原行为（fail-open）

5 处都有 `FAKE !== null` 前置判断。`pnpm-lite.mjs` 加载失败（语法错、文件缺失）时
`FAKE` 为 `null`，**全部退回 `dsh-cli.js` 原有的 spawn 行为**。

这不是偷懒，是有意的：替身挂掉时市场照常启动，只是安装功能退化成 Android 上必然失败的
EACCES。**绝不会因为这层增强导致市场或整个 DSH 挂掉。**

## 锚点失配怎么办

锚点字符串必须与 dshmarket 源码**逐字节**一致。差一个空格就匹配不上。

匹配失败时代码会：写一条 `WARNING: dshmarket updated and N shim anchor(s) no longer match`
到 `dsh.log`，**放弃打补丁，不硬改第三方代码**。理由是硬改出来的补丁可能语法错误，
把整个市场带崩 —— 那比「安装不可用」严重得多。

所以升级 dshmarket 后如果安装突然失效，先看 `dsh.log` 里有没有这条警告。

## 自愈

市场的「更新自己」会把新版 `dsh-cli.js` 解压覆盖，补丁随之消失。所以**每次启动都检查标记**，
缺了就重打一遍。这是 `installPnpmLite()` 每次都执行的原因（带指纹戳，内容没变就跳过）。

## 验证

```bash
npm run test:pnpm-shim
```

13 项检查：文件存在、三个 JS 语法合法、`pnpm-lite.mjs` 无 CRLF/BOM（编码错了锚点全失配）、
用 launcher 里的**真实常量**打补丁 5 个挂载点全部唯一命中、打完仍是合法 JS。

### 端到端的可复现证明

不只是「锚点能匹配」。把设备上实际运行的已打补丁 `dsh-cli.js` 逆向还原成原始文件，
再用 launcher 里的补丁定义重新打一遍：

```
输入 64494 字节 → 输出 65358 字节
应用 5/5 个挂载点
SHA256 = e9cc8f7806c923ed86b040609a057e8026c2d24bf0836fcae01fa0ed6cf55a79
       = 设备上那份的 SHA256   ✓ 完全一致
```

也就是说这套补丁是**可复现的**，不是碰巧对上。

`scripts/fixtures/dsh-cli.dshmarket-1.66.8.js`（66422 字节）是未打补丁的参考源码。

## 边界（如实声明，不假装支持）

| 场景 | 状态 | 原因 |
| --- | --- | --- |
| 纯 JS 插件（npm 发布） | ✅ | 本方案目标 |
| 带原生 `.node` addon 的插件 | ❌ | Android 上 dlopen 必然失败（实测 `rs-cross-spawn.node` 缺 41 个 `napi_*` 符号；`libnode.so` 从 APK 映射，`DT_NEEDED libnode.so` 解析不到） |
| `git+` / `github:` 源 | ❌ | 无 git 可执行文件；会明确报错 |
| `postinstall` / `prepare` 生命周期 | ❌ 不执行 | execve 被禁 |
| pnpm 严格嵌套 / lockfile 语义 | ❌ | 扁平 hoisted（与 profile `nodeLinker: hoisted` 一致） |
| 安装后自动重启 | ⚠️ 手动 | HMR 关闭 + 无子进程可重启服务 |
| DSH 官方「设置 → 插件」面板 | ❌ 仍置灰 | `plugin-manager` 在 `android-patch.yml` 里 `disabled: true`，本次未动 |

## 相关但独立的一件事

内嵌的 EasyTier `.so` **不受**上面第 2 行那条 dlopen 限制影响。已实测它的
`DT_NEEDED` 只有系统库：

```
libeasytier_android_jni.so  →  liblog.so / libc.so / libdl.so
libeasytier_ffi.so          →  libc.so / libdl.so / libm.so
```

没有 `libnode.so`，走的是另一条 dlopen 路径。见 [EASYTIER-INTEGRATION.md](./EASYTIER-INTEGRATION.md)。

## 回滚

```sh
# 删掉替身，5 处补丁会因 FAKE = null 全部自动失效
rm /data/data/<pkg>/files/dsh-home/profiles/web/pnpm-lite.mjs
```

或把 `launcher.cjs` 里的 `installPnpmLite(bundleDir, homeDir)` 调用去掉 —— 它全程
`try/catch`，出问题只记一行日志，不会影响 dsh 启动。
