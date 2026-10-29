# 旧插件兼容层

面向 dsh **0.0.1 ～ 现在** 的**全部**历史版本插件：任何一条早于当前宿主的版本
声明都不再被版本号挡住，能不能跑由静态校验回答。

## 它解决的问题

dsh 0.2 起加了一道 gate（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）：
插件的 `engines.dsh` 或任一 `@deepseek-ai/dsh*` peer 不满足，就直接拒绝安装/加载，
唯一放行通道是 profile 目录下 `compatibility.json` 里的**精确**豁免。

而生态里大量插件声明的是 `^0.1.5`、`^0.1.2-alpha.1` 这类 0.1 线区间 ——
按 semver，`^0.1.5` 的上界是 `0.2.0-0`，所以它们在 0.2.x 上**必然不满足**。

真实抽样（npm 上带 `dsh-plugin` 关键词的 147 个插件，宿主 0.2.1-rc.4）：

| 声明形态 | 数量 |
|---|---|
| 含 0.2.x 或更高 | 87 |
| 只有 0.1.x | 24 |
| 不声明任何版本 | 22 |
| 其他写法（0.0.x、精确版本列表、裸 `<` / `<=`） | 14 |

在**旧判据**下这 147 个里有 3 个被标 incompatible：

| 插件 | 声明 |
|---|---|
| `dsh-win32@0.17.15` | `>=0.1.0-rc.5 <0.2.0` ∩ `>=0.1.0-rc.5 <0.1.0-rc.7` |
| `dsh-theone@0.4.5` | `>=0.2.0-rc.2 <0.3.0-0` ∩ `0.2.0-rc.2 \|\| 0.2.1-rc.2` |
| `dsh-codex-connect@0.2.0-alpha.10` | 13 个精确版本的列表，止于 `0.2.1-rc.3` |

三条都不含 `^` / `~` —— 正是旧实现认不出的那一类。新判据下 0 个。

被拒的这些里，相当一部分**实际能跑**：它们只用了 `ctx.effect`、
`ctx.tools.register` 这类从头到尾没变过的接口，变的只是作者写在
package.json 里的版本号。

兼容层就是把「版本号不匹配」和「代码跑不了」这两件事分开判。

## 全版本：判据里没有任何一条线

旧实现写死了两条线，两条都去掉了：

| 旧的硬编码 | 后果 | 现在 |
|---|---|---|
| `MIN_LINE = [0, 1]`：0.0.x 一律不管 | `^0.0.9` 的插件被市场判死 | 0.0.x 同样走兼容判定 |
| 只从 `^` / `~` 里提版本线 | `>=0.0.1 <0.1.0`、`<=0.1.9`、`0.1.x` 一条都认不出，绕过兼容层直接判 incompatible | 一律交给 `satisfiesRange`（gate 的镜像） |

现在的判据只有两条，跟具体版本号无关：

1. 宿主**不满足**这条声明（满足就不需要兼容层）；
2. 且这条声明某条 `||` 分支的**下界不高于宿主** —— 说明它是写给更早版本的。

第 2 条用来挡住反方向：`>=0.2.2` 遇上 0.2.1 宿主，下界高于宿主，那是插件
要求**更新的** dsh，宿主确实没有那些 API，照旧判不兼容。

同一套逻辑对未来的宿主也成立：`^0.2.0` 遇上 0.3.0 宿主，结论和 `^0.1.5`
遇上 0.2.1 完全一样。实现里没有 `0.1` / `0.2` 的字面量，测试里钉了这条
（`判据不写死任何一条线`）。

## 判定模型

四种结论，语义严格区分：

| 结论 | 含义 | 写豁免 |
|---|---|---|
| `native` | 版本要求本来就满足 | 否（gate 不会拒） |
| `bridged` | 版本不满足，但静态校验通过 | 是 |
| `unverified` | 版本不满足，但没有可校验的源码 | **是** |
| `blocked` | 版本不满足，且有确定的断裂 | 否，附明细 |

`unverified` 曾经不写豁免，理由是「查不到就不放行，否则等于兼容层对所有
主题插件失效」。那个方向搞反了：

- **不写** = dsh 的 gate 直接拒绝加载这个插件 —— 主题、界面面板这类
  （生态里数量最多的一类）一个都装不上；
