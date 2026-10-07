#!/usr/bin/env node
/**
 * APK 构建入口（唯一入口，代替直接调 gradle）。
 *
 * ── 路径解析（别人 clone 下来必须能跑）──────────────────────────────────────
 * 早先这里写死了作者机器上的三条绝对路径（gradle 二进制、SDK/JBR、仓库根），
 * 别人 clone 只会看到 "spawn failed"。现在按优先级解析，每一项都可用环境变量覆盖：
 *
 *   Gradle   : ./gradlew（wrapper，随仓库分发）
 *              → $DSH_GRADLE
 *              → PATH 上的 gradle
 *   JAVA_HOME: $JAVA_HOME → $DSH_JAVA_HOME → 让 Gradle 自己找
 *   仓库根   : 本脚本所在目录的上一级（不再假设 D:/code/dsh-android）
 *
 * GRADLE_USER_HOME 默认落在仓库旁的 .gradle-home（可用 $GRADLE_USER_HOME 覆盖）。
 * 这条规则来自一次真实事故：默认写到 C 盘用户目录，被塞进 210MB 依赖缓存。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 找到可用的 Gradle 启动器。
 * @returns {{cmd: string, args: string[], label: string}} 可交给 spawnSync 的命令。
 */
function resolveGradle() {
    // 1) 仓库自带的 wrapper —— 最可移植，也保证版本一致。
    const isWin = process.platform === 'win32';
    const wrapper = path.join(ROOT, isWin ? 'gradlew.bat' : 'gradlew');
    if (fs.existsSync(wrapper)) {
        return { cmd: wrapper, args: [], label: 'wrapper ' + path.basename(wrapper) };
    }
    // 2) 显式指定。
    if (process.env.DSH_GRADLE && fs.existsSync(process.env.DSH_GRADLE)) {
        return { cmd: process.env.DSH_GRADLE, args: [], label: 'DSH_GRADLE' };
    }
    // 3) PATH 上的 gradle。
    return { cmd: 'gradle', args: [], label: 'PATH gradle' };
}

const gradle = resolveGradle();
const env = { ...process.env };
// 清掉会传染给子进程的 node shim（历史上被这个坑过）。
env.NODE_OPTIONS = '';
if (!env.JAVA_HOME && process.env.DSH_JAVA_HOME) env.JAVA_HOME = process.env.DSH_JAVA_HOME;
// GRADLE_USER_HOME 的默认值：优先**复用机器上已有的** Gradle home。
//
// 为什么不是无条件用仓库内的 .gradle-home：wrapper 发现 home 里没有对应版本就会
// **联网重新下载**整个 Gradle（220MB），在没网/被墙的环境直接构建失败 —— 实测踩过。
// 而大多数开发机上已经有一份（Android Studio 装的、或之前构建留下的）。
// 所以顺序是：环境变量 > 已知的本地 home > 仓库内新建。
if (!env.GRADLE_USER_HOME) {
    const candidates = [
        process.env.DSH_GRADLE_HOME,
        'D:/Android/.gradle',                                   // 本项目的惯用位置
        path.join(process.env.USERPROFILE ?? '', '.gradle'),     // Gradle 默认
        path.join(ROOT, '.gradle-home'),
    ].filter(Boolean);
    const usable = candidates.find(function (c) {
        // 判定「可用」= 里面已经有 wrapper/dists，说明至少下过一次发行版。
        return fs.existsSync(path.join(c, 'wrapper', 'dists'));
    });
    env.GRADLE_USER_HOME = usable ?? path.join(ROOT, '.gradle-home');
}

const args = process.argv.slice(2);
if (args.length === 0) args.push(':app:assembleDebug');

