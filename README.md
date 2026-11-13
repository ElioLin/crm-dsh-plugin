# CRM 智能工作台 (CRM Workspace Hub)

面向 Salesforce / SFOA 一线业务人员的 Deepseek Harness (RUNAI) 插件：**动态场景容器 + 显式 Skill 组装器**。

面板本身不含任何业务内容——所有场景卡片都是管理员在插件里配置的数据（`ScenarioCardConfig`）。用户点开一张卡片时，插件严格按该卡片 `pinnedSkills` 数组的顺序激活对应的 Skill 栈，并把「场景说明 + 默认上下文 + Skill 名称」注入到该会话后续的模型请求里（默认不注入技能介绍与正文，由模型按顺序用 `skill` 工具加载）。**没有任何全局 Skill 盲路由**：模型看到哪些技能，完全由管理员为这个场景勾选的顺序决定。

---

## 1. 能力边界

| 能做什么 | 不做什么 |
| --- | --- |
| 按配置动态渲染场景卡片（增删改、启停、排序、复制） | 不内置任何写死的演示卡片 |
| 点卡片 = 按序装配该卡片的 Skill 栈 | 不扫描全量 Skill 让模型自己挑 |
| 把场景说明/默认对象/默认动作/Skill 名称注入模型请求 | 不修改、不覆盖用户自己的提问 |
| 把每张卡片的 `slashCommand` 注册成真正的 Host 指令 | 不在卡片里直接执行 DML/查询 |
| 默认只给 Skill 名称（正文由 `skill` 工具按序加载），可配置改为直填正文 | 不把 Skill 介绍/正文复述给用户，也不写进会话历史 |
| 会话标题栏显示「场景 · 标题」标签 | 不伪造聊天消息来表达场景 |
| 存档原子落盘、损坏隔离、版本保护 | 不在存档损坏时静默覆盖用户配置 |

业务动作（建单、改单、查询、分析）依旧由 Skill 里描述的工具（如 `sfoa_*` / `crm_*` MCP 工具）完成。本插件负责「在正确的时间、把正确的技能与上下文交给模型」。

---

## 2. 运行架构

```
┌──────────────────────────── 浏览器 (Web GUI) ────────────────────────────┐
│  main 面板 (key: crm-workspace)          sidebar.panellist 入口          │
│  ┌────────────────────────────────┐      ┌──────────────────────────┐   │
│  │ 场景卡片网格 / 管理模式编辑器   │      │ 图标按钮（可被关闭）      │   │
│  └───────────────┬────────────────┘      └──────────────────────────┘   │
└──────────────────┼──────────────────────────────────────────────────────┘
                   │ 同源 POST /crm-workspace/api  {method, params}
┌──────────────────▼──────────────────────────────────────────────────────┐
│ Host 插件 (dsh-crm-workspace)                                           │
│  lib/web.js    路由 + 方法白名单 + 回环/同源校验 + 1 MiB 限制            │
│  lib/core/api.js   业务门面（存档 × Skill 仓库）
│  lib/core/skilldir.js Skill 目录兜底（解析 <dir>/<skill>/SKILL.md）      │
│  lib/core/state.js 原子落盘存档 <profile>/crm-workspace/state.json       │
│  lib/core/block.js 上下文块组装（预算截断、缺失标注、顺序不变）          │
│  lib/index.js  agent/pre-step 注入 + commands.register 指令             │
└──────────────────┬──────────────────────────────────────────────────────┘
                   │ agent/pre-step（waterfall，按会话过滤）
              模型请求 messages: [ …, {role:'user', content:'[[crm-workspace:context]] …'} ]
```

关键点：注入发生在 **`agent/pre-step`** 这个 waterfall 事件里，按 `payload.agent.id`（= 会话 id）过滤，因此：

- 激活记录先落盘、再开始对话也能生效（不要求 Agent 已创建）；
- 注入不会写进会话历史，不会污染用户可见的消息流；
- 注入消息由「会话里已有的用户消息」克隆而来（只换 `id` 与 `text`），避免手写 `MessageBase` 造成下游判为非法消息。