- **写** = 插件正常加载。真出问题也只影响它自己那块界面，宿主照常起来。

「查不到」不是「跑不了」。唯一仍然硬拦的是 `blocked`：静态能证明确实缺包
或缺符号 —— 那种情况写进去也是白写。

`blocked` 在两端表现不同，这不是遗漏：

- **移动端**：内置插件随 APK 发布，没有人「选择安装」它。构建期发现 `blocked`
  直接让打包失败。
- **桌面端**：市场列表阶段只有 npm manifest，没有源码，判不出 `blocked`。
  用户在列表里看到的是「安装时校验」，点了就装 —— 装完加载失败时，dsh 的
  插件加载是隔离的，坏的是那一个插件，不是宿主。


## 静态校验怎么做的

对**宿主侧**代码（`scanPluginDir`）：

1. 扫插件所有 `.js/.mjs/.cjs`，提取 `from '@deepseek-ai/dsh-*'` 的具名导入；
2. 用 `createRequire` 从 dsh 自己的位置解析这个包（走 Node 的真实解析算法，
   而不是对比目录清单 —— 两者结论会不一样，见 `lib/surface.mjs` 的注释）；
3. 读入口文件的导出符号，比对插件用到的名字还在不在。

任何一步缺失 → `blocked`，并给出「缺哪个包、哪个符号、被什么取代」。

不判的情况（保守）：命名空间导入（`import * as ns`）、压缩产物（>4MB）、
`export * from` —— 这些读不出可信的符号表，判「不知道」比猜错好。

## 数据

`packages/dsh-legacy-compat/data/transitions.json` —— 从真实 npm 运行时生成的差分，
覆盖 npm 上**26 个可安装版本**，从 `0.0.1-rc.5` 到 `0.2.2-alpha.2`，共 26 段：

| 区段 | 消失 | 新增 | 删符号 |
|---|---|---|---|
| 0.0.1-rc.5 → 0.1.2-alpha.2 | 4 | 36 | 49 |
| 0.1.2-alpha.2 → 0.1.3-alpha.2 | 1 | 9 | 18 |
| 0.1.3-alpha.2 → 0.1.5-rc.3 | 1 | 10 | 1 |
| 0.1.5-rc.3 → 0.1.6-alpha.1 | 3 | 16 | 7 |
| 0.1.6-alpha.1 → 0.1.7-alpha.2 | 7 | 33 | 177 |
| 0.1.7-alpha.2 → 0.2.0-rc.2 | 0 | 11 | 9 |
| 0.2.0-rc.2 → 0.2.1-alpha.2 | 8 | 19 | 10 |
| 0.2.1-alpha.2 → 0.2.2-alpha.2 | 0 | 35 | 21 |

合计：**21 个宿主包彻底消失、46 个包删过导出符号、11 个客户端包的可解析性变过**。

**判定不依赖这份数据**（判定靠实时 resolve），它只负责回答「为什么没了、
该换成什么」。

两个生成期的坑，都会让数据「看起来完全正常但每一条都可能是假的」：

1. **中途消失又回来的条目**。差分是逐段扫的，`dsh-llm-deepseek-api-key`
   在 0.1.7-alpha.2 短暂消失、0.2.x 又回来了，不过滤的话会被记成「已消失」。
   所以生成完会按**最新版本**再筛一遍：现在还在的包与符号一律不写。
2. **`--legacy-peer-deps`**。见下面「复现差分数据」。

`data/renames.json` 是**人工维护**的改名/替代关系，只写确定的。试过按名字
相似度自动生成，结果把 `dsh-hook-protocol` 猜成 `dsh-hmr`、`dsh-invariants`
猜成 `dsh-fs` —— 指错方向比不给建议更糟，所以改成人工确认。

没能覆盖的版本：`0.0.1-rc.1` / `0.0.1-rc.2`（依赖的 `dsh-agent-tool-mode`
已从 npm 撤包，装不出来）、`0.1.0` 与 `0.1.1` 全线、`0.1.5-alpha.x`、
`0.1.5-rc.1` / `rc.2`（npm 的依赖解析在这些版本上会 CPU 打满并超时，实测
单版本 6 分钟仍未收敛）。它们落在相邻两段之间，不影响判定，只让「消失于
哪个具体版本」的精度粗一档。

