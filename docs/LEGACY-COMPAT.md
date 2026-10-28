# 旧插件兼容层

面向 dsh **0.1.5 ～ 现在（0.2.1）** 这段版本线的插件兼容判定与放行机制。

## 它解决的问题

dsh 0.2 起加了一道 gate（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）：
插件的 `engines.dsh` 或任一 `@deepseek-ai/dsh*` peer 不满足，就直接拒绝安装/加载，
唯一放行通道是 profile 目录下 `compatibility.json` 里的**精确**豁免。

而生态里大量插件声明的是 `^0.1.5`、`^0.1.2-alpha.1` 这类 0.1 线区间 ——
按 semver，`^0.1.5` 的上界是 `0.2.0-0`，所以它们在 0.2.x 上**必然不满足**。

真实抽样（目录里 3823 个 npm 插件中取 60 个）：

| 声明形态 | 数量 | 在 0.2.1 上的结果 |
|---|---|---|
| 完全不声明版本 | 21 | 放行（gate 无要求可查） |
| `^0.1.x` / `>=0.1.x <0.2.0` | 多数其余 | **被拒** |
| `>=0.1.7-rc.2 <0.3.0` | 少数 | 放行（本来就在区间内） |
| 手写精确版本列表 | 个别 | 取决于列表是否含当前版本 |

被拒的这些里，相当一部分**实际能跑**：它们只用了 `ctx.effect`、
`ctx.tools.register` 这类从头到尾没变过的接口，变的只是作者写在
package.json 里的版本号。

兼容层就是把「版本号不匹配」和「代码跑不了」这两件事分开判。

## 判定模型

四种结论，语义严格区分：

| 结论 | 含义 | 放行 |
|---|---|---|
| `native` | 版本要求本来就满足 | 是 |
| `bridged` | 版本不满足，但静态校验通过 | 是，写精确豁免 |
| `unverified` | 版本不满足，但没有可校验的源码 | 视场景，见下 |
| `blocked` | 版本不满足，且有确定的断裂 | 否，附明细 |

`unverified` 是关键的一档，**不能当成通过**：

- **市场列表阶段**：只有 npm manifest，没有 tarball。替用户断言「能跑」是编的，
  断言「不能跑」又把大量能跑的挡在外面，所以只能给「不知道」。
- **纯客户端插件**：主题、界面面板这类，逻辑全在浏览器侧。客户端模块表由
  `dsh-client-modules` 在运行时按已装包的 `dsh.client` **动态组成**，不启动浏览器
  查不出来。实测 `dsh-dracula-theme@1.1.0` 依赖的 `dsh-client-store` 在 0.2.1 的
  79 个声明 `dsh.client` 的包里没有 —— 它到底是被并进宿主了还是真没了，静态无法确定。

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

`packages/dsh-legacy-compat/data/transitions.json` —— 从真实 npm 运行时生成的差分：

```
0.1.5-rc.3 → 0.1.7-rc.2:  消失 6 包 / 新增 48 包 / 删符号 33 个
0.1.7-rc.2 → 0.2.0-rc.2:  消失 0 包 / 新增 5 包  / 删符号 0 个
0.2.0-rc.2 → 0.2.1-rc.4:  消失 8 包 / 新增 29 包 / 删符号 14 个
```

**判定不依赖这份数据**（判定靠实时 resolve），它只负责回答「为什么没了、
该换成什么」。

`data/renames.json` 是**人工维护**的改名/替代关系，只写确定的。试过按名字
相似度自动生成，结果把 `dsh-hook-protocol` 猜成 `dsh-hmr`、`dsh-invariants`
猜成 `dsh-fs` —— 指错方向比不给建议更糟，所以改成人工确认。

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
node scripts/check-dshmarket-compat.mjs   # 三处改动缺一就红
```

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
| `npm run test:compat-gen` | 生成器端到端：bridged→写豁免、blocked→退出 1、unverified→不写、native→不写 |

第三套是必要的：仓库里真实随包的 5 个插件 peer 全是 `*`，怎么判都是 `native`，
所以「豁免真被写出来」这件事在真实数据上**永远验证不到** —— 生成器写错键格式、
把 `unverified` 也算进去，跑一遍照样输出 `{}`，看起来完全正常。只能靠构造的
运行时 + 构造的插件把三条路各走一遍。

## 边界：这套机制不承诺什么

- **不 polyfill 旧 API**。插件 import 了已删除的包，兼容层只会说明「缺什么、
  有没有替代」，不会凭空补一个实现出来。
- **不保证运行时行为等价**。静态校验能证明「包在、符号在」，证明不了
  「语义没变」。一个函数签名没变但行为改了的 API，这里查不出来。
- **客户端侧只做粗判**。浏览器侧的模块表运行期才组成，静态无法穷尽。
- **一次豁免不等于永久豁免**。豁免键是 `包名@精确版本`，插件发新版要重新判。
- **不覆盖用户授权**。`compatibility.json` 永远是合并写入，读不动就直接放弃。

## 跟版流程

dsh 升级后：

1. 装一份新运行时（`npm install @deepseek-ai/dsh@<新版本>` 到临时目录）；
2. 重跑差分（把新版本加进列表）：
   ```bash
   node scripts/gen-compat-transitions.mjs \
     --runtime 0.1.5-rc.3=/tmp/rt-015 \
     --runtime 0.2.1-rc.4=/path/to/old-runtime \
     --runtime 0.2.2-alpha.2=/path/to/new-runtime
   ```
3. 看输出里新增的「消失的包」，人工确认 `data/renames.json`（有没有替代）；
4. 重打运行时（`npm run pack:runtime`）—— 它自带兼容判定，内置插件若有断裂会直接失败；
5. 跑 `npm run test:compat && npm run test:compat-exemptions && npm run test:compat-gen`。

## 复现差分数据

差分需要多份运行时同时在场。除了 `gen-compat-transitions.mjs` 的 `--runtime`
参数，没有别的隐式路径依赖 —— CI 里不跑这一步，产物提交在仓库里。
