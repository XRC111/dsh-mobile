// dsh-android Node 启动器：在专属 pthread 里跑 node::Start（libnode.so）。
//
// 设计对应桌面外壳的两条铁律：
// 1) 不修改 Harness 源码 —— 这里只负责把 Node 跑起来，入口脚本（launcher.cjs）
//    自行解压运行时、落位补丁并 import dsh 的 bin.js。
// 2) 必须从 dsh 输出里解析 URL —— 由 launcher.cjs 劫持 console 完成，本文件
//    不参与 URL 解析。
//
// 注意 argv 生命周期：node::Start 不复制 argv，线程存续期间必须保持有效，
// 因此 g_args 用静态 vector 持有（字符指针指向其内部缓冲）。

#include <jni.h>
#include <pthread.h>
#include <android/log.h>
#include <dlfcn.h>

#include <cerrno>
#include <cstdio>
#include <string>
#include <vector>

#include "node.h"

#define LOG_TAG "dsh-node"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

std::vector<std::string> g_args;   // 保持存活：node::Start 不复制 argv
pthread_t g_thread;
volatile bool g_running = false;
volatile bool g_started_once = false;  // node::Start 不支持同进程二次调用（V8/uv 全局单次初始化）

void *NodeThreadEntry(void * /*unused*/) {
    LOGI("node thread entering, argc=%zu", g_args.size());

    // 约定：g_args 最后一个元素是 dataDir（Kotlin 传 filesDir）。
    // node 内部 CHECK 失败的断言文本写 stderr，而 Android app 进程的 stderr
    // 指向 /dev/null —— 不重定向的话闪退只剩 tombstone 栈，没有消息。
    if (!g_args.empty()) {
        std::string dataDir = g_args.back();
        if (!dataDir.empty() && dataDir[0] == '/') {
            if (!freopen((dataDir + "/node-stderr.log").c_str(), "w", stderr)) {
                LOGE("freopen stderr failed, errno=%d", errno);
            }
            if (!freopen((dataDir + "/node-stdout.log").c_str(), "w", stdout)) {
                LOGE("freopen stdout failed, errno=%d", errno);
            }
        }
    }

    std::vector<char *> argv;
    argv.push_back(const_cast<char *>("node"));
    for (auto &a : g_args) {
        argv.push_back(const_cast<char *>(a.c_str()));
    }
    const int argc = static_cast<int>(argv.size());

    const int exitCode = node::Start(argc, argv.data());
    LOGI("node exited with code %d", exitCode);
    g_running = false;
    return nullptr;
}

}  // namespace

// ⚠️ 必须把 libnode.so 提升到**全局符号组**，否则所有 .node 插件都加载不了。
//
// 症状：
//   dlopen failed: cannot locate symbol "napi_create_function" referenced by
//   .../node_modules/.../xxx.node
//
// 原因：桌面 node 里 addon 能解析 napi_* 是因为符号由**主可执行文件**导出，而主
// 可执行文件天然在全局组。这里是嵌入式 libnode.so —— System.loadLibrary 默认
// RTLD_LOCAL，libnode.so 只是 node_runner 的依赖，符号不进全局组；于是 dlopen
// 进来的 addon 找不到 napi_*。
//
// 这一句把已加载的 libnode.so 重新 dlopen 一次并带上 RTLD_GLOBAL，等价于提升它
// 的符号可见性。选这里而不是给每个 addon 补 DT_NEEDED，是因为前者一次修好**所有**
// 插件（含第三方预编译 .node，那些我们没有源码、没法重链）。
namespace {

/**
 * 从 /proc/self/maps 里找出已加载 libnode.so 的绝对路径。
 *
 * 为什么需要它：裸名 dlopen("libnode.so") 依赖调用方所在 linker namespace 的
 * 搜索路径。绝大多数设备上应用 namespace 包含自己的 nativeLibraryDir、能命中，
 * 但这不是规范保证的；拿不到就退化成「符号提升失败」，进而所有 .node 插件
 * 报 cannot locate symbol —— 而这正是我们要根除的症状。直接读 maps 拿绝对路径
 * 是确定性的，不依赖 namespace 配置。
 *
 * @param out 成功时写入绝对路径。
 * @returns 是否找到。
 */
bool findLoadedLibnode(std::string &out) {
    FILE *maps = fopen("/proc/self/maps", "re");
    if (maps == nullptr) return false;
    char line[4096];
    bool found = false;
    while (fgets(line, sizeof(line), maps) != nullptr) {
        // 形态：<addr>-<addr> perms offset dev inode /path/to/libnode.so
        const char *slash = strchr(line, '/');
        if (slash == nullptr) continue;
        std::string candidate(slash);
        while (!candidate.empty() && (candidate.back() == '\n' || candidate.back() == '\r')) {
            candidate.pop_back();
        }
        // 只取以 libnode.so 结尾的映射，避免匹配到 libnode_runner.so。
        const std::string suffix = "/libnode.so";
        if (candidate.size() >= suffix.size() &&
            candidate.compare(candidate.size() - suffix.size(), suffix.size(), suffix) == 0) {
            out = candidate;
            found = true;
            break;
        }
    }
    fclose(maps);
    return found;
}

/** 提升 libnode.so 的符号可见性；两条路都试，失败才报错。 */
void promoteLibnodeToGlobal() {
    // 路 1：裸名。RTLD_NOLOAD 表示「只取已加载的，不新加载」。
    if (void *h = dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL | RTLD_NOLOAD)) {
        LOGI("libnode.so promoted to the global symbol group (by soname, %p)", h);
        return;
    }
    // 路 2：从 /proc/self/maps 拿绝对路径再提升。
    std::string path;
    if (findLoadedLibnode(path)) {
        if (void *h = dlopen(path.c_str(), RTLD_NOW | RTLD_GLOBAL | RTLD_NOLOAD)) {
            LOGI("libnode.so promoted to the global symbol group (by path %s, %p)", path.c_str(), h);
            return;
        }
        const char *why = dlerror();
        LOGE("RTLD_NOLOAD promotion failed for %s: %s", path.c_str(), why ? why : "(no detail)");
    } else {
        LOGE("libnode.so not found in /proc/self/maps");
    }
    const char *why = dlerror();
    LOGE("could not promote libnode.so; every .node addon will fail with "
         "\"cannot locate symbol napi_*\": %s", why ? why : "(no detail)");
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM * /*vm*/, void * /*reserved*/) {
    promoteLibnodeToGlobal();
    return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_dshdesktop_android_NodeRunner_startNodeWithArguments(
        JNIEnv *env, jclass /*clazz*/, jobjectArray argsArr) {
    if (g_started_once) {
        LOGE("node already started once in this process; full app restart required");
        return 3;
    }
    if (g_running) {
        LOGE("node already running");
        return 1;
    }

    const jsize n = env->GetArrayLength(argsArr);
    g_args.clear();
    g_args.reserve(static_cast<size_t>(n));
    for (jsize i = 0; i < n; i++) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(argsArr, i));
        const char *s = js ? env->GetStringUTFChars(js, nullptr) : "";
        g_args.emplace_back(s ? s : "");
        if (js && s) env->ReleaseStringUTFChars(js, s);
    }

    g_running = true;
    g_started_once = true;
    if (pthread_create(&g_thread, nullptr, NodeThreadEntry, nullptr) != 0) {
        LOGE("pthread_create failed");
        g_running = false;
        return 2;
    }
    pthread_detach(g_thread);
    LOGI("node thread started");
    return 0;
}
