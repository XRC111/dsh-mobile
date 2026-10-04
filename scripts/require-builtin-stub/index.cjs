'use strict';
/**
 * node-addon-require-builtin 的 Android stub（由 dsh-android 的 pack-runtime.mjs 注入）。
 *
 * 原包用原生 addon 把 require('<internal id>') 的能力暴露成 JS API
 * （requireBuiltin / isAllowedInternalId / getBindingInfo）。它的 optionalDependencies
 * 只有 darwin/linux/win32 三个平台，**没有 android-arm64** → createEntryApi() 在
 * 模块顶层就抛 "No usable native binding found"，而 dsh-app-boot 的
 * internalModules() 是无条件 require 这个包的，于是整个 harness 在
 * "host preparation failed" 阶段就 fatal，连插件树都还没开始挂。
 *
 * 真实 node 里的等价能力是 --expose-internals：开启后 require('internal/...')
 * 直接可用。所以这个 stub 把 requireBuiltin 落到普通 require 上：
 *   - 有 --expose-internals（launcher 给 Worker 传了这个 flag）→ 正常工作
 *   - 没有 → 抛出与原生桥同形状的错误，指明缺哪个 flag，而不是伪装成功
 *
 * 这样 Android 不再依赖任何缺失的原生二进制，而 profile 解析拦截层
 * （installRuntimeInterception）依然能装上 —— 这是 dsh 挂插件树的前提。
 */

const { createRequire } = require('node:module');

/** 内部模块 id 白名单：与原生桥 isAllowedInternalId 的判定范围对齐。 */
function isAllowedInternalId(moduleId) {
    return typeof moduleId === 'string' && moduleId.startsWith('internal/');
}

/** 描述当前生效的桥接方式，供诊断使用。 */
function getBindingInfo() {
    return {
        source: 'dsh-android-stub',
        backend: 'expose-internals',
        abi: process.platform + '-' + process.arch,
        error: undefined,
    };
}

function requireBuiltin(moduleId) {
    if (!isAllowedInternalId(moduleId)) {
        throw new Error('node-addon-require-builtin (android stub): refusing non-internal id ' + JSON.stringify(moduleId));
    }
    // 用本模块的 createRequire 解析：与原生桥的查找范围一致（node 内建模块解析器）。
    const require_ = createRequire(__filename);
    try {
        return require_(moduleId);
    } catch (cause) {
        if (cause && cause.code === 'MODULE_NOT_FOUND' && !process.execArgv.includes('--expose-internals')) {
            const error = new Error(
                'node-addon-require-builtin (android stub): cannot require ' + moduleId +
                ' because this runtime was not started with --expose-internals',
            );
            error.cause = cause;
            throw error;
        }
        throw cause;
    }
}

module.exports = {
    requireBuiltin,
    isAllowedInternalId,
    getBindingInfo,
};
module.exports.default = module.exports;
