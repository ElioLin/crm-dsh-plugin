# CRM 智能工作台 (CRM Workspace Hub)

面向 Salesforce / SFOA 一线业务人员的 Deepseek Harness (RUNAI) 插件：**动态场景容器 + 显式 Skill 组装器**。

面板本身不含任何业务内容——所有场景卡片都是管理员在插件里配置的数据（`ScenarioCardConfig`）。用户点开一张卡片时，插件严格按该卡片 `pinnedSkills` 数组的顺序激活对应的 Skill 栈，并把「场景说明 + 默认上下文 + Skill 名称」注入到该会话后续的模型请求里（默认不注入技能介绍与正文，由模型按顺序用 `skill` 工具加载）。**没有任何全局 Skill 盲路由**：模型看到哪些技能，完全由管理员为这个场景勾选的顺序决定。

---

## 1. 能力边界

| 能做什么 | 不做什么 |
| --- | --- |
| 按配置动态渲染场景卡片（增删改、启停、排序、复制） | 不内置任何写死的演示卡片 |
| 「已安装的场景（我的）/ 公司推出的场景（Runner）」双页签：本地已安装与 MCP 标准库分离 | 不把远端新场景在同步时自动塞进「已安装」 |
| 与 MCP 控制平面（`/api/dsh/**`）对接：权限、发布、编辑、软删除、附件上传/删除 | 不绕过服务端 `auth.canManageStandardScenario` 判断权限 |
| 已安装标准场景按 `revision/version` 自动静默升级，并按 `sha256` 增量更新附件 | 不重复下载哈希未变的附件 |
| 普通用户对标准场景只读，可「复制为本地场景」后自由编辑 | 不直接修改普通用户本地的标准场景副本 |
| 点卡片 = 按序装配该卡片的 Skill 栈 | 不扫描全量 Skill 让模型自己挑 |
| 把场景说明/默认对象/默认动作/Skill 名称注入模型请求 | 不修改、不覆盖用户自己的提问 |
| 新会话输入框上方常驻「正在使用场景」徽标（含切换/退出） | 不用消息气泡伪造场景状态 |
| 进入场景时自动把 `inputDraft \|\| welcomeMessage` 填进输入框（光标在末尾） | 不覆盖用户已经键入的草稿 |
| 把场景预设附件（`SCENARIO_PRESET`）自动挂进待发送附件托盘 | 不把预设附件当成用户的业务原始材料归档 |
| 注入块里声明附件边界，禁止把预设附件上传到 CRM 单据 | 不静默上传任何文件 |
| 场景包导出/导入（`.crm-scenario.json`，附件内联） | 不导出存档里的其他场景或用户数据 |
| 有标准场景管理权限的用户通过 MCP 控制平面创建/编辑/软删除标准场景 | 无权限时不发写请求，只保存本地并说明原因 |
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
│  │ 双页签：已安装的场景（我的）/ 公司推出的场景（Runner）│      │ 图标按钮（可被关闭）      │   │
│  │ 场景卡片网格 / 管理模式编辑器   │      └──────────────────────────┘   │
│  └───────────────┬────────────────┘                                     │
│  conversation.input.dock：🟢 正在使用场景【…】 (v1.2.3) [切换] [× 退出]  │
└──────────────────┼──────────────────────────────────────────────────────┘
                   │ 同源 POST /crm-workspace/api  {method, params}
                   │ 同源 GET  /crm-workspace/asset/<file>  （预设附件）
┌──────────────────▼──────────────────────────────────────────────────────┐
│ Host 插件 (dsh-crm-workspace)                                           │
│  lib/web.js    路由 + 方法白名单 + 回环/同源校验 + 40 MiB 限制            │
│  lib/core/api.js   业务门面（存档 × Skill 仓库 × 附件资产 × MCP 标准场景）│
│  lib/core/assets.js  场景预设附件资产目录（类型校验、sha256、防目录穿越）  │
│  lib/core/registry.js MCP 控制平面客户端（8 个 /api/dsh 接口 + 双向映射）  │
│  lib/core/skilldir.js Skill 目录兜底（解析 <dir>/<skill>/SKILL.md）      │
│  lib/core/state.js 原子落盘存档 <profile>/crm-workspace/state.json       │
│  lib/core/block.js 上下文块组装（预算截断、缺失标注、附件边界声明）       │
│  lib/index.js  agent/pre-step 注入 + commands.register 指令             │
└──────────────────┬──────────────────────────────────────────────────────┘
                   │ agent/pre-step（waterfall，按会话过滤）
              模型请求 messages: [ …, {role:'user', content:'[[crm-workspace:context]] …'} ]
