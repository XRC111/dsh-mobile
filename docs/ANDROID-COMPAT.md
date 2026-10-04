# DSH on Android — 原生兼容性风险清单

> 生成方式：`npm run audit:native` 扫描交付物里全部 ELF；诊断工具 `android_diag`
> 在设备上实测加载行为。本文所有结论都标了**证据来源**，区分「已在本机验证」
> 与「需运行时验证」。

## 0. 原生资产清单（已穷举，共 3 个）

| 位置 | 文件 | 大小 | 状态 |
| --- | --- | --- | --- |
| 运行时 | — | — | ✅ **已无原生文件**（flock 改为纯 JS，见 1.3） |
| 插件 | `@rs-cross-spawn/android-arm64/rs-cross-spawn.node` | 644,952 B | ⚠️ 41 个 napi_* 未解析，靠全局符号提升兜底 |
| jniLibs | `libnode.so` | 87.6 MB | 宿主，导出 napi_*（已验证 .dynsym） |

**这个清单是穷举过的**：`node scripts/audit-native.mjs` 递归扫描运行时 + 插件 +
jniLibs，只有这 3 个。node-pty 是 stub、koffi 是 stub、sharp 是 stub ——
都不含原生二进制。

---

## P0 — 阻塞：`rs-cross-spawn.node` 缺 DT_NEEDED

**问题**：该 .node 有 **41 个未解析的 napi_* 符号**（`napi_create_function`、
`napi_add_finalizer`、`napi_get_cb_info` …），而 `DT_NEEDED` 只有
`libdl.so, libc.so` —— **没有 libnode.so**。

**触发场景**：**工具调用时**（第一次真正 spawn 子进程）。该模块是**惰性加载**的
（`native()` 在首次 `spawn()` 时才 require），所以启动和发消息都不会暴露，
第一次让模型跑命令才炸。

**症状**：与 system.node 之前完全一样 ——
```
dlopen failed: cannot locate symbol "napi_create_function" referenced by .../rs-cross-spawn.node
```

**检测**：
```bash
node scripts/audit-native.mjs
# 或在设备上让模型调用 android_diag 工具
```

**修复方向**：我们**没有它的源码**，无法重链。两条路：

1. **全局符号提升**（已实现）：`node-runner.cpp` 的 `JNI_OnLoad` 把已加载的
   `libnode.so` 以 `RTLD_GLOBAL` 提升进全局符号组，于是**所有** .node 都能解析
   napi_*，不需要各自声明 DT_NEEDED。为稳妥，裸名失败时回退到从
   `/proc/self/maps` 取绝对路径再提升。
2. 若某设备上提升仍失败：用 `patchelf --add-needed libnode.so` 直接给
   `rs-cross-spawn.node` 补 DT_NEEDED（需在 Linux/WSL 下做，本机无 patchelf）。

> **需运行时验证**：本条只能靠设备确认。跑 `android_diag`，看
> `nativeAddons` 里 `@rs-cross-spawn/android-arm64` 的 `ok` 是否为 `true`。
> logcat 里也会有一行 `libnode.so promoted to the global symbol group`（含用了哪条路）。

---

## P1 — 已修复，但需设备确认

### 1.1 system.node 的 napi 符号（已修）
加了 `-lnode` 让 DT_NEEDED 含 `libnode.so`。**已在本机验证**：`llvm-readelf -d`
显示 NEEDED = libnode.so/libdl.so/libc.so，且从**打进 APK 的 tar 里**解出来复核过。

### 1.2 硬链接被 SELinux 禁止（已修）
AOSP 策略：`neverallow untrusted_app app_data_file:file link;` —— **app 永远建不了
硬链接**。而 `dsh-session-persistence-jsonl` 用 `link()` 做独占发布，必然 EACCES。

已改为：先试 `link()`，仅在 EACCES/EPERM/EOPNOTSUPP/ENOTSUP 时回落
`open(path,'wx')` 独占创建 + 写内容（保住 EEXIST 冲突语义）。单测 5 项覆盖三条分支。

#### ⚠️ 覆盖点有 **4 处**，不是 1 处