## 两端接入

### 桌面端（dsh-market）

| 位置 | 作用 |
|---|---|
| `lib/discovery-compatibility.js` | 跨线声明不再判 `incompatible`，改判 `unknown`（市场不拦） |
| `lib/routes.js` 的 `preauthorizeLegacy` | 安装**前**写精确豁免 —— dsh 的 gate 在 pnpm 动手前就跑，晚一点没有意义 |
| `lib/legacy-compat.js` | 判定与合并写入 |

改动记录在 `scripts/patches/dshmarket-legacy-compat.patch`。同步上游后重放：

```bash
git apply scripts/patches/dshmarket-legacy-compat.patch
node scripts/check-dshmarket-compat.mjs   # 五条检查缺一就红
```

`pack-all-plugins.mjs` 已经把它接进流程：`upstream` 模式的插件在同步上游后自动
重放补丁、重算内容哈希；打不上就**构建失败**（否则这次产出的就是一个「没有兼容
层」的市场，发出去的症状是旧插件全被标成不兼容，而看不出原因）。

### 移动端

插件随 APK 固定，没有「用户点安装」这个时刻，所以豁免在**构建期**算好：

```
pack:runtime
  └─ [2c] gen-mobile-compat.mjs --runtime build/runtime-stage
         → app/src/main/assets/bundle/compatibility.json
launcher.cjs（设备上启动时）
  └─ 把该文件**合并**进 $DSH_HOME/profiles/web/compatibility.json
```

为什么钉在 `pack:runtime` 里、而不是让人手动跑：

- 手机上没有 `allow-version` 可调，构建期是唯一能判的时机；
- 判定的输入（展开的 `node_modules`，且已按平台剪枝）**只在这条流水线上存在**。
  `test.yml` 拿到的 `dsh-runtime.bin` 是个 tar.gz，里面没有能 `require` 的包；
- 漏跑是静默失败：文件不存在 → launcher 的 `installCompatExemptions` 找不到东西、
  什么也不做 → APK 照常出包，只是内置的旧插件在启动时被判不兼容。

因此 `compatibility.json` 也必须随运行时 artifact 一起上传（`runtime-pack.yml`），
它的判定和运行时版本一一对应；让 apk-build 用仓库里那份，就等于拿旧运行时的
结论去跑新运行时。

构建期发现 `blocked` 的插件会直接让打包失败 —— 装进去也是白装。

单独校验某个插件：

```bash
node scripts/gen-mobile-compat.mjs --runtime build/runtime-stage \
  --plugin-dir /path/to/some-plugin --out /tmp/out.json
```

`--plugin-dir` 可重复；给了它就**替代**默认的 `plugins/` 与
`app/src/main/assets/bundle/plugins/`，不追加。

## 测试

| 命令 | 覆盖 |
|---|---|
| `npm run test:compat` | 判定核心：四态、semver、豁免键格式 |
| `npm run test:compat-exemptions` | launcher 的合并写入（只增不删、坏 JSON 不动、原子写） |
| `npm run test:compat-gen` | 生成器端到端：bridged→写豁免、blocked→退出 1、unverified→也写、native→不写 |
| `node scripts/dshmarket-legacy-compat.test.mjs`（桌面端） | 市场侧判据：跨线判定（26 种形态）、engines 优先级、安装目标解析、合并写入 |

第三套是必要的：仓库里真实随包的 5 个插件 peer 全是 `*`，怎么判都是 `native`，
所以「豁免真被写出来」这件事在真实数据上**永远验证不到** —— 生成器写错键格式、
把 `unverified` 也算进去，跑一遍照样输出 `{}`，看起来完全正常。只能靠构造的
运行时 + 构造的插件把四条路各走一遍。

桌面端那套同理：`check-dshmarket-compat.mjs` 只保证「代码还在」，它保证
「代码还是那个意思」。补丁能重放不代表语义没被改坏，而判宽/判严两个方向的
后果都是沉默的。

`check-dshmarket-compat` 现在有五条，其中两条是「全版本」的语义守护：
判据里不许出现 `MIN_LINE` / `declaredLines(`，列表阶段不许再调
`crossesImplicitCeiling` 当闸门。它们挡的是一种特别隐蔽的回归 —— 同步上游时
把旧文件整个带回来，三处标记都还在，只有判据悄悄退回 0.1 起。