```

预设附件的资产落在 `<dataDir>/attachments/`（默认 `<profile>/crm-workspace/attachments/`），只有在场景卡片里登记过的文件才会被面板与注入块引用；删除卡片或移除附件时对应文件一并清理。

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
  welcomeMessage: string;      // 进入场景时的开场引导语（注入块里的「场景说明」之外的引导）
  inputDraft?: string;         // 【可选】新会话开屏时自动填进输入框的草稿/填空模板
  presetAttachments?: Array<{  // 【可选】场景内置附件，随新会话自动进入待发送托盘
    attachmentId: string;      // 唯一标识，落盘文件名由它派生
    fileName: string;          // 展示名，如「拜访纪要标准模板.docx」
    mimeType: string;         // MIME 类型，缺省按扩展名推断
    localPathOrUrl: string;   // 资产目录内的相对文件名，或远端 http(s) 地址
    fileSize: number;
    sha256?: string;           // 远端标准场景附件哈希：未变化时不重复下载
    downloadUrl?: string;      // 远端返回的相对下载路径（如 /api/dsh/scenarios/.../attachments/...）
    role: 'SCENARIO_PRESET';  // 固定标识：与用户临时上传的业务附件区分
  }>;
  sourceType?: 'LOCAL_CUSTOM' | 'COMPANY_STANDARD'; // 本地自建/副本 / 公司标准
  readonlyForNormalUser?: boolean; // 标准场景对普通用户强制只读
  isStandardPublished?: boolean; // 是否为公司标准场景
  status?: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED'; // 远端状态
  version?: string;              // 语义化版本，用于比对标准库更新
  revision?: number;             // 服务端整型修订号，每次 PUT/附件增删自动 +1
  author?: string;               // 创建人：由宿主当前登录用户自动带出，界面只读
  originScenarioId?: string;     // 从公司标准库安装时记录来源编码
}
```

落盘时的字段顺序与之完全一致；`scenarioId` 可由标题自动推导（纯中文标题会退化为 `crm_scene`，冲突时追加 `_2`、`_3`）。

`inputDraft` 与 `welcomeMessage` 的分工：`welcomeMessage` 是「AI 开场引导」（展示在会话顶部/提示里），`inputDraft` 是「输入框预填」。两者都不填时不允许保存；`inputDraft` 留空则回落到 `welcomeMessage`（面板据此决定 `draft.source`）。

`presetAttachments` 只接受 `.docx/.xlsx/.csv/.pdf/.md/.txt`，单个文件上限 10 MiB、每张卡片最多 20 个（与服务端限制一致）；`role` 一律被规范化为 `SCENARIO_PRESET`，`localPathOrUrl` 不允许 `..` 之类的越界路径。抽屉里支持一次多选、逐个上传（单个失败不影响其余）、逐个移除，并实时显示「已上传 N / 20」。

