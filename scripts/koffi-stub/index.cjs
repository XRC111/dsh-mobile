'use strict';
/**
 * koffi 的 Android stub（由 dsh-android 的 pack-runtime.mjs 注入）。
 *
 * koffi 无 Android 预编译二进制，而 dsh-subprocess-local 传递依赖的
 * dsh-win32-process、dsh-sandbox-windows-acl 在模块**顶层** import koffi 且
 * 立即执行 koffi.pointer()/koffi.struct() 定义 Win32 类型（无平台守卫）——
 * 不提供可加载的 koffi，整条 subprocess/sandbox 链（以及 attachments 服务）
 * 都无法激活，应用启动失败。
 *
 * Android 上这些包的 Win32 调用路径永远不会被执行（平台分支守卫），因此：
 * - 类型定义类调用（pointer/struct/enum/proto）返回无害惰性对象
 * - 真实 FFI 操作（load 后的 func 调用、alloc/decode/encode）抛错兜底
 */

function unavailable(what) {
    return function () {
        throw new Error('koffi is stubbed on Android: FFI unavailable (' + what + ')');
    };
}

const KoffiStubLibrary = new Proxy({}, {
    get(_t, prop) {
        // koffi.load(dll).func('签名') —— 真实调用 Win32 函数时才会走到
        return unavailable('load().' + String(prop));
    },
});

const base = {
    version: '2.12.2-dsh-android-stub',
    // 类型定义：返回惰性标记对象，允许顶层定义链（pointer(struct(...)) 等）
    pointer: function (type) { return { 'koffi-stub': 'pointer', of: type }; },
    struct: function (name) { return { 'koffi-stub': 'struct', name }; },
    enum: function (name) { return { 'koffi-stub': 'enum', name }; },
    proto: function (name) { return { 'koffi-stub': 'proto', name }; },
    // 真实 FFI 操作：抛错
    load: function () { return KoffiStubLibrary; },
    alloc: unavailable('alloc'),
    free: function () {},
    decode: unavailable('decode'),
    encode: unavailable('encode'),
};

module.exports = new Proxy(base, {
    get(target, prop) {
        if (prop === '__esModule') return false;
        if (prop === 'default') return module.exports;
        if (prop in target) return target[prop];
        // 其余未列出的 API（ref/out/as 等）：当作类型/元数据类调用，返回惰性对象
        return { 'koffi-stub': 'lazy', prop: String(prop) };
    },
});
