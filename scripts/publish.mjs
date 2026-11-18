#!/usr/bin/env node
/**
 * 把打包好的 tgz 直接发布到 registry。
 *
 * 为什么要绕过 `npm publish`：npm 客户端在发之前会检查本地有没有 token，
 * 没有就直接抛 ENEEDAUTH —— 哪怕服务端配的是匿名可发（`publish: $all`）。
 * 这里直接走 registry 的 PUT 接口，不需要账号，也不改任何全局 npm 配置。
 *
 * 用法：
 *   node scripts/publish.mjs <包.tgz> <registry 地址> [--dry-run]
 *   node scripts/publish.mjs build/xxx-1.12.0.tgz http://192.168.156.203:9001/
 *
 * 元数据**从 tgz 里读**，不读旁边的 package.json：包里是什么就发什么。
 * 早先版本读外部清单，结果包已经重打了、清单还是旧的，发出去的元数据和
 * 实际内容对不上（peer 声明不一致），很难查。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** 从 npm 打包的 tgz 里解出 `package/package.json`（tar 格式固定，手解够用）。 */
function manifestFromTgz(bytes) {
  const tar = gunzipSync(bytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (name === '') break;
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8) || 0;
    const dataStart = offset + 512;
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(dataStart, dataStart + size).toString('utf8'));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('tgz 里找不到 package/package.json');
}

const args = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const [tgzArg, registryArg] = args;
if (tgzArg === undefined) {
  console.error('用法：node scripts/publish.mjs <包.tgz> <registry 地址> [--dry-run]');
  process.exit(2);
}

const tgzPath = tgzArg;
const registry = (registryArg ?? 'http://127.0.0.1:9001/').replace(/\/+$/, '') + '/';

const bytes = readFileSync(tgzPath);
const manifest = manifestFromTgz(bytes);
const size = statSync(tgzPath).size;
const shasum = createHash('sha1').update(bytes).digest('hex');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
// 附件名按 npm 约定自己算，不跟着传入的文件名走：
// 有人把包存成 pkg.tgz 再发，URL 里就会留下一个看不懂的名字。
const shortName = manifest.name.includes('/') ? manifest.name.split('/')[1] : manifest.name;
const fileName = `${shortName}-${manifest.version}.tgz`;

// npm 的 URL 规则：scoped 包的斜杠要转义，否则 registry 会当成两级路径。
const packageUrl = `${registry}${manifest.name.replace('/', '%2f')}`;

const versionDoc = {
  ...manifest,
  _id: `${manifest.name}@${manifest.version}`,
  dist: {
    shasum,
    integrity,
    // Verdaccio 会按请求的 Host 重写这个地址；先填一个合法值避免它报缺字段。
    tarball: `${registry}${manifest.name}/-/${fileName}`,
  },
};

const payload = {
  _id: manifest.name,
  name: manifest.name,
  description: manifest.description ?? '',
  'dist-tags': { latest: manifest.version },
  versions: { [manifest.version]: versionDoc },
  _attachments: {
    [fileName]: {
      content_type: 'application/octet-stream',
      data: bytes.toString('base64'),
      length: size,
    },
  },
};

console.log(`发布 ${manifest.name}@${manifest.version}`);
console.log(`  包     ${tgzPath}（${size} 字节）`);
console.log(`  地址   ${packageUrl}`);
if (dryRun) {
  console.log('\n--dry-run：只校验，不发送请求。');
  process.exit(0);
}

let response;
try {
  response = await fetch(packageUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // Verdaccio 用它区分 npm 客户端版本，缺了部分版本会走老逻辑。
      'npm-command': 'publish',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
} catch (error) {
  console.error(`\n✗ 连不上 registry：${error?.message ?? error}`);
  process.exit(1);
}

const text = await response.text();
if (!response.ok) {
  console.error(`\n✗ 发布失败 HTTP ${response.status}`);
  console.error(text.slice(0, 600));
  process.exit(1);
}

console.log(`\n✓ 已发布（HTTP ${response.status}）`);
console.log(`  校验：npm view ${manifest.name} version --registry ${registry}`);
