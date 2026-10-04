plugins {
    id("com.android.application") version "8.13.0" apply false
    // ⚠️ 必须与 miuix 的编译版本一致：miuix 0.7.2 用 Kotlin 2.2.21 产出，
    // 低版本编译器读它的 metadata 会报 "compiled by a newer Kotlin"。
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
}