| 包 | 文件 | 调用点 | 说明 |
| --- | --- | --- | --- |
| `dsh-session-persistence-jsonl` | `lib/index.js` | **2** | `publishCurrentExclusive`（后续世代）+ `materializePosix`（**首次建会话**） |
| `dsh-session-persistence-jsonl` | `lib/worker.cjs` | 1 | 打包后的校验 worker |
| `dsh-fs-local` | `lib/index.js` | 1 | 文件原子写（`createIfAbsent`），**别名调用** |
| `dsh-attachment-local` | `lib/index.js` | 2 | 附件新建对象 / 加别名 |

**共 6 个调用点。** 每漏一个都会在设备上重现同一类 EACCES。

我第一版只改了 `index.js`，设备上**继续报同一个 EACCES**。原因是当初用
`include: '*.js'` 搜索 —— **那个 glob 不匹配 `.cjs`**，而同目录下的
`lib/worker.cjs` 是同一份函数的打包副本。

**第二个教训：一个文件里可能不止一个调用点。**
`lib/index.js` 有两个 —— `publishCurrentExclusive`（后续世代）和
`materializePosix`（**首次建会话**）。我改了前者、漏了后者，于是每次新建会话
照样报同一个 EACCES。而当时的检查只看「文件里有没有补丁标记」，
整个文件被判为已修，漏点被静默放过。

**第三个教训：别名调用。** `dsh-fs-local` 写的是
`const linkFile = internals.linkFile ?? link` 然后 `await linkFile(...)` ——
只 grep `link(` **完全看不见**，而扫描器还给它报了 "OK"。

现在两处都按「逐调用点」处理：
- `patch-hardlinks.mjs` 逐点列出原文，**找不到就报错退出**；
- `audit-native.mjs` 与回归测试都**抠掉已替换的辅助函数体**，再数剩下的
  `link(` 调用 —— 并且**解析别名**。已用未打补丁的原始文件验证过：它会报
  `仍有裸 link() 在 L551`。

另有两处**不需要**改，因为它们本身就有回退（已人工确认）：

- `node-addon-native-custom-loader`：`linkSync` 失败后回退 `renameSync`；
- `dsh-storage-json`：只在注释里提到 link+unlink 协议，没有实际调用。

`npm run audit:native` 会扫出所有硬链接调用点并标注是否已改
（要求文件真的从 `fs/promises` 具名导入 `link`，否则 `hyperlink(`/`symlink(`
这类同名调用会变成噪音）。

### 1.3 flock：改成**单进程语义**，不再加载原生 binding

走过的三步弯路（记录下来，免得以后再试）：

1. 上游 `flock.js` 只认 linux/darwin，Android 上报 `'android'` 被拦 →
2. 用 NDK 交叉编译出 android-arm64 的 `system.node`。**本机验证 ELF 完全正确**
   （NEEDED 含 libnode.so、aarch64、16KB 对齐、无 glibc 符号）——
   但设备上仍报 `cannot locate symbol "napi_create_function"` →
3. 再补 DT_NEEDED + 在 `JNI_OnLoad` 里把 libnode 提升进全局符号组 —— 仍不稳定。

**最终认识**：这个锁在 Android 上**没有意义**。应用是单进程，内核 flock 提供的是
跨进程互斥。上游自己已为单进程环境定义过语义 —— 模块注释原文：

> The browser worker stubs the native flock entry to immediate success:
> it is single-process, so the in-process write claim already excludes every writer.

所以直接用同一语义（立即成功）。**不是打桩，是沿用上游对同类环境的答案。**

**副作用（好的那种）**：运行时里现在**一个原生文件都没有**，这类"只在设备上暴露"
的失败模式被整类消除。

> 教训：遇到"平台缺预编译产物"时，先问**这个原生能力在当前环境是否真的需要**，
> 再决定是移植它还是绕过它。我花了两轮在移植一个单进程下无意义的锁。

### 1.4 运行时指纹只比字节数（已修）——「修好了却没生效」的元凶

launcher 判断"要不要重解压运行时"时，原来**只比 tar 的字节数**：

```js
const packChanged = marker.binSize !== binSize;   // ← 只看大小
```

一旦**内容变了但 gzip 后字节数恰好相同**，就会判定为未变 → 跳过重解压 →
设备一直跑旧文件。表现为：构建产物、APK、tar 全部正确，**只有设备上那份是旧的**，
排查成本极高（我在这上面绕了两轮）。

