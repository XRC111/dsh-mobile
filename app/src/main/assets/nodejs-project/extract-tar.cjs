'use strict';
/**
 * 纯 JS 流式 tar.gz 解压器（dsh-android）。
 *
 * 与桌面外壳 resources/extract-runtime.cjs 同一套约定：
 * - 自解析 tar 索引（支持 GNU 'L' 与 PAX 'x' 长文件名），不依赖外部 tar
 * - 流式处理，内存占用与单文件大小相关，与整个包大小无关
 *
 * 用法：const { extractTarGz } = require('./extract-tar.cjs');
 *       await extractTarGz(srcFile, destDir);
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;

function parseOctal(buf, start, len) {
    let s = buf.slice(start, start + len).toString('utf8').replace(/[\0 ]+$/g, '').trim();
    if (!s) return 0;
    // GNU base-256 扩展
    if (buf[start] & 0x80) {
        let v = buf[start] & 0x7f;
        for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i];
        return v;
    }
    return parseInt(s, 8) || 0;
}

function parsePax(content) {
    const out = {};
    let i = 0;
    while (i < content.length) {
        const sp = content.indexOf(' ', i);
        if (sp < 0) break;
        const recLen = parseInt(content.slice(i, sp), 10);
        if (!recLen) break;
        const rec = content.slice(i + sp + 1, i + recLen).replace(/\n$/, '');
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += recLen;
    }
    return out;
}

/**
 * 解压 tar.gz。onProgress(doneBytes) 可选。
 * @returns {Promise<{files:number, dirs:number, bytes:number}>}
 */
function extractTarGz(srcFile, destDir, onProgress) {
    return new Promise((resolve, reject) => {
        const stats = { files: 0, dirs: 0, bytes: 0 };
        let buf = Buffer.alloc(0);
        let longName = null; // GNU 'L'
        let paxPath = null;  // PAX 'x'
        let done = false;

        // 魔数嗅探：1f 8b = gzip；否则当裸 tar（AAPT2 可能已把 .gz 解压存储）
        const head = Buffer.alloc(2);
        const headFd = fs.openSync(srcFile, 'r');
        fs.readSync(headFd, head, 0, 2, 0);
        fs.closeSync(headFd);
        const isGzip = head[0] === 0x1f && head[1] === 0x8b;

        const src = isGzip ? zlib.createGunzip() : null;
        const input = fs.createReadStream(srcFile);
        if (src) input.pipe(src);
        const stream = src || input;

        input.on('error', reject);
        if (src) src.on('error', reject);
        const fail = (err) => { if (!done) { done = true; input.destroy(); if (src) src.destroy(); reject(err); } };

        const feed = (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; };

        function consume() {
            // 循环消费完整 entry
            for (;;) {
                if (buf.length < BLOCK) return;
                const header = buf;
                // 全零块：继续（结尾有两个），等流结束
                if (header[0] === 0) { buf = buf.subarray(BLOCK); continue; }

                const size = parseOctal(header, 124, 12);
                const type = String.fromCharCode(header[156] || 0x30);
                const padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);
                if (buf.length < BLOCK + padded) return; // 等待更多数据

                const body = buf.subarray(BLOCK, BLOCK + size);
                let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').trim();
                const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '').trim();
                if (prefix) name = prefix + '/' + name;
                if (longName) { name = longName; longName = null; }
                if (paxPath) { name = paxPath; paxPath = null; }

                if (type === 'L') {
                    longName = body.toString('utf8').replace(/\0.*$/s, '');
                } else if (type === 'x') {
                    const pax = parsePax(body.toString('utf8'));
                    if (pax.path) paxPath = pax.path;
                } else if (type === '5') {
                    fs.mkdirSync(path.join(destDir, name), { recursive: true });
                    stats.dirs++;
                } else if (type === '0' || type === '\0' || type === '') {
                    const dest = path.join(destDir, name);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.writeFileSync(dest, body);
                    stats.files++;
                    stats.bytes += size;
                }
                // 其它类型（链接/字符设备等）：忽略
                buf = buf.subarray(BLOCK + padded);
                if (onProgress && (stats.files & 1023) === 0) {
                    try { onProgress(stats); } catch { /* ignore */ }
                }
            }
        }

        stream.on('data', (chunk) => { feed(chunk); consume(); });
        stream.on('end', () => {
            if (done) return;
            consume();
            if (buf.length >= BLOCK && buf[0] === 0) buf = buf.subarray(buf.length - (buf.length % BLOCK));
            if (buf.length > 0 && buf.some((b) => b !== 0)) {
                fail(new Error('tar 流异常：尾部残留 ' + buf.length + ' 字节'));
                return;
            }
            done = true;
            resolve(stats);
        });
    });
}

module.exports = { extractTarGz };