/**
 * 产物路径：从 gradle 任务名推导出 buildType。
 *
 * ⚠️ 之前这里**写死** app/build/outputs/apk/debug/app-debug.apk，于是：
 *   · 跑 assembleRelease 时删的是 debug 的产物、查的也是 debug 的；
 *   · release 构建明明成功，脚本却报「仍然没有产物：…app-debug.apk」。
 * 后果不是「构建失败」而是**「构建成功但脚本说失败」** —— 极易误判成
 * 构建问题而去查 gradle，实际 gradle 早就 BUILD SUCCESSFUL 了。
 *
 * 之前几次「release 构建成功」其实读的是上一轮留下的旧 APK（时间戳没变），
 * 也是这个 bug 掩盖的。
 */
function apkOutputPath(taskArgs) {
    const task = taskArgs.find((a) => /^:app:assemble/i.test(a)) ?? ':app:assembleDebug';
    // :app:assembleRelease → Release；:app:assembleW7Release → W7Release
    const variant = task.slice(':app:assemble'.length);
    // 首字母小写的 Gradle 目录名：Release → release
    const dir = variant.charAt(0).toLowerCase() + variant.slice(1);
    return path.join(ROOT, 'app', 'build', 'outputs', 'apk', dir, `app-${dir}.apk`);
}

// ⚠️ 先删旧 APK。实测：把一个更小的 APK 写到已存在的大 APK 上时，写入方没有
// 截断文件，旧 APK 中段会留下几十 MB 的孤儿字节（实测 119.8MB 的产物写出
// 163.6MB，中段 43.8MB 不属于任何 zip 条目）。APK 仍可解析、可安装，但体积
// 虚高，排查很费时间。删掉旧产物让写入方从零开始。
const apkOut = apkOutputPath(args);
fs.rmSync(apkOut, { force: true });

console.log('[build] gradle: ' + gradle.label + ' (' + gradle.cmd + ')');
console.log('[build] GRADLE_USER_HOME=' + env.GRADLE_USER_HOME);
console.log('[build] JAVA_HOME=' + (env.JAVA_HOME ?? '(由 Gradle 自行探测)'));

// Node 修复 CVE-2024-27980 后 spawn .bat 必须经 cmd.exe，否则 EINVAL。
const useCmd = process.platform === 'win32' && /\.(bat|cmd)$/i.test(gradle.cmd);
const result = useCmd
    ? spawnSync('cmd.exe', ['/c', gradle.cmd, '--no-daemon', ...args], { cwd: ROOT, stdio: 'inherit', env })
    : spawnSync(gradle.cmd, [...gradle.args, '--no-daemon', ...args], { cwd: ROOT, stdio: 'inherit', env });

if (result.error) {
    console.error('');
    console.error('spawn failed: ' + result.error.message);
    console.error('');
    console.error('找不到可用的 Gradle。三种解法（任选其一）：');
    console.error('  1. 生成 wrapper 并提交（推荐）：在装有 Gradle 的机器上执行 gradle wrapper');
    console.error('  2. 指定已有安装：set DSH_GRADLE=C:\\path\\to\\gradle\\bin\\gradle.bat');
    console.error('  3. 把 gradle 放进 PATH');
}
// ⚠️ 防"绿灯但没产物"：Gradle 的 dexBuilderDebug 可能判定 UP-TO-DATE 而跳过，
// 但我们刚把旧 APK 删了。若构建成功却没有产物，强制重打包一次再报。
if ((result.status ?? 1) === 0 && !fs.existsSync(apkOut)) {
    console.log('[build] 构建成功但没有 APK，重跑一次打包任务（:app:dexBuilderDebug --rerun）');
    const retry = useCmd
        ? spawnSync('cmd.exe', ['/c', gradle.cmd, '--no-daemon', ':app:dexBuilderDebug', '--rerun-tasks'], { cwd: ROOT, stdio: 'inherit', env })
        : spawnSync(gradle.cmd, ['--no-daemon', ':app:dexBuilderDebug', '--rerun-tasks'], { cwd: ROOT, stdio: 'inherit', env });
    if (!fs.existsSync(apkOut)) {
        console.error('[build] 仍然没有产物：' + apkOut);
        process.exit(1);
    }
}
process.exit(result.status ?? 1);
