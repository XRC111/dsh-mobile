'use strict';
/**
 * sharp 的 Android stub（由 dsh-android 的 pack-runtime.mjs 注入）。
 *
 * libvips 没有 Android 预编译，交叉编译不现实；而 dsh-attachment-local 顶层
 * import sharp —— 不提供可加载的 sharp 整个 attachments 服务链（含
 * sessionController）都会 pending，导致 plugin tree 激活失败、应用无法启动。
 *
 * 本 stub 提供与 sharp 兼容的最小 API 面（dsh-attachment-local 实际用到的
 * 全部方法）：图片数据原样透传（不做真实重压缩），metadata 尽力解析
 * JPEG/PNG/GIF/WebP 的尺寸。压缩任务会"成功"但产出原始字节，功能可用、
 * 仅损失体积优化。
 */

function parseSize(buf) {
    try {
        if (!buf || buf.length < 24) return {};
        // PNG
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
        }
        // GIF
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
            return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
        }
        // WebP
        if (buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buf.subarray(8, 12).toString('ascii') === 'WEBP') {
            if (buf.subarray(12, 16).toString('ascii') === 'VP8X') {
                return {
                    width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
                    height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
                    format: 'webp',
                };
            }
            return { format: 'webp' };
        }
        // JPEG: 扫 SOF0-SOF15 取尺寸
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let off = 2;
            while (off + 9 < buf.length) {
                if (buf[off] !== 0xff) { off++; continue; }
                const marker = buf[off + 1];
                if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
                const len = buf.readUInt16BE(off + 2);
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), format: 'jpeg' };
                }
                off += 2 + len;
            }
            return { format: 'jpeg' };
        }
        return {};
    } catch {
        return {};
    }
}

class SharpStub {
    constructor(input) {
        this._input = Buffer.isBuffer(input) ? input
            : (typeof input === 'string' ? null : (input || null)); // 文件路径不支持，透传空
        this.options = {};
    }
    metadata() { return Promise.resolve(parseSize(this._input)); }
    clone() { return new SharpStub(this._input); }
    rotate() { return this; }
    resize() { return this; }
    trim() { return this; }
    extract() { return this; }
    flip() { return this; }
    flop() { return this; }
    modulate() { return this; }
    composite() { return this; }
    withMetadata() { return this; }
    keepMetadata() { return this; }
    jpeg() { return this; }
    png() { return this; }
    webp() { return this; }
    gif() { return this; }
    tiff() { return this; }
    avif() { return this; }
    heif() { return this; }
    blur() { return this; }
    sharpen() { return this; }
    grayscale() { return this; }
    normalise() { return this; }
    linear() { return this; }
    ensureAlpha() { return this; }
    ensureAlpha_(value) { return this; }
    toBuffer() {
        return Promise.resolve(Buffer.isBuffer(this._input) ? this._input : Buffer.alloc(0));
    }
    toFile(file) { return Promise.resolve({ size: 0 }); }
    toColourspace() { return this; }
    toColorspace() { return this; }
}

function sharp(input, options) {
    return new SharpStub(input, options);
}
sharp.format = {
    jpeg: { id: 'jpeg', input: { mime: 'image/jpeg' }, output: { mime: 'image/jpeg' } },
    png: { id: 'png', input: { mime: 'image/png' }, output: { mime: 'image/png' } },
    webp: { id: 'webp', input: { mime: 'image/webp' }, output: { mime: 'image/webp' } },
    gif: { id: 'gif', input: { mime: 'image/gif' }, output: { mime: 'image/gif' } },
    tiff: { id: 'tiff', output: { mime: 'image/tiff' } },
    avif: { id: 'avif', output: { mime: 'image/avif' } },
    heif: { id: 'heif', output: { mime: 'image/heif' } },
    raw: { id: 'raw', input: { mime: 'image/raw' } },
    jp2: { id: 'jp2', output: { mime: 'image/jp2' } },
    jxl: { id: 'jxl', output: { mime: 'image/jxl' } },
    magick: { id: 'magick', input: { mime: 'image/magick' } },
    openslide: { id: 'openslide', input: {} },
    dz: { id: 'dz', output: {} },
    fit: { id: 'fit', output: {} },
    v: { id: 'v', output: {} },
};
sharp.versions = { vips: '8.0.0-dsh-android-stub', cimg: 'stub' };
sharp.cache = function () { return sharp; };
sharp.concurrency = function () { return 1; };
sharp.count = function () { return 0; };
sharp.queue = function () { return 0; };
sharp.simd = function () { return false; };
sharp.block = function () {};
sharp.unblock = function () {};
sharp.defaults = function () { return {}; };
sharp.stop = function () {};
sharp.inputCounters = function () { return {}; };
sharp.VipsInput = function VipsInput() {};
sharp.VipsOutput = function VipsOutput() {};
sharp.VipsInterpolate = function VipsInterpolate() {};

module.exports = sharp;
module.exports.default = sharp;