---

## 3. 场景数据模型

```ts
export interface ScenarioCardConfig {
  scenarioId: string;          // 唯一场景编码，如 "crm_record_mutation_base"
  title: string;               // 卡片标题
  description: string;         // 【必填】管理员填写的场景介绍，显示在卡片正文
  icon: string;                // 图标标识（12 个内置图标之一）
  category: string;            // 业务分类标签
  slashCommand: string;        // 快捷指令，如 "/record"
  enabled: boolean;            // 是否在运行态展示/可被指令唤醒
  isSystemBase?: boolean;      // 系统底座场景标记
  pinnedSkills: string[];      // 显式绑定的 Skill 标识，数组顺序 = 执行顺序
  prePinnedContext: {
    defaultObjectApiName?: string;                  // 留空则由模型按上下文发现
    defaultAction?: 'CREATE' | 'UPDATE' | 'AUTO';
    formContextEntry: 'STANDARD' | 'QUICK_ACTION';
    allowAttachments: boolean;
  };
  welcomeMessage: string;      // 进入场景时的开场引导语
}
```

落盘时的字段顺序与之完全一致；`scenarioId` 可由标题自动推导（纯中文标题会退化为 `crm_scene`，冲突时追加 `_2`、`_3`）。

`description` 是**必填**且**不允许只填空白**：它是卡片正文，也是注入块里「场景说明（管理员填写）」那一段，模型据此判断这次会话的适用范围。

---

## 4. 安装

插件只依赖宿主提供的模块（`react`、Cordis 服务、`webServer`），**运行期零 npm 依赖**，因此不需要打包构建。

```powershell
# 1) 把插件放进 profile 的 node_modules
Copy-Item -Recurse -Force D:\GitProject\crm-dsh-plug `
  "$env:DSH_PROFILE_DIR\node_modules\dsh-crm-workspace"

# 2) 让 profile 加载它（把包名加进 dsh.profile.bundles）
#    编辑 <profile>\package.json：
#    "dsh": { "profile": { "bundles": [ ..., "dsh-crm-workspace" ] } }

# 3) 重启 DSH（Host 插件在进程启动时装配）
```

重启后：

- 侧边栏出现「CRM 智能工作台」入口（可在配置里用 `showSidebarEntry: false` 隐藏）；
- 面板打开后是**空状态**——这是设计如此，没有任何演示卡片。点「新建场景」开始配置。

### 配置项（`cordis.patch.yml` 或插件配置）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dataDir` | `<profile>/crm-workspace` | 存档目录，支持相对 profile 的路径或绝对路径 |
| `maxScenarioCards` | `200` | 场景卡片上限（1–200），超出时后端拒绝新建 |
| `injectSkillsOnStep` | `true` | 关掉后点卡片仍会激活，但不向模型注入任何内容 |
| `injectSkillBodies` | `false` | 是否把 Skill 正文直接写进注入块。默认 `false`：只注入名称，正文由模型用 `skill` 工具按顺序加载 |
| `injectSkillDescriptions` | `false` | 是否在技能栈里为每个 Skill 附一行描述。默认 `false`（少占上下文，也不让技能介绍刷屏） |
| `registerSlashCommands` | `true` | 是否把卡片指令注册成 Host 指令 `/record` |
| `showSidebarEntry` | `true` | 是否显示侧边栏入口 |
| `skillCatalogDir` | 自动探测 `<DSH_HOME>/skills` | Skill 目录兜底：扫描 `<目录>/<skill>/SKILL.md` 供选择器与注入使用；显式路径、相对 profile 路径，或 `off` 关闭 |

**为什么需要 `skillCatalogDir`**：DSH 的 `skills` 服务是**分层**注册表，插件运行在 Host 根作用域，只能看到全局层（内置 bundled Skill）。公司 Skill（`crm-core`、`crm-record-change` 等）挂在 agent preset 层，根视图看不到。插件因此额外读取一份**只读**的目录表作为兜底：只解析 `SKILL.md` 的 `name/description` 与正文，不注册进注册表、不参与路由，失败静默降级。可选项里仍然可以手动输入任意 Skill 名——即使目录里也没有，注入块会明确写「未预载」并要求模型用 `skill` 工具自行加载，绝不谎称该 Skill 不存在。