已改为 **tar 的内容哈希**（`sha256` 前 16 位）。44MB 哈希在设备上约 0.2s，
相对解压（数秒到数十秒）可忽略。

### 1.5 插件管理器（已关闭）
`dsh-plugin-manager` 每步都 `execa('pnpm')`。Android 上无 pnpm、无 node CLI、
且 app 主目录禁 exec —— 三条路全断。已显式禁用；消费方写法是
`ctx.get('pluginManager') === undefined ? {}`，无连锁 pending。装插件走构建期。

---

## P2 — 已在本机验证「无风险」

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 16KB 页对齐 | ✅ 两个 .node 的 LOAD align 均 ≥ 0x4000 | `audit-native.mjs` |
| ELF 架构 | ✅ 均 aarch64 | 同上 |
| glibc 专有符号 | ✅ 无 `GLIBC_*` 版本标签、无 `__libc_start_main` 等 | 同上 |
| worker_threads | ✅ 可用（诊断工具实测 worker 返回 42） | `android_diag` |
| 独占创建语义 | ✅ `open('wx')` 第二次正确报 EEXIST | `android_diag` |
| statx / pidfd / clone3 | ✅ 运行时不引用 | grep 0 命中 |
| `require('internal/…')` | ✅ 0 处 | grep |

---

## P3 — 需运行时验证（本机无法复现）

### 3.1 127.0.0.1 绑定与长连接
**问题**：Web 服务绑 127.0.0.1 随机端口，WebSocket/SSE 长连接可能被息屏/Doze 断开。
**触发**：锁屏一段时间后回到应用。
**检测**：`android_diag` 不给这项 —— 需手工：锁屏 10 分钟后看会话是否还在推流。
**方向**：已有前台服务（`dataSync`）是主要缓解；若仍断，需在 WebView 侧重连。
VPN 一般不影响 127.0.0.1（loopback 不过 VPN），此项风险低。

### 3.2 child_process 陷阱
**问题**：`node:child_process` **可 import**，但它绕过 `ctx.subprocess` provider，
在 Android 上因 exec 限制必失败。
**检测**：`android_diag` 的 `childProcess` 字段会明说这一点。
**方向**：任何新插件都必须走 `ctx.subprocess`。这是**代码规范**问题，不是配置问题。

### 3.3 /tmp 不存在
**问题**：Android 无 `/tmp`。运行时有 14 处字面 `/tmp`，但**都在 Android 不走的
分支**：bwrap 沙箱（我们用 danger-full-access）、libreoffice-kit（未挂载）、
以及 `temporaryRoots(['/tmp', tmpdir()])` 这类**候选列表**（列表里含 tmpdir()，无害）。
**检测**：`android_diag` 的 `fsSemantics` / `paths.slashTmpExists`。
**方向**：launcher 已设 `TMPDIR=<dataDir>/tmp` 并 mkdir，走 `os.tmpdir()` 的代码都安全。

### 3.4 targetSdk 与 W^X
**说明**：当前 `targetSdk=36`，W^X（app 目录禁 exec）**生效**。降到 28 理论上可绕过，
但：Google Play 不接受、Android 14+ 直接拒绝安装 `targetSdk<23` 的包、
且这是**故意绕开安全边界**。**不建议**，也不在计划内。

---


## ⚠️ 先确认「设备上跑的是哪一版」

排查中最大的时间浪费来自：**无法区分「修复没生效」和「装的是旧包」**——
这两件事的排查方向完全相反。现在有三处可以确认：

1. **系统设置 → 应用 → DSH → 版本** 应为 `0.2.0`（versionCode 2）。
   之前一直停在 `1 / 0.1.0`，装了新包也看不出来。
2. **`dsh.log` 第一屏**有这一行：
   ```
   native self-check: pack digest=<16 位十六进制> bytes=<字节数>
   ```
   这是内置运行时的 sha256 前 16 位。内容变过就一定不同 —— 用它对齐
   「我构建的那一包」和「设备上跑的那一包」。
3. **外壳页的「版本」行**（应用内，不用 adb）。

### 指纹只比字节数 —— 同一类 bug 犯了三次

