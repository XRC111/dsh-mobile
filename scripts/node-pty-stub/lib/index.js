'use strict';
/**
 * node-pty 的 Android stub（由 dsh-android 的 pack-runtime.mjs 注入）。
 *
 * node-pty 没有 android-arm64 预编译，交叉编译尚未完成；而
 * dsh-subprocess-local 顶层 import node-pty —— 不提供可加载的 node-pty，
 * subprocess entry 无法 import，应用启动失败。
 *
 * stub 用 Proxy 兜底任意导出面；真正 spawn 终端时抛错（bash/pwsh 工具在
 * Android 上暂不可用）。TODO：NDK 交叉编译 pty.node 后移除本 stub。
 */

function unavailable(prop) {
    return function () {
        throw new Error('node-pty is stubbed on Android: no prebuilt pty.node (called: ' + String(prop) + ')');
    };
}

const base = {
    process: 'stub',
};

module.exports = new Proxy(base, {
    get(target, prop) {
        if (prop === '__esModule') return false;
        if (prop === 'default') return module.exports;
        if (prop in target) return target[prop];
        return unavailable(prop);
    },
});
