/**
 * Lazy POSIX flock entry —— Android 版本。
 *
 * ── 为什么不再加载原生 binding ──────────────────────────────────────────────
 * 上游实现（@deepseek-ai/node-addon-system/lib/flock.js）要 require 一个
 * platform 包里的 system.node，而：
 *
 *   1. 上游只发布 darwin/linux 四个 platform 包，且 linux 版按 glibc/musl 分
 *      目录 —— bionic 既非 glibc 也非 musl，**都加载不了**；
 *   2. 自己用 NDK 交叉编译能产出 android-arm64 的 system.node，但它引用的
 *      napi_* 符号在嵌入式 libnode 下解析不到，dlopen 报
 *      "cannot locate symbol \"napi_create_function\""；
 *   3. 给 addon 补 DT_NEEDED libnode.so、再把 libnode 提升进全局符号组，
 *      实测仍无法在所有设备上稳定成立。
 *
 * 而**这个锁在 Android 上本来就没有意义**：应用是单进程的，而内核 flock 提供的
 * 是「跨进程互斥」。上游自己也承认这一点 —— 模块注释原文：
 *
 *   "The browser worker stubs the native flock entry to immediate success:
 *    it is single-process, so the in-process write claim already excludes
 *    every writer."
 *
 * 也就是说上游已经为「单进程环境」定义过正确语义：**立即成功**。Android 正是
 * 单进程，这里直接采用同一语义 —— 不是偷懒，是沿用上游为同类环境给出的答案。
 *
 * 真正的互斥由上层保证：SessionWriteLease.acquire 先在进程内做写入声明，
 * 内核锁只是跨进程的第二道闸。
 *
 * @param {number} _fd - 调用方持有的文件描述符（本实现不再使用）。
 * @returns {Promise<void>} 立即兑现，表示获取成功。
 */
export async function tryLockExclusive(_fd) {
    // 单进程环境：进程内写入声明已排除所有写者（上游对 browser worker 的同款处理）。
}