| 位置 | 原写法 | 后果 |
| --- | --- | --- |
| `launcher.cjs` 运行时解压 | `marker.binSize !== binSize` | 跳过重解压，跑旧运行时 |
| `NodeService.kt` assets 指纹 | `bundle/` 下大文件只记字节数 | 跳过重拷，存的是旧 tar |
| 上面两处叠加 | —— | 表现为「修好了却没生效」 |

全部改成**按内容**：launcher 用 tar 的 sha256；Kotlin 侧对所有 asset 一律算 CRC32
（44MB 约 0.2s，只在启动时一次）。

**已验证自愈**：预置一份「陈旧运行时 + 旧格式 marker（只有 binSize）」，
启动后日志显示 `runtime pack changed (45874563 -> 9e467f957998a3ce, ...)`，
重新解压，陈旧文件被清除。


## ✅ 结论：Android 上不需要任何原生 addon

**设备实测**（v0.2.1 launcher 启动自检）：

```
native self-check: child_process /system/bin/sh -> status=0 stdout="CHILD_OK\n10130"
```

`node:child_process` → libuv → `posix_spawn` **完全可用**。

### 最初的前提是错的

当初自研 `@dsh-android/subprocess-rs`（原生 addon）的理由是「Android 上不能用
`child_process.spawn`」。那个前提把**两件事**混成了一件：

| 事实 | 影响 |
| --- | --- |
| Android 10 禁 **app 私有目录内**的 execve | 只影响 app 自己解包出来的二进制 |
| `/system/bin/sh`、toybox 在**系统分区** | 本来就能 exec |

真正挡住 `dsh-subprocess-local` 的是 `node-pty` 顶层 import —— 而那个早就用 stub
解决了，且它实际是 `createLazyRequire` 懒加载、只有终端功能才碰。

### 顺带解开：为什么 DT_NEEDED libnode.so 没用

设备日志里的映射行：

```
libnode mappings = /data/app/~~.../com.dshdesktop.android-.../base.apk | ...
```

**libnode 是从 APK 直接映射的**（条目名是 `base.apk`，不是 `libnode.so`）。
所以 addon 的 `DT_NEEDED libnode.so` 在运行时**找不到可绑定的对象**，
napi_* 自然解析不到。这也解释了为什么给 `system.node` 补 DT_NEEDED 后设备上
仍然报同一个错 —— 那条路本来就走不通。

### 最终形态

- `android-patch.yml` 3b：**不再替换** subprocess，用原生 `dsh-subprocess-local`；
- `pack-runtime.mjs` 的 `EXCLUDED_PLUGINS`：`subprocess-rs` **不随 APK 落位**
  （源码留在仓库里供参考与单测，但交付物里不该有不可能工作的原生文件）；
- `bash-mksh` 仍然基于 `ctx.subprocess` 提供 shell 执行，不受影响。

**交付物里的原生文件数：0**（除 `libnode.so` 本身）。
`npm run audit:native` → **无阻塞项**。

## 复现指令

```bash
npm run audit:native      # 本机：扫全部 ELF，出阻塞项清单
npm run test:session-link # 本机：硬链接替代实现的语义测试
```

设备上还有第二路：**launcher 启动自检**。它在 dsh 之前、同一进程里跑，用的是
完全相同的 dlopen 机制，结果直接写进 `dsh.log`：

```
native self-check: platform=android-arm64 node=v24.x
native self-check: libnode mappings = /data/app/.../lib/arm64/libnode.so
native self-check: rs-cross-spawn.node -> OK / FAIL ERR_DLOPEN_FAILED: ...
```

**这一路比 `android_diag` 更重要**：会话持久化要 flock，flock 加载失败 → 会话起不来
→ 工具根本调不到。也就是说「能跑诊断工具」和「需要诊断」互斥。launcher 自检没有这个
鸡生蛋问题。

设备上（若能进会话）：还可以调用 **`android_diag`** 工具，一次性拿到
路径事实 / libnode 映射 / **每个原生插件的真实加载结果** / worker 线程 /
文件系统语义 / child_process 提示。

logcat 关键行：
```bash
adb logcat -s dsh-node    # 看 libnode.so 是否提升进全局符号组
```
