/**
 * 场景预设附件的本地资产库。
 *
 * 为什么单独一层：预设附件既不是配置（不该塞进 state.json 的 Base64），
 * 也不是用户临时上传（会话结束后即消失）。它需要长期落在插件数据目录，
 * 随场景安装/删除而增删，并且只允许通过受控路径读写。
 *
 * 安全边界：
 *   - 文件名只允许白名单扩展名，且不允许路径分隔符；
 *   - 落盘名由 `attachmentId + 扩展名` 决定，用户输入进不了路径；
 *   - 读取时把相对路径 resolve 后校验必须仍在资产目录内（防 `..` 穿越）。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import {
  LIMITS,
  PRESET_ATTACHMENT_ROLE,
  SCENARIO_ID_PATTERN,
} from './constants.js';
import { extensionOf, isAllowedPresetFile, mimeForFileName } from './schema.js';

/** Base64 解出来的最大字节数（留一点余量给编码膨胀）。 */
const MAX_DECODE_BYTES = Math.ceil((LIMITS.fileSize * 4) / 3) + 1024;

function stripDataUrl(value) {
  const raw = typeof value === 'string' ? value : '';
  const comma = raw.indexOf(',');
  if (raw.startsWith('data:') && comma >= 0) return raw.slice(comma + 1);
  return raw;
}

function decodeBase64(value) {
  const raw = stripDataUrl(value).replace(/\s+/g, '');
  if (raw === '') throw new Error('附件内容为空');
  if (raw.length > MAX_DECODE_BYTES) throw new Error('附件内容超过单附件上限');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.byteLength === 0) throw new Error('附件内容不是合法的 Base64');
  if (buffer.byteLength > LIMITS.fileSize) {
    throw new Error(`单个附件不能超过 ${Math.trunc(LIMITS.fileSize / (1024 * 1024))} MB`);
  }
  return buffer;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

/** 把任意文件名压成可用于 attachmentId 的片段。 */
function idFragment(fileName) {
  const base = String(fileName).replace(/\.[^.]+$/, '');
  const ascii = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return ascii === '' ? 'file' : ascii;
}

export function createAssetStore({ dir, logger } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('资产目录不能为空');
  const root = resolve(dir);

  const assertInside = (candidate) => {
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error('非法的附件路径');
    }
    return candidate;
  };

  /** 把一个相对路径解析成绝对路径，越界直接抛错。 */
  const resolvePath = (relative) => {
    const value = typeof relative === 'string' ? relative.trim() : '';
    if (value === '' || value.includes('\0')) throw new Error('非法的附件路径');
    if (/^https?:\/\//i.test(value)) throw new Error('远端地址不在本地资产目录内');
    return assertInside(resolve(root, value));
  };

  return {
    dir: root,

    resolvePath,

    /**
     * 保存一个预设附件。
     *
     * @param {{attachmentId?: string, fileName: string, mimeType?: string, dataBase64: string}} input
     * @returns {Promise<{attachmentId: string, fileName: string, mimeType: string, localPathOrUrl: string, fileSize: number, role: string}>}
     */
    async save(input) {
      const fileName = typeof input?.fileName === 'string' ? input.fileName.trim() : '';
      if (fileName === '' || fileName.includes('/') || fileName.includes('\\')) {
        throw new Error('附件文件名不合法');
      }
      if (!isAllowedPresetFile(fileName)) {
        throw new Error(`不支持的附件类型：${extensionOf(fileName) || '(无扩展名)'}`);
      }
      const extension = extensionOf(fileName);
      const buffer = decodeBase64(input?.dataBase64);

      let attachmentId = typeof input?.attachmentId === 'string' ? input.attachmentId.trim() : '';
      if (attachmentId === '') {
        attachmentId = `att_${idFragment(fileName)}_${randomSuffix()}`;
      }
      if (!/^[a-z][a-z0-9_-]{5,63}$/.test(attachmentId)) {
        throw new Error('附件标识格式不合法');
      }

      const relative = `${attachmentId}${extension}`;
      const absolute = assertInside(join(root, relative));
      await mkdir(root, { recursive: true });
      const temporary = `${absolute}.tmp`;
      await writeFile(temporary, buffer);
      await rename(temporary, absolute);

      logger?.info?.(`[crm-workspace] 已保存预设附件 ${fileName}（${buffer.byteLength} 字节）`);

      return {
        attachmentId,
        fileName,
        mimeType: (typeof input?.mimeType === 'string' && input.mimeType.trim()) || mimeForFileName(fileName),
        localPathOrUrl: relative,
        fileSize: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        role: PRESET_ATTACHMENT_ROLE,
      };
    },

    /** 附件是否已缓存在本地资产目录内（远端 URL 一律返回 false）。 */
    exists(relative) {
      try {
        const absolute = resolvePath(relative);
        return existsSync(absolute);
      } catch {
        return false;
      }
    },

    /** 读取附件字节；路径必须落在资产目录内。 */
    async read(relative) {
      const absolute = resolvePath(relative);
      const buffer = await readFile(absolute);
      return { buffer, fileName: absolute.slice(absolute.lastIndexOf(sep) + 1) };
    },

    /** 删除附件；文件本就不存在时静默成功。 */
    async remove(relative) {
      let absolute;
      try {
        absolute = resolvePath(relative);
      } catch {
        return false;
      }
      if (!existsSync(absolute)) return false;
      try {
        await unlink(absolute);
        return true;
      } catch (error) {
        logger?.warn?.(`[crm-workspace] 删除预设附件失败：${error?.message ?? error}`);
        return false;
      }
    },

    /** 为远端附件分配一个本地的目标标识（下载前先定名，便于失败回滚）。 */
    makeId(fileName) {
      const candidate = `att_${idFragment(fileName)}_${randomSuffix()}`;
      return SCENARIO_ID_PATTERN.test(candidate) ? candidate : `att_file_${randomSuffix()}`;
    },
  };
}