`author` 由宿主带出：优先用 `defaultAuthor` 配置，其次读宿主账号资料的显示名，最后回退到进程用户；界面上是只读字段，前端无法改写。

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
| `apiBaseUrl` | `http://crmmcptest.runner-corp.com.cn:9000` | MCP 控制平面基础地址。地址解析只有一条规则：优先本配置，未配置用内置默认值，并自动去掉末尾斜杠；上生产只改这里 |
| `authMode` | `buntu` | 身份模式：`buntu` 转发用户 Buntu Token；`internal_bearer` 使用 MCP 客户端 Token + 平台用户标识 |
| `buntuToken` | 空 | `buntu` 模式的用户 Token；留空时尝试从当前 DSH 宿主账号上下文读取 |
| `mcpClientToken` | 空 | `internal_bearer` 模式的 MCP 客户端 Token |
| `platformUserId` | 空 | `internal_bearer` 模式的平台用户标识（`X-SFOA-Platform-User`） |
| `defaultAuthor` | 空（读宿主账号资料） | 「创建人」兜底值：显式配置后固定使用它；留空则依次尝试远端 `auth.crmUsername`、宿主 `deepseekAccount` 资料、进程用户名 |

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
| `scenario.attachment.save` | `{ fileName, mimeType?, dataBase64 }` | 上传场景预设附件到 `<dataDir>/attachments/`，返回 `{ attachment, url }` |
| `registry.list` | `{ refresh? }` | 调用 `GET /api/dsh/scenarios?includeDeleted=true`，同步公司标准场景并静默升级/卸载本地已安装标准场景 |
| `scenario.permission` | `{ refresh? }` | 调用 `GET /api/dsh/scenarios/permission`；前端只认 `auth.canManageStandardScenario` |
| `scenario.sync` | `{}` | 立即执行一次标准场景同步 + 已安装版本核对 |
| `scenario.install` | `{ scenarioId }` | 把标准场景（含预设附件）安装到「已安装的场景」；重复安装幂等，返回 `installed:false` |
| `scenario.fork` | `{ scenarioId }` | 把标准场景深拷贝为本地副本（新 ID、`(本地副本)` 标题、`LOCAL_CUSTOM`、可自由编辑） |
| `scenario.export` | `{ scenarioId, source?: 'local'\|'company' }` | 导出 `<scenarioId>.crm-scenario.json` 场景包（附件内联 base64 + sha256） |
| `scenario.import` | `{ package }` | 导入场景包：重新分配 `scenarioId`、还原附件、冲突指令自动改名 |
| `scenario.publish` | `{ scenarioId }` | 兼容入口：把本地卡片作为新的公司标准场景提交（需要管理权限） |

另有只读资产路由 `GET /crm-workspace/asset/<file>`：同样的回环/同源校验，只允许单段文件名、`cache-control: private, max-age=300`，找不到时 404。

安全边界（照抄 `dsh-mcp-connector` 的成熟做法）：

- 只接受 POST + `application/json`；
- `Host` 必须是回环地址或显式信任域名，`Sec-Fetch-Site: cross-site` 一律 403，带 `Origin` 时必须与 `Host` 完全一致；
- 请求体上限 40 MiB（预设附件以 base64 内联上传）；方法名走 `Map` 白名单，参数不参与任何字符串拼接；
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

如果卡片配置了 `presetAttachments`，注入块会在「默认上下文」之后额外插入一段（技能栈之前）：

```
## 场景预设附件（SCENARIO_PRESET）
- 拜访纪要标准模板.docx（application/vnd...wordprocessingml.document，2.0 KB）
- 字段清单.csv（text/csv，12 B）

【附件边界声明】当前会话自动带入的场景预设附件（标记为 SCENARIO_PRESET）仅作为业务规则、模板或字段提取参考；在调用 upload_files_to_record 归档单据附件时，严禁将场景预设附件上传至 CRM 业务单据中，仅允许归档用户在本轮对话中实际提供的业务原始材料。
```

「执行要求」里还有一条对应的复述。这样即使用户在对话里说「把附件传上去」，模型也不会把模板文件当成业务材料。

**新会话的三个联动**（`conversation.input.dock` + `inputActions` / `conversation` 服务）：

1. 输入框正上方常驻状态条：`🟢 正在使用场景：【<标题>】 | 挂载技能：a + b`，右侧 [切换场景]（打开工作台面板）与 [× 退出场景]（清激活）。只要它存在，该会话后续每条消息都会经过 pre-step 注入。
2. 进入场景后把 `inputDraft || welcomeMessage` 写入输入框（`inputActions.setDraft`，光标自动落到末尾、可撤销）；已经键入过草稿的会话不会被覆盖。
3. 预设附件逐个从资产路由取回 → `conversation.createDrafts()` → `inputActions.addAttachments()`，进入官方待发送附件托盘（显示文件名与「场景内置附件」标签），随首条消息一起发送。

