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
        versionCode = 10
        versionName = "0.5.0"
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