---

## 5. HTTP 接口（同源、方法白名单）

`POST /crm-workspace/api`，请求体 `{ method, params }`，响应 `{ ok: true, ...result }` 或 `{ ok: false, message, errors? }`。

| method | params | 用途 |
| --- | --- | --- |
| `bootstrap` | `{ sessions?: string[] }` | 面板首屏：插件信息、配置、词表、全部场景、指定会话的激活状态 |
| `skills.list` | `{ query? }` | 技能仓库检索（供编辑器选择 `pinnedSkills`） |
| `scenario.save` | `{ draft, previousId? }` | 新建 / 编辑（`previousId` 存在即编辑） |
| `scenario.delete` | `{ scenarioId }` | 删除，并清掉指向它的激活记录 |
| `scenario.enable` | `{ scenarioId, enabled }` | 启停 |
| `scenario.move` | `{ scenarioId, direction: 'up'\|'down' }` | 排序 |
| `scenario.duplicate` | `{ scenarioId }` | 复制为新卡片（新编码、新指令） |
| `activation.activate` | `{ sessionId, scenarioId, source }` | 激活场景并返回解析后的技能栈 |
| `activation.state` | `{ sessionId }` | 当前会话正处在哪个场景 |
| `activation.clear` | `{ sessionId }` | 退出场景 |
| `preview.injection` | `{ scenarioId, mode?: 'full'\|'reminder' }` | 管理员预览模型到底会看到什么；返回 `mode` 与 `characters`，未开 `injectSkillBodies` 时恒为 `names` |

安全边界（照抄 `dsh-mcp-connector` 的成熟做法）：

- 只接受 POST + `application/json`；
- `Host` 必须是回环地址或显式信任域名，`Sec-Fetch-Site: cross-site` 一律 403，带 `Origin` 时必须与 `Host` 完全一致；
- 请求体上限 1 MiB；方法名走 `Map` 白名单，参数不参与任何字符串拼接；
- 响应 `cache-control: no-store` + `x-content-type-options: nosniff`；
- 异常统一 500 且不回传堆栈。

---

## 6. 注入机制（这是插件的核心）

激活后，下一次模型请求会追加一条消息（`role: 'user'`，`id` 带 `-crm-` 后缀）。**默认形态（`mode=names`）不包含任何 Skill 介绍或正文**：

```
[[crm-workspace:context]] scenario=<id> mode=names
你正在「<title>」场景中工作。……

## 场景说明（管理员填写）
<description>

## 本场景的默认上下文
- 目标对象：<API 名 | 未锚定：…>
- 默认动作：新建（CREATE）/ 修改（UPDATE）/ 自动判断（AUTO）
- 表单入口：标准表单入口（STANDARD）/ 快速操作入口（QUICK_ACTION）
- 附件材料：允许…/不允许…

## 技能栈（严格按此顺序执行）
- 1. <skill>            ← 只有名称，没有介绍
- 2. <skill>

## 执行要求
- 技能栈的顺序就是执行顺序：从上到下，用 skill 工具逐个按名称加载正文 …
- 用户当次明确指示优先 …
- 不要向用户复述本块 …
```

三种形态：

| mode | 何时出现 | 内容 |
| --- | --- | --- |
| `names`（默认） | 每次请求 | 场景说明 + 默认上下文 + Skill **名称**；正文由模型按顺序用 `skill` 工具加载（约 900–1500 字符） |
| `full` | 仅当 `injectSkillBodies: true` 的首次请求 | 额外附 `## Skill 正文`（单技能 16k / 总计 48k 字符预算，超出截断并写明「原文共 N 字符」） |
| `reminder` | 仅当 `injectSkillBodies: true` 的后续请求 | 只保留顺序与要求，不重复计费正文 |

