#!/usr/bin/env node
/**
 * 生成 DSH 插件市场索引（format 1）。
 *
 * 用途：把公司内部插件收成一份静态 JSON，员工在
 * 「插件 → 发现 → 索引源」里加一次 URL，之后就能像逛市场一样搜到并安装，
 * 不必记包名、也不必手改 profile 配置。
 *
 * 用法：
 *   node scripts/build-index.mjs                        # 只收当前仓库
 *   node scripts/build-index.mjs ../another-plugin      # 再收一个（目录或 package.json）
 *   node scripts/build-index.mjs --out build/index.json .
 *
 * 索引里每条都指向 registry 上的包名，所以**发版后要重新生成并重新上传**
 * 这份 JSON，员工那边才能在「发现」里看到新版本。
 *
 * 索引格式参考 @deepseek-ai/dsh-plugin-market-index（format 1）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULTS = {
  out: 'build/index.json',
  titleZh: '公司内部插件',
  titleEn: 'Internal Plugins',
  descriptionZh: '公司内部维护的 DSH 插件。安装前请确认来源可信。',
  descriptionEn: 'DSH plugins maintained in-house. Install only from sources you trust.',
  category: 'workflow',
  /** 声明 DSH 版本兼容范围：装到太老的宿主上会缺宿主服务。 */
  dshRange: '>=0.2.0',
};

/** 分类字典：key 是索引里的 category，值是给界面看的中英文名。 */
const CATEGORY_TITLES = {
  workflow: { en: 'Workflow', zh: '工作流' },
  tools: { en: 'Tools', zh: '工具' },
  data: { en: 'Data', zh: '数据' },
  ui: { en: 'Interface', zh: '界面' },
  integration: { en: 'Integration', zh: '系统集成' },
  productivity: { en: 'Productivity', zh: '效率' },
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out' && argv[index + 1] !== undefined) {
      options.out = argv[index + 1];
      index += 1;
    } else if (arg === '--title' && argv[index + 1] !== undefined) {
      options.titleZh = argv[index + 1];
      index += 1;
    } else if (arg === '--dsh-range' && argv[index + 1] !== undefined) {
      options.dshRange = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('--')) {
      options.targets.push(arg);
    }
  }
  if (options.targets.length === 0) options.targets.push('.');
  return options;
}

/** 目标可以是插件目录、package.json，或一个含多个插件目录的父目录。 */
function manifestPathFor(target) {
  const absolute = resolve(target);
  return absolute.endsWith('.json') ? absolute : join(absolute, 'package.json');
}

function readManifest(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`读不到 ${filePath}`);
  }
  const manifest = JSON.parse(raw);
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${filePath} 没有 name`);
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${filePath} 没有 version`);
  }
  if (manifest.dsh?.bundle?.patch === undefined) {
    throw new Error(`${filePath} 不是 bundle 插件（缺少 dsh.bundle.patch），装进市场也加载不了`);
  }
  return manifest;
}

/**
 * 一条索引条目。展示信息优先取 package.json 里的 `dsh.index`，
 * 没配就退回包名与 description —— 不猜、不硬编码业务文案。
 */
function entryFor(manifest) {
  const index = manifest.dsh?.index ?? {};
  const repository = manifest.repository;
  const repositoryUrl =
    typeof repository === 'string' ? repository : typeof repository?.url === 'string' ? repository.url : '';

  const zh = typeof index.titleZh === 'string' && index.titleZh !== '' ? index.titleZh : manifest.name;
  const en = typeof index.titleEn === 'string' && index.titleEn !== '' ? index.titleEn : manifest.name;
  const description = typeof manifest.description === 'string' ? manifest.description : '';

  return {
    name: manifest.name,
    title: zh,
    description: {
      en: typeof index.descriptionEn === 'string' && index.descriptionEn !== '' ? index.descriptionEn : description,
      zh: typeof index.descriptionZh === 'string' && index.descriptionZh !== '' ? index.descriptionZh : description,
    },
    ...(typeof index.homepage === 'string' && index.homepage !== '' ? { homepage: index.homepage } : {}),
    ...(repositoryUrl === '' ? {} : { repository: { url: repositoryUrl } }),
    metadata: {
      category: typeof index.category === 'string' && index.category !== '' ? index.category : DEFAULTS.category,
      keywords: Array.isArray(index.keywords) ? index.keywords : [],
      labels: [],
      sortKeys: {},
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: Math.floor(Date.now() / 1000),
        source: { type: 'npm' },
        engines: { dsh: index.dshRange ?? DEFAULTS.dshRange },
      },
    ],
  };
}

function build(options) {
  const plugins = [];
  const seen = new Set();
  for (const target of options.targets) {
    const manifest = readManifest(manifestPathFor(target));
    if (seen.has(manifest.name)) {
      console.error(`跳过重复的包：${manifest.name}`);
      continue;
    }
    seen.add(manifest.name);
    plugins.push(entryFor(manifest));
  }

  // categories 是给 UI 分组用的字典：这里只声明实际用到的分类。
  const categories = {};
  for (const plugin of plugins) {
    const key = plugin.metadata.category;
    if (categories[key] === undefined) {
      categories[key] = { title: CATEGORY_TITLES[key] ?? { en: key, zh: key } };
    }
  }

  return {
    format: 1,
    title: { en: options.titleEn, zh: options.titleZh },
    description: { en: options.descriptionEn, zh: options.descriptionZh },
    metadata: { categories, labels: {}, sortKeys: {} },
    plugins,
  };
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`生成 DSH 插件市场索引（format 1）

  node scripts/build-index.mjs [选项] [插件目录 | package.json ...]

选项
  --out <路径>        输出文件，默认 ${DEFAULTS.out}
  --title <中文名>    索引标题，默认「${DEFAULTS.titleZh}」
  --dsh-range <范围>  声明的 DSH 兼容范围，默认 ${DEFAULTS.dshRange}

生成的 JSON 放到任意可访问的静态地址（内网 nginx / 对象存储 / GitHub Pages），
员工在「插件 → 发现 → 索引源」里加一次这个 URL 即可。
发版后重新生成并覆盖同一个地址，员工那边就能看到新版本。`);
  process.exit(0);
}

const document = build(options);
mkdirSync(dirname(resolve(options.out)), { recursive: true });
writeFileSync(resolve(options.out), `${JSON.stringify(document, null, 2)}\n`, 'utf8');

console.log(`已生成 ${resolve(options.out)}`);
for (const plugin of document.plugins) {
  console.log(`  · ${plugin.name}@${plugin.versions[0].version} —— ${plugin.title}`);
}
console.log('\n下一步：把这份 JSON 上传到内网静态地址，员工在「插件 → 发现 → 索引源」添加该 URL。');