> 徽标只注册一个 slot（`conversation.input.dock`，order 20），不替换 `conversation.input.attachments` 这类官方单占位槽，因此不会遮蔽原生附件 UI。

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
| 输入框上方没有场景徽标 | 该会话未激活场景，或客户端模块未刷新 | 从面板「进入场景」；刷新页面 |
| 输入框没有被预填草稿 | 用户已经键入过内容（不会被覆盖），或 `inputDraft`/`welcomeMessage` 都为空 | 清空输入框后重新进入场景；或在卡片里补 `inputDraft` |
| 预设附件没进托盘 | 附件下载失败（远端 404/超时），或客户端拿不到 `conversation` 服务 | 看 Host 日志；把 `localPathOrUrl` 换成本地资产后重新保存卡片 |
| 「公司推出的场景」为空 | 未配置/无法访问 `apiBaseUrl`，请求未认证，或远端返回 0 条 | 检查 `apiBaseUrl`、`buntuToken`（或 internal_bearer 凭据）；点「同步」查看 Host 日志里的 HTTP 状态与 `correlationId` |
| 标准场景没有编辑/删除按钮 | 服务端 `auth.canManageStandardScenario !== true` | 这是权限红线：普通用户只能「进入场景 / 复制为本地场景 / 下载到本地」 |
| 勾选「设为插件标准场景」后只在本地 | 当前账号没有标准场景管理权限，或 MCP 服务不可用 | 让管理员补权限/凭据；本地保存不受影响 |
| 已安装标准场景版本没变化 | 远端 `version/revision` 未变，或同步请求失败 | 切到「公司推出的场景（Runner）」点「同步」；看 Host 日志 |
| 附件上传返回 `DSH_SCENARIO_INPUT_INVALID` | 请求体混入了 `version/revision/createdAt/updatedAt/presetAttachments` | 本插件所有写请求统一经 `toRemoteWritePayload` 剔除；若仍出现，检查是否有其他调用方绕过它 |
| 上传附件报「不支持的附件类型」 | 扩展名不在 `.docx/.xlsx/.csv/.pdf/.md/.txt` 内 | 转成受支持的格式，或改用远端 URL |
| 面板打不开 | 插件未装配（不在 `dsh.profile.bundles`） | 检查 profile 的 `package.json` 与重启日志 |

存档位置与备份：`<profile>/crm-workspace/state.json`（每次写入前会把上一份复制到 `state.backup.json`）。

---

## 8. 开发与验收

```powershell
node --test          # 115 个用例：schema / 存档 / 上下文块 / Skill 目录 / 业务门面 / MCP 契约 / HTTP / 资产路由 / 整装集成
node scripts/check.mjs   # 交付前自检：清单字段、被引用文件、客户端加载方式、主题变量、locale、bundle patch
```

测试覆盖的关键行为：

- 缺 `description` 必须报错；`pinnedSkills` 去重且保持顺序；看不见的 Skill 只警告、不谎称不存在；
- 场景配置：预设附件类型/MIME/大小/数量与越界路径校验、`inputDraft` 与发布元数据、非法版本收敛、`sourceType` 兜底；
- Skill 目录：frontmatter 解析、目录扫描去重排序、目录缺失静默降级；
- 存档原子写、`changed:false` 不落盘、损坏隔离、版本降级保护、激活记录 7 天/200 条裁剪；
- 注入块：顺序、缺失标注、预算截断、`full → reminder` 只发一次正文、预设附件的附件边界声明；
- 输入框契约：`activationState.draft` 优先 `inputDraft`、回落 `welcomeMessage`、附件带可拉取 URL 且不泄露落盘路径；
- 公司标准场景：默认地址、Buntu/internal_bearer 身份头、8 个 `/api/dsh` 接口、写请求剔除 `version/revision/createdAt/updatedAt/presetAttachments`、`revision/version` 自动升级、`sha256` 附件增量同步、`deletedScenarioIds` 自动卸载、普通用户只读与「复制为本地场景」；
- 新会话 3 项带入：输入框场景标识（含版本）、`inputDraft || welcomeMessage` 预填、`SCENARIO_PRESET` 附件自动挂载；
- HTTP：403/405/415/400/500 全分支、业务 `ok:false` 结构化失败、堆栈不外泄、资产路由 404；
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
    schema.js     场景配置校验与规范化（含预设附件/版本/发布元数据）
    state.js      存档读写（原子写、损坏隔离、版本保护）
    assets.js     预设附件资产目录（类型校验、防目录穿越）
    registry.js   公司标准场景注册中心客户端（列表/发布/下载）
    block.js      注入块组装（含附件边界声明）
    api.js        业务门面
locale/           zh.json / en.json
test/             node:test 用例
scripts/check.mjs 交付自检
```