> 之前版本默认把两张 Skill 的全文（约 21 000 字符）塞进每次请求，既占上下文又让「技能介绍」在日志里刷屏。1.2.0 起默认只给名称；需要正文直填的场景可在配置里显式打开 `injectSkillBodies`。

**场景名在对话里可见**：插件在会话标题栏注册一个「场景 · <标题>」标签（`conversation.session.header.actions`，order 30），每 8 秒轮询当前会话的激活状态（页面隐藏时暂停），点击标签直接打开工作台面板。标签是 UI 投影，不写会话历史、不产生消息气泡、不消耗模型调用。

- 技能栈解析失败（Skill 服务不可用）：不阻断对话，缺失项在带正文模式下明确标注「未预载」，模型会如实告知用户缺哪个 Skill。

---

## 7. 运维与故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板提示「只读模式」 | 存档损坏或版本高于插件 | 日志/面板里有具体文件路径；损坏文件已被重命名为 `state.corrupt-<时间戳>.json`，确认后删除 `state.json` 重启即可 |
| 点卡片后模型没看到场景 | `injectSkillsOnStep: false`，或激活发生在上一条消息发送之后 | 打开配置开关；重新发送一条消息即可（激活状态持久化在存档里） |
| `/record` 指令不存在 | 卡片 `enabled: false`，或指令名与内置指令冲突 | 启用卡片；换一个 `slashCommand` |
| 技能栈里出现「未预载正文」 | 该 Skill 不在 Host 根视图，也不在 `skillCatalogDir` 目录里，且 `injectSkillBodies: true` | 正常降级：注入块会要求模型用 `skill` 工具按名加载；想让它预载正文，把 `skillCatalogDir` 指到公司 Skill 根目录。默认（不注入正文）不会出现该标注 |
| 会话标题旁没有「场景 · …」标签 | 该会话没有激活场景，或页面还是旧的客户端模块 | 在面板里点一张卡片；客户端改动需刷新页面（Ctrl+R） |
| 面板打不开 | 插件未装配（不在 `dsh.profile.bundles`） | 检查 profile 的 `package.json` 与重启日志 |

存档位置与备份：`<profile>/crm-workspace/state.json`（每次写入前会把上一份复制到 `state.backup.json`）。

---

## 8. 开发与验收

```powershell
node --test          # 69 个用例：schema / 存档 / 上下文块 / Skill 目录 / 业务门面 / HTTP / 整装集成
node scripts/check.mjs   # 交付前自检：清单字段、被引用文件、客户端加载方式、主题变量、locale、bundle patch
```

测试覆盖的关键行为：

- 缺 `description` 必须报错；`pinnedSkills` 去重且保持顺序；看不见的 Skill 只警告、不谎称不存在；
- Skill 目录：frontmatter 解析、目录扫描去重排序、目录缺失静默降级；
- 存档原子写、`changed:false` 不落盘、损坏隔离、版本降级保护、激活记录 7 天/200 条裁剪；
- 注入块：顺序、缺失标注、预算截断、`full → reminder` 只发一次正文；
- HTTP：403/405/415/400/500 全分支、业务 `ok:false` 结构化失败、堆栈不外泄；
- 整装：`apply()` 真的挂上 `/crm-workspace/api`、建卡→激活→注入闭环、指令注册与执行、重启后配置仍在。

`node scripts/check.mjs` 会拒绝 `lib/client.js` 里的硬编码颜色，确保浅色/深色主题都正常。

### 目录结构

```
lib/
  index.js        Host 装配：存档、HTTP、pre-step 注入、slash 指令
  web.js          HTTP 路由与安全校验
  client.js       浏览器端面板（经典脚本，react.createElement，无 JSX 构建）
  core/
    constants.js  常量、限额、词表
    schema.js     场景配置校验与规范化
    state.js      存档读写（原子写、损坏隔离、版本保护）
    block.js      注入块组装
    api.js        业务门面
locale/           zh.json / en.json
test/             node:test 用例
scripts/check.mjs 交付自检
```
