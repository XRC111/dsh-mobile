# 内嵌 EasyTier（场景 1：手机与桌面异地）

针对 [REMOTE-LINK.md](./REMOTE-LINK.md#跨网络使用异地组网) 里的「端口转发」接法，
把 EasyTier 内嵌进手机 APK，用户不用再装第二个 App。

> 状态：**方案已核实，代码未实施**。`.so` 必须用 Rust + Android NDK 交叉编译，
> 本机没有该工具链，需要在 CI 或有工具链的机器上产出。实施前请先评审本文。

## 结论：可行，且不需要 VPN 权限

你之前的两点纠正都是对的，这里逐条给出源码证据。

### 1. 不用 VPN 权限、不用全局代理

官方文档把这两件事写成正式特性：

- [无 TUN 模式（免 Root 权限）](https://easytier.cn/guide/network/no-root.html)
  > 「由于创建 TUN 设备需要 ROOT 权限，对于一些无法获取 Root 权限的环境，EasyTier 也提供了不依赖 TUN 的使用方法。」

  并且明确指出无 TUN 下**不能主动访问其他节点**，要用
  [SOCKS5](https://easytier.cn/guide/network/socks5.html) 或
  [端口转发](https://easytier.cn/guide/network/port-forward.html) —— 正是我们要的组合。

- [端口转发（Port Forward）](https://easytier.cn/guide/network/port-forward.html)
  > 「在无 TUN 模式或受限环境下，通过端口转发替代 TUN 接入虚拟网。」

我们只监听 `127.0.0.1` 上的一个端口，**不碰系统路由表**。官方 Android 模板
`EasyTierVpnService.t.kt` 也只为 `proxy_cidrs` 添加路由，从不写 `0.0.0.0/0`。

### 2. 官方确实有 Android JNI 库

`easytier-contrib/easytier-android-jni`，在 **EasyTier 主仓库内**（不是独立仓库 ——
这一点值得记一下：查 `crates.io` 或按 `EasyTier/easytier-contrib` 这个仓库名去查都会 404）：

| 文件 | 作用 |
| --- | --- |
| `Cargo.toml` | `crate-type = ["cdylib"]` |
| `src/network_api.rs` | `parseConfig` / `runNetworkInstance` / `setTunFd` / `collectNetworkInfos` |
| `kotlin/com/easytier/jni/EasyTierJNI.kt` | JNI 声明 |
| `kotlin/com/easytier/jni/EasyTierManager.kt` | 生命周期 + 状态轮询 |
| `build.sh` | `cargo ndk -t arm64-v8a build --release` |

JNI 层是**纯 FFI 转发**，没有自定义 Android host config：
`run_network_instance` 直接调 `easytier-ffi` 的同名函数。

## 关键核实：TOML 里的字段能不能生效

CLI 的 `--no-tun` / `--port-forward` 是**命令行参数**，而 JNI 的入口是
`runNetworkInstance(tomlString)` —— **TOML**。两者不一定对应，所以必须逐个查源码。

### 无 TUN：`[flags] no_tun = true`

`easytier-core/src/instance/config.rs`：

```rust
proxy: ProxyRuntimeConfig {
    no_tun: flags.no_tun,
    ...
```

`flags` 由 `TomlConfig` 解析，所以 `[flags] no_tun = true` 成立。

### 端口转发：`[[port_forwards]]`

同一个文件里有一段**门控逻辑**，是本次核实里最关键的一处：

```rust
port_forwards: if host.ignore_unsupported_config && !host.gateway_enabled {
    Vec::new()          // ← 整个丢弃
} else {
    config.get_port_forwards()
},
```

也就是说：**如果 Android JNI 的 host config 把 `gateway_enabled` 设成 `false`，
我们在 TOML 里写的 `port_forwards` 会被静默丢掉，且不报错。**

顺着往下查证：

1. `easytier/src/instance/config.rs:52`
   ```rust
   gateway_enabled: cfg!(feature = "socks5"),
   ```
2. `easytier/Cargo.toml` 的 `default` 特性里**包含 `socks5`**（`ffi-dataplane` 也依赖它）。
3. `easytier-contrib/easytier-android-jni/Cargo.toml`：
   ```toml
   easytier = { workspace = true, default-features = true }
   ```
4. 同一函数里 `ignore_unsupported_config: false`。

四个条件全部满足 ⇒ **port_forwards 不会被丢弃**。

> 顺带排掉一个雷：`compact_runtime_core_host_config()` 确实把
> `gateway_enabled` / `proxy_enabled` 全关成 `false`，但那是
> `native_compact_instance_manager_with_runtime` 专用路径，JNI 用的是
> `native_instance_manager_with_runtime`（`compact_runtime = false`）。别搞混。

### 配置长这样

```toml
instance_name = "dsh-phone"
hostname = "phone"
ipv4 = "10.144.0.3/24"

listeners = []

[network_identity]
network_name = "dsh"
network_secret = "..."

[flags]
no_tun = true
disable_p2p = true
enable_ipv6 = false

[[peer]]
uri = "tcp://<桌面公网地址>:11010"

[[port_forwards]]
proto = "tcp"
bind_addr = "127.0.0.1:45731"
dst_addr = "<桌面虚拟IP>:45731"
```

对应 [REMOTE-LINK.md](./REMOTE-LINK.md#两种接法) 表格里手机填的
**`127.0.0.1` + 转发出来的本地端口**，`mode=forward` —— 我们的 link 插件**零改动**。

## `.so` 怎么来

**官方 release 里没有预编译的 JNI `.so`。** v2.6.4 / 2.6.3 / 2.6.2 / 2.6.1 / 2.6.0
的 30 个 asset 全是各平台 GUI / CLI 包和官方 APK，没有
`libeasytier_android_jni.so`。所以必须自己编。

官方 `build.sh` 的实际步骤（arm64 单架构，和我们项目一致）：

```bash
rustup target add aarch64-linux-android
cargo install cargo-ndk
export ANDROID_NDK_HOME=...
(cd easytier-contrib/easytier-ffi && cargo ndk -t arm64-v8a build --release)
(cd easytier-contrib/easytier-android-jni && cargo ndk -t arm64-v8a build --release)
# → target/aarch64-linux-android/release/libeasytier_android_jni.so
# → target/aarch64-linux-android/release/libeasytier_ffi.so
```

**两个 `.so` 都要**（JNI 链接 ffi，ffi 链接 core）。都要放进
`app/src/main/jniLibs/arm64-v8a/`。

本机没有 Rust 也没有 NDK 交叉工具链，**无法本地构建、无法本地验证**。

## 实施清单

| # | 改动 | 文件 | 风险 |
| --- | --- | --- | --- |
| 1 | CI 加一个 Rust/NDK job，产出两个 `.so` | 新增 workflow | 需要 CI runner 有 NDK |
| 2 | `.so` 落到 `jniLibs/arm64-v8a/` | `app/src/main/jniLibs/` | 让 APK 体积增加（需实测） |
| 3 | 抄官方 3 个 Kotlin 类 | `app/src/main/java/com/easytier/jni/` | MIT/LGPL 许可声明（见下） |
| 4 | 自己写 overlay 管理类（不抄 `EasyTierManager`） | `com/dshdesktop/android/EasyTierOverlay.kt` | 见「为什么自己写」 |
| 5 | 前台服务保活 | `AndroidManifest.xml` + `ForegroundService.kt` | `FOREGROUND_SERVICE` 权限 |
| 6 | 组装 TOML + 落盘持久化 | 存 `filesDir/easytier/config.toml` | 密钥明文，需评估 |
| 7 | 接到现有配对 UI | `ShellDialogs.kt` 的 `LinkConnect` | 桌面上仍需单独装 EasyTier |

**为什么第 4 项不抄官方 `EasyTierManager`**：它是无条件起 `EasyTierVpnService` 的，
而我们**不要** VPN 服务。要改写成「只跑实例 + 端口转发 + 前台服务保活」。

## 许可

EasyTier 是 **LGPL-3.0**。动态链接 `.so` 在 LGPL 下通常合规（用户可替换库），
但**必须**：

1. 在 APK 的「开源许可」里列出 EasyTier + 链接 + 源码获取方式；
2. 保留官方版权头与 LICENSE；
3. 明确告知用户 `.so` 可被替换（这也是 LGPL 的替换机制要求）。

EasyTier 官方也提供 `easytier-core` 的完整源码获取途径。**这块需要在动手前和你确认写法。**

## 仍未解决 / 需要你定

1. **CI 能否编 Rust？** 现有 CI 有没有 runner 能装 NDK + Rust 工具链？还是这条路先搁置。
2. **桌面上仍要单独装 EasyTier。** 本方案只免掉手机上那第二个 App，不省桌面的活。
3. **`network_secret` 明文存储**是否可以接受。
4. **许可证声明**放哪儿（我倾向设置页「开源许可」入口，但项目现在有没有这个页面我不确定）。
