package com.dshdesktop.android

/** JNI 桥：对应 app/src/main/cpp/node-runner.cpp 的导出函数。 */
object NodeRunner {
    init {
        // libnode.so 由系统从 jniLibs 加载；node_runner 是我们编译的 JNI 壳
        System.loadLibrary("node_runner")
    }

    /** 非阻塞：Node 在专属线程里跑。返回 0=已启动，1=已在运行，2=线程创建失败。 */
    external fun startNodeWithArguments(args: Array<String>): Int
}
