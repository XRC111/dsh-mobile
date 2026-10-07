import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.dshdesktop.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dshdesktop.android"
        minSdk = 26
        targetSdk = 36
        // ⚠️ 每次修完原生/运行时问题就**必须**递增：设备上排查时最先要确认的就是
        // 「装的到底是哪一版」。之前一直停在 1/0.1.0，导致无法区分「修复没生效」
        // 和「装的是旧包」—— 这两件事的排查方向完全相反，浪费了好几轮。
        versionCode = 13
        versionName = "0.5.3"
        // 与 libnode.so 构建工具链对齐
        ndkVersion = "28.2.13676358"
        // libnode.so 只提供 arm64-v8a
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared", "-DANDROID_ARM_NEON=ON")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // ⚠️ 签名从 local.properties 读，不写死在这里。
            //
            // 之前 release 块是空的 → 出的是未签名（或 debug 签名）的包，
            // 能装但不能上架、也不能覆盖安装正式版。签名配置必须存在，
            // 而**密钥与密码都不进仓库**（见下面的 gitignore 说明）。
            //
            // 缺 local.properties 的条目时回退到 debug 签名并给出提示 ——
            // 让「忘了配签名」表现为一条警告 + 能装能跑的 APK，
            // 而不是构建直接失败（失败会让人以为代码有问题）。
            signingConfig = signingConfigs.create("release") {
                val props = Properties()
                // ⚠️ 路径必须相对 **rootProject**（= 仓库根 D:\code\dsh-android），
                //    不是相对 app/ 模块。写成 "../local.properties" 会解析到
                //    D:\code\local.properties —— 不存在，于是签名配置静默回退到
                //    debug keystore，出来的包能装但不是 release 签名。
                //    这个坑的表现很隐蔽：构建成功、apksigner 也能验过（它验的是
                //    debug 那把），只有比对证书 DN 才发现。
                val f = rootProject.file("local.properties")
                if (f.exists()) f.inputStream().use { stream -> props.load(stream) }
                // ⚠️ 必须显式转 String?：java.util.Properties.getProperty 的返回类型
                //    在 Kotlin 里是平台类型（Any!），赋给 storePassword（String?）
                //    会被 Kotlin DSL 的严格类型检查拒掉：
                //      "Assignment type mismatch: actual type is 'Any', but 'String?' was expected"
                //    直接写 val pass = props.getProperty(...) 不加类型是不行的。
                val store: String? = props.getProperty("KS_STORE_FILE")
                val pass: String? = props.getProperty("KS_PASS")
                val keyPass: String? = props.getProperty("KS_KEY_PASS") ?: pass
                val keyName: String? = props.getProperty("KS_KEY_ALIAS")
                if (store != null && pass != null && rootProject.file(store).exists()) {
                    storeFile = rootProject.file(store)
                    storePassword = pass
                    keyAlias = keyName ?: "dsh-release"
                    keyPassword = keyPass
                    // 明确告诉构建日志用的是哪把钥匙 —— 之前「静默回退到 debug」
                    // 就是因为没有任何提示，只能靠事后比对证书 DN 才发现。
                    logger.lifecycle("签名：${rootProject.file(store).name} (alias=${keyAlias})")
                } else {
                    // ⚠️ 这里**不**静默回退到 debug keystore。
                    //
                    // 回退的代价是「构建成功但包不是 release 签名」—— 能装、能跑，
                    // 只有上架或覆盖安装正式版时才暴露，而那时已经发出去了。
                    // 直接失败更安全：出不了包总比出个错签名的包好。
                    throw GradleException(
                        "未找到签名配置。请在 local.properties 里补上：\n" +
                        "  KS_STORE_FILE=app/dsh-release.p12\n" +
                        "  KS_PASS=<口令>\n" +
                        "  KS_KEY_ALIAS=dsh-release\n" +
                        "当前解析到的 local.properties：${f.absolutePath}（存在=${f.exists()}）\n" +
                        "解析到的密钥路径：${store ?: "(未设置 KS_STORE_FILE)"}",
                    )
                }
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
        // 外壳页用 Compose + MiuiX 写（见 ShellScreen.kt）；
        // WebView 仍是经典 View，两者在同一 Activity 里共存。
        compose = true
    }
    packaging {
        // assets 里的大文件按原样打包
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    // 外壳页：Compose 承载 + MiuiX（小米 MIUI 设计语言，Compose Multiplatform 实现）
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("top.yukonga.miuix.kmp:miuix:0.7.2")
    // MiuiX 是 Compose Multiplatform 库，foundation 必须显式给 ——
    // 它的 POM 把 org.jetbrains.compose.foundation:foundation 标成 runtime scope，
    // 编译期拿不到 Column / padding / PaddingValues 这些符号。
    implementation("org.jetbrains.compose.foundation:foundation:1.9.3")
    implementation("org.jetbrains.compose.runtime:runtime:1.9.3")
}