其中两条是安全底线，不是覆盖率：

- **判跨线的声明，一定是 gate 会拒的**。反过来的话就是给一条本来就满足的
  声明白送豁免 —— 凭空绕过一次 gate。用上游那套 `satisfiesRange` 逐条复核。
- **同线通配不会误伤**。`0.1.x` 在 0.1.5 上本来就满足，但 `check.js` 解析不了
  通配写法。实现里对这种情况退到版本线级别比较，这条测试盯着它别退错方向。

## 边界：这套机制不承诺什么

- **不 polyfill 旧 API**。插件 import 了已删除的包，兼容层只会说明「缺什么、
  有没有替代」，不会凭空补一个实现出来。0.0.1 时代就消失的 5 个包
  （`dsh-host-apiproxy`、`dsh-subagent-claude-code` 等）同理 —— 它们的能力
  在 0.1 被拆散重组，没有一一对应的替代。
- **不保证运行时行为等价**。静态校验能证明「包在、符号在」，证明不了
  「语义没变」。一个函数签名没变但行为改了的 API，这里查不出来。
- **客户端侧只做粗判**。浏览器侧的模块表运行期才组成，静态无法穷尽。
  所以纯客户端插件一律落在 `unverified` —— 现在这也意味着「放行」。
- **一次豁免不等于永久豁免**。豁免键是 `包名@精确版本`，插件发新版要重新判。
- **不覆盖用户授权**。`compatibility.json` 永远是合并写入，读不动就直接放弃。
- **只覆盖 npm 精确版本目标**。市场点安装时会把目标钉成 `名字@1.2.3`
  （registry latest 解析成功的前提下），这条路能写豁免。而 GitHub / git / 本地
  路径安装的目标里没有「最终会装到哪个版本」这个信息 —— 包名和版本都在仓库的
  package.json 里，装之前拿不到。这类插件仍会被 gate 拒绝，且**不会**被静默放过：
  用户看到的是 dsh 自己那句 incompatible。

## 跟版流程

dsh 升级后：

1. 装一份新运行时（`npm install @deepseek-ai/dsh@<新版本>` 到临时目录）；
2. 重跑差分（把新版本加进列表）：
   ```bash
   node scripts/gen-compat-transitions.mjs \
     --runtime 0.0.1-rc.5=/tmp/rt-005 \
     --runtime 0.2.1-rc.4=/tmp/rt-rc4 \
     --runtime 0.2.2-alpha.2=/path/to/new-runtime
   ```
3. 看输出里新增的「消失的包」，人工确认 `data/renames.json`（有没有替代）；
4. 重打运行时（`npm run pack:runtime`）—— 它自带兼容判定，内置插件若有断裂会直接失败；
5. 跑 `npm run test:compat && npm run test:compat-exemptions && npm run test:compat-gen`。

注意：`0.0.1-rc.1` 装不出来 —— 它依赖的 `@deepseek-ai/dsh-agent-tool-mode`
已经从 npm 撤包（官方源和镜像站都 404）。差分从 `0.0.1-rc.5` 起，那是
仍然可安装的最早版本。再往前的版本连运行时都拿不到，也就无从判定了。

## 复现差分数据

差分需要多份运行时同时在场。除了 `gen-compat-transitions.mjs` 的 `--runtime`
参数，没有别的隐式路径依赖 —— CI 里不跑这一步，产物提交在仓库里。

装运行时的正确姿势：

```bash
npm install --no-audit --no-fund --ignore-scripts --registry=https://registry.npmjs.org
```

两个参数各有理由，且**都不能省**：

- `--ignore-scripts`：不加的话 postinstall 会去编译 `dsh-pty` / landlock 之类的
  原生模块，在容器里能卡十几分钟。差分只读 `package.json` 和入口文件的导出，
  不需要能跑。
- **不要**加 `--legacy-peer-deps`：它会让 npm 跳过 peer 依赖，少装 20 多个包，
  而且**不报错**。症状是差分把那些包记成「在某个版本消失了」，而它们其实
  一直都在 —— 数据看起来完全正常，只是每一条「消失」都可能是假的。
