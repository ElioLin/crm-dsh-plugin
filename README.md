# 场景工作台 (CRM Workspace Hub)

面向 Salesforce / SFOA 一线业务人员的 Deepseek Harness (RUNAI) 插件：**动态场景容器 + 显式 Skill 组装器**。

面板本身不含任何业务内容——所有场景卡片都是管理员在插件里配置的数据（`ScenarioCardConfig`）。用户点开一张卡片时，插件严格按该卡片 `pinnedSkills` 数组的顺序激活对应的 Skill 栈：把「场景说明 + 默认上下文 + Skill 名称」注入到该会话后续的模型请求里（默认不注入技能介绍与正文），同时把这些技能以 `/技能名` 预填进输入框（1.9.0 起），看起来就和用户自己引用技能一样。**没有任何全局 Skill 盲路由**：模型看到哪些技能，完全由管理员为这个场景勾选的顺序决定。

---

## 1. 能力边界

| 能做什么 | 不做什么 |
| --- | --- |
| 按配置动态渲染场景卡片（增删改、启停、排序、复制） | 不内置任何写死的演示卡片 |
| 「已安装的场景（我的）/ 标准场景」双页签：本地已安装与 MCP 标准库分离 | 不把远端新场景在同步时自动塞进「已安装」 |
| 两个页签都支持关键词搜索 + 业务系统标签筛选（筛出计数、清除筛选、无匹配空状态） | 不把筛选条件跨页签共用（标准库与本机不是同一批场景） |
| 卡片上直接露出一行「预填 <模板第一行>」 | 不把整段模板铺在卡片上（卡片高度必须一致，全文靠悬停） |
| 预填没写进输入框时在场景栏里给出可见提示与「点此重试 / 填入输入框」 | 不静默失败（旧版只写 `console.warn`），也不覆盖用户已键入的内容 |
| 与 MCP 控制平面（`/api/dsh/**`）对接：权限、发布、编辑、软删除、附件上传/删除 | 不绕过服务端 `auth.canManageStandardScenario` 判断权限 |
| 已安装标准场景按 `revision/version` 自动静默升级，并按 `sha256` 增量更新附件 | 不重复下载哈希未变的附件 |
| 普通用户对标准场景只读，可「复制为本地场景」后自由编辑 | 不直接修改普通用户本地的标准场景副本 |
| 点卡片 = 按序装配该卡片的 Skill 栈 | 不扫描全量 Skill 让模型自己挑 |
| 点卡片 = 开一段新对话（当前会话空白则复用，有消息则新建） | 不把场景硬塞进已有对话 |
| 把场景说明/附件约定/Skill 名称注入模型请求 | 不修改、不覆盖用户自己的提问 |
| 新会话输入框上方常驻「正在使用场景」徽标（含切换/退出） | 不用消息气泡伪造场景状态 |
| 新会话里以「场景开场」卡片呈现场景介绍 | 不替换宿主自己的空态标题（`小犇，我帮你` 属于 DSH，需改 DSH 侧） |
| 进入场景时把 `/技能名` + `inputDraft` 填进输入框（光标在末尾） | 不覆盖用户已经键入的草稿；也不把场景标题伪装成 `/指令` |
| 进入场景前预检绑定的 Skill：缺的自动去技能市场装，装不上就拦住并说明原因 | 不假装装上了：装不上只提示，且「仍然进入」时只带能真正路由的技能 |
| 把场景预设附件（`SCENARIO_PRESET`）自动挂进待发送附件托盘 | 不把预设附件当成用户的业务原始材料归档 |
| 注入块里声明附件边界，禁止把预设附件上传到 CRM 单据 | 不静默上传任何文件 |
| 场景包导出/导入（`.crm-scenario.json`，附件内联） | 不导出存档里的其他场景或用户数据 |
| 有标准场景管理权限的用户通过 MCP 控制平面创建/编辑/软删除标准场景 | 无权限时抽屉里连「设为插件标准场景」都不出现，只保存本地并说明原因 |
| 把每张卡片的 `slashCommand` 注册成真正的 Host 指令，并挂客户端动作（回车即激活 + 提示） | 不在卡片里直接执行 DML/查询 |
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
│  │ 双页签：已安装的场景（我的）/ 标准场景            │      │ 图标按钮（可被关闭）      │   │
│  │ 场景卡片网格 / 管理模式编辑器   │      └──────────────────────────┘   │
│  └───────────────┬────────────────┘                                     │
│  conversation.input.dock：🟢 正在使用场景【…】 (v1.2.3) [切换] [× 退出]  │
└──────────────────┼──────────────────────────────────────────────────────┘
                   │ 同源 POST /crm-workspace/api  {method, params}
                   │ 同源 GET  /crm-workspace/asset/<file>  （预设附件）
┌──────────────────▼──────────────────────────────────────────────────────┐
│ Host 插件 (@runner-corp/dsh-scenario-workspace)                           │
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
  description: string;         // 【选填】场景介绍：注入块里的「场景说明」+ 新会话「场景开场」卡片正文
  icon: string;                // 图标标识（12 个内置图标之一）
  businessSystem: string;      // 【必填】业务系统：CRM / TAPD / 其他，或任何自定义系统名
  businessSystemKey?: string;  // 由 businessSystem 派生的目录 key（crm / tapd / other / 自定义 slug）
  category: string;            // 【选填】业务分类备注，不再参与过滤，也不再拦保存
  slashCommand: string;        // 快捷指令，如 "/record"
  enabled: boolean;            // 是否在运行态展示/可被指令唤醒
  pinnedSkills: string[];      // 显式绑定的 Skill 标识，数组顺序 = 执行顺序
  prePinnedContext: {          // 仅保留附件开关；其余字段为兼容 MCP 契约而留在存档里
    allowAttachments: boolean;
    // 以下三项由 schema 补默认值以满足远端契约，界面不再暴露、注入块也不再使用：
    defaultObjectApiName?: string;                 // 目标对象 / 动作 / 表单入口
    defaultAction?: 'CREATE' | 'UPDATE' | 'AUTO';   // 一律由模型按上下文判断
    formContextEntry?: 'STANDARD' | 'QUICK_ACTION';
  };
  inputDraft: string;          // 【必填】进入场景时原样写进输入框的草稿/填空模板
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
  author?: string;               // 创建人：由 DSH 当前登录用户自动带出，界面只读
  originScenarioId?: string;     // 从公司标准库安装时记录来源编码
}
```

落盘时的字段顺序与之完全一致；`scenarioId` 可由标题自动推导（纯中文标题会退化为 `crm_scene`，冲突时追加 `_2`、`_3`）。

1.13.0 起「开场引导语」并入「场景介绍」，只剩一份文案：`description` 既是注入块里的「场景说明（管理员填写）」，也是还没消息的新会话里输入框上方那张「场景开场」卡片的正文。场景介绍选填（留空则注入块不出这一节、卡片不显示那张开场卡）；`inputDraft` 必填，原样写进输入框（1.6.0 起不再在第一行带 `/场景名称` 引用标记）。存档里的旧 `welcomeMessage` 在读取时自动迁移到这两处，不会再被写出去。

`prePinnedContext` 只剩「允许附件」一个可配置项。目标对象 API 名、默认动作、表单入口**不再由管理员配置**：不同单据、不同入口本来就该由模型结合用户当次的描述与可用工具现场判断，预先钉死一个默认值只会误导执行。这三个字段仍有默认值并被写进 MCP 写请求（服务端 zod 要求），但界面不再展示、注入块也不再引用。

`presetAttachments` 只接受 `.docx/.xlsx/.csv/.pdf/.md/.txt`，单个文件上限 10 MiB、每张卡片最多 20 个（与服务端限制一致）；`role` 一律被规范化为 `SCENARIO_PRESET`，`localPathOrUrl` 不允许 `..` 之类的越界路径。抽屉里支持一次多选、逐个上传（单个失败不影响其余）、逐个移除，并实时显示「已上传 N / 20」。

`author` 只用 DSH 自己的身份：显式配置 `defaultAuthor` → 宿主账号资料显示名 → 进程用户。**不会**使用 MCP 返回的 `auth.crmUsername`（那是 Salesforce 账号，和 DSH 里的操作人不是一回事）；公司标准场景的远端创建人仍保留在 `createdByCrmUser` / `createdByPlatformUid` 里，只在编辑抽屉里作为提示展示。界面上是只读字段，前端无法改写。

`description`（场景介绍）是**选填**：它是卡片正文，也是注入块里「场景说明（管理员填写）」那一段、以及新会话「场景开场」卡片的正文；留空时这两处都不出现（不留空标题让模型猜）。`inputDraft`（输入框预填内容）是**必填且不允许只填空白**：它决定业务人员点进场景后输入框里到底有什么，是这条链路真正的产出。

---

## 4. 安装

插件只依赖宿主提供的模块（`react`、Cordis 服务、`webServer`），**运行期零 npm 依赖**，因此不需要打包构建。

### 4.1 普通用户：从私有 registry 安装

插件以 npm 包形式发布到公司私有源，用户在自己机器上装，不需要拿到源码：

```
插件页 → 安装 → 输入 @runner-corp/dsh-scenario-workspace
```

或者命令行：

```bash
dsh plugin --profile <profile> add @runner-corp/dsh-scenario-workspace
```

前提是这台机器的 `.npmrc` 配了公司源（不需要 token，服务端对 `@runner-corp/*` 匿名可读）：

```ini
@runner-corp:registry=http://crmmcptest.runner-corp.com.cn:9001/
```

装好重启 DSH 后，侧边栏出现「场景工作台」入口（可用 `showSidebarEntry: false` 隐藏）。
面板打开是**空状态**——这是设计如此，没有任何演示卡片。

DSH ≥ 0.2.1 还能走「插件 → 发现 → 索引源」：加一次
`http://crmmcptest.runner-corp.com.cn:9001/plugins/index.json`，之后像逛市场一样点装。

### 4.2 开发态：把工作目录 link 进 profile

改代码即时生效，但**只有本机能用，且不会自动升级**：

```powershell
# 1) 在 profile 里把包指向本地目录（profile 用 pnpm 管理）
cd $env:DSH_PROFILE_DIR
pnpm add link:D:\GitProject\crm-dsh-plug

# 2) 确认 package.json 的 dsh.profile.bundles 里有 "@runner-corp/dsh-scenario-workspace"

# 3) 重启 DSH（Host 插件在进程启动时装配）
```

### 4.3 发版与升级

发布、索引源、自动升级的完整流程见 **[docs/plugin-distribution.md](docs/plugin-distribution.md)**。
要点：

- 发版只改 `package.json` 的 `version`（再同步 `lib/client.js` 的 `CLIENT_VERSION`，测试会拦住漏改）；
- 发布用 `npm pack --ignore-scripts` + `node scripts/publish.mjs <tgz> <registry>`
  （`npm publish` 会因客户端要求登录而报 `ENEEDAUTH`）；
- 用户打开面板时插件会查一次新版本，有就弹窗，确认后调宿主 `installBundle` 完成升级，**重启后生效**；
- 升级失败宿主会自动回滚 `package.json` 与 `pnpm-lock.yaml`，不会把用户留在半装状态；
- 不想被提醒就设 `autoUpdateCheck: false`。

重启后：

- 侧边栏出现「场景工作台」入口（可在配置里用 `showSidebarEntry: false` 隐藏）；
- 面板打开后是**空状态**——这是设计如此，没有任何演示卡片。点「新建场景」开始配置。

### 配置项（`cordis.patch.yml` 或插件配置）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dataDir` | `<profile>/crm-workspace` | 存档目录，支持相对 profile 的路径或绝对路径 |
| `workspaceRoot` | `<dataDir>/workspaces` | 业务系统工作区的父目录：每个系统一个子目录（`crm` / `tapd` / …）。进入场景时若对应工作区不存在，会在这里建目录并建工作区 |
| `maxScenarioCards` | `200` | 场景卡片上限（1–200），超出时后端拒绝新建 |
| `injectSkillsOnStep` | `true` | 关掉后点卡片仍会激活，但不向模型注入任何内容 |
| `injectSkillBodies` | `false` | 是否把 Skill 正文直接写进注入块。默认 `false`：只注入名称，正文由模型用 `skill` 工具按顺序加载 |
| `injectSkillDescriptions` | `false` | 是否在技能栈里为每个 Skill 附一行描述。默认 `false`（少占上下文，也不让技能介绍刷屏） |
| `registerSlashCommands` | `true` | 是否把卡片指令注册成 Host 指令 `/record` |
| `showSidebarEntry` | `true` | 是否显示侧边栏入口 |
| `skillCatalogDir` | 自动探测 `<DSH_HOME>/skills` | Skill 目录兜底：扫描 `<目录>/<skill>/SKILL.md` 供选择器与注入使用；显式路径、相对 profile 路径，或 `off` 关闭 |
| `skillRoutePrefill` | `true` | 进入场景时把绑定的 Skill 以 `/技能名` 写进输入框（与用户自己手打等价，宿主会把正文作为 instructions 注入本次请求）。关掉后只预填场景模板 |
| `autoInstallSkills` | `true` | 进入场景前发现本机缺技能时，按名字去「智能体中心」的技能市场自动安装；装不上则弹窗让用户去装。关掉后只提示、不自动装 |
| `apiBaseUrl` | `http://crmmcptest.runner-corp.com.cn:9000` | MCP 控制平面基础地址。地址解析只有一条规则：优先本配置，未配置用内置默认值，并自动去掉末尾斜杠；上生产只改这里 |
| `authMode` | `auto` | 身份模式：`auto` 先用能自动解析到的 `internal_bearer` 凭据，落空再回退 `buntu`；`internal_bearer` 强制使用 MCP 客户端 Token + 平台用户标识；`buntu` 只转发用户 Buntu Token |
| `buntuToken` | 空 | `buntu` 模式的用户 Token；留空时依次尝试 DSH 宿主账号上下文与进程环境变量 `DSH_BUNTU_TOKEN` / `BUNTU_TOKEN` |
| `mcpClientToken` | 空 | `internal_bearer` 模式的部署客户端 Token；留空时读环境变量或 `<DSH_HOME>/.env` 的 `CRM_MCP_CLIENT_TOKEN` |
| `platformUserId` | 空 | `internal_bearer` 模式的平台用户标识；留空时读环境变量 `CRM_PLATFORM_USER_ID`，再退到登录门禁写的 `<DSH_HOME>/identity.json`（`salary_id`） |
| `platformUserHeader` | `x-platform-user-id` | 平台身份头名称；插件同时发送兼容别名 `x-sfoa-platform-user`，不同部署改这里即可 |
| `defaultAuthor` | 空（读宿主账号资料） | 「创建人」兜底值：显式配置后固定使用它；留空则依次尝试宿主 `deepseekAccount` 资料显示名、进程用户名。**不会**使用远端 `auth.crmUsername` |
| `updateRegistry` | 空（自动推断） | 自更新查版本用的 registry。留空按「`DSH_PLUGIN_REGISTRY` / `npm_config_registry` → profile 与 home 的 `.npmrc` → 官方源」推断；用户机器 `.npmrc` 配好就无需改这里 |
| `autoUpdateCheck` | `true` | 打开面板时是否检查新版本。关掉后不主动查、不弹升级提示；不影响在插件页手动升级 |

**身份是自动的**：插件启动时按 `config → 环境变量 → <DSH_HOME>/.env → identity.json` 解析 `internal_bearer` 凭据（部署客户端 Token + 登录用户薪号），并把它作为 `Authorization: Bearer <Token>` + `X-Platform-User-Id: <薪号>` 发给 MCP 控制平面；这台机器没有内部凭据时才回退 Buntu Token。因此用户不需要在配置里粘贴任何 token，换人登录后一分钟内自动跟随。

**为什么需要 `skillCatalogDir`**：DSH 的 `skills` 服务是**分层**注册表，插件运行在 Host 根作用域，只能看到全局层（内置 bundled Skill）。公司 Skill（`crm-core`、`crm-record-change` 等）挂在 agent preset 层，根视图看不到。插件因此额外读取一份**只读**的目录表作为兜底：只解析 `SKILL.md` 的 `name/description` 与正文，不注册进注册表、不参与路由，失败静默降级。技能栈只能绑定**本地已有的 Skill**（列表对所有人可读）：输入名称会出现候选，回车加第一条或直接点候选；敲一个列表里没有的名字会提示「本地没有名为「x」的 Skill」，不会把一个模型加载不到的 Skill 写进栈里。真要引用目录外的 Skill，先把它装进 DSH，再回来绑定。

### 进入场景时把技能带进输入框（1.9.0）

场景只负责**预设**：提示词模板、技能、附件。进入场景时，输入框里会多出一行技能 token：

```
/crm-core /crm-record-change
客户：
```

这跟用户自己在输入框里打 `/crm-core` 是**同一件事**——宿主的 `dsh-tool-skill` 在提交时扫描用户消息，命中「空白边界 + kebab-case」的 `/技能名` 就把该 Skill 的全文作为 `instructions` 追加进本次请求（不再需要模型调一次 `skill` 工具）。所以：

- token 前面必须是行首或空白，后面必须是空白或行尾：`/crm-core客户：` 不会被认成引用；
- 名字含大写、下划线、中文、点的 Skill 永远路由不上（宿主的正则只认 `[a-z0-9-]`）；
- 与场景自身的 `/指令` 撞名时，宿主的指令表会先占整行，`/技能名` 变成指令而不是技能。

预填只是文本，用户可以删、改、再加。所以**进入场景前会先预检一次**（`skills.check`），把绑定的技能逐条判定：

| 分类 | 含义 | 客户端行为 |
| --- | --- | --- |
| `ok` | 本机有、名字合法、不撞指令、用户可调用 | 写进 `/技能名` token |
| `missing` | 本机没装 | `autoInstallSkills` 打开时按名字去技能市场装上再复检；仍缺则弹窗拦截 |
| `not-routable` | 名字不是 kebab-case | 不写 token，提示改名或换技能 |
| `command-clash` | 与某张卡的 `/指令` 同名 | 不写 token，提示改指令或改技能名 |
| `user-disabled` | Skill 声明了 `user-invocable: false` | 不写 token，只能由模型自行加载 |

预检拦在**激活之前**：技能装不上时不会先建好会话、激活场景再告诉你输入框里少了东西。弹窗给三个出口——`打开智能体中心安装`（直接跳到 DSH 的智能体中心）、`仍然进入`（明知缺技能也要进，token 只带能路由的那几个）、`取消`。

自动安装走的是 DSH 智能体中心自己的同源路由（`GET /api/runner-library/skills?page=N` 找同名项 → `POST /api/runner-library/install`），插件既不碰凭据、也不直接写技能目录；装完的文件系统监听会让下一次请求就看到新技能。没有登录态或市场里没有同名项时，这条通道会失败，此时只提示、不假装装上了。

### 进入场景 = 用户自己动手：输入框里没有第二种长相（1.11.1）

进入场景写进输入框的，**只是一个纯文本字符串**，宿主拿到的和用户手打时一模一样：

    /crm-core /crm-record-change
    客户：

宿主 `setDraft(string)` → `draftEditor.setDraft(text)` → `clear()` + `$appendParagraphs`，
把它铺成**普通文本节点**；随后 lexicon（宿主自己的 `skill` 源，加上我们补的那份名字表）
把 `/技能名` 扫成 `TextRefNode`——可编辑的普通文本加上引用样式，点它走
`inputTriggers.openReference(undefined, { ref })`。手打和进入场景，走的是同一条代码路径。

#### 1.11.0 错在哪

1.11.0 为了让 `/技能名`「能点」，把预填改成 `setDraft({ text, references })`。宿主因此改走
`draftEditor.restoreDraft(text, references, …)`，逐条 `append(new ReferenceChipNode(...))`——
确实可点了，但那是**另一种东西**：

| | 用户手打一个技能 | 1.11.0 的预填 |
| --- | --- | --- |
| 草稿节点 | `TextRefNode`：普通文本 + 引用样式，能逐字编辑、退格拆开 | `ReferenceChipNode`：整体替换、整体删除 |
| 名字来源 | lexicon 扫描草稿 | 我们塞进 references 的 `ref` |
| 外观 | 宿主按文本推断 | 我们写死 `appearance: 'file'`，图标与光标都是文件那套 |
| 提交序列化 | 不需要（本来就是文本） | 必须该源有 `codec`，否则 `slash: no serializer for reference source` |

同一个输入框于是有了两种长相：手打的是文本，进场景来的是 chip。

#### 1.11.1 的做法

- `draftPayloadFor(text)` 只返回字符串，`seedComposer` 与 `writeDraft` 两个写入口都只递字符串；
  代码里不再有 `appearance`、不再拼 references。「进入场景」因此不可能再产生手打得不到的形态。
- 自注册源 `crm-workspace-skill` 降级成宿主技能源的补充，不再当 chip 的主人：
  - `lexicon` 提供一份技能名字表：宿主目录还没结算时，`/技能名` 也能照常着色；
  - `openReference` 只在宿主源认不出这个名字时兜底——`skills.check` 取 `SKILL.md` 绝对路径，
    再用 `dsh-resource://file/...` 在右侧栏打开；
  - `candidates` 仍是空数组（空分组宿主不渲染，`/` 菜单里看不到这个源）；
  - `codec` 留着只为「1.11.0 时期写进宿主存档的草稿」：那些草稿里带着 source 指向本源的
    reference 节点，升级后重开会话仍会被还原，缺 codec 会在回车时被拒收。
- 预设附件也按手动的语义传 `ordinary`（`sessions.binding(sessionId)?.session.getSnapshot().subagent === null`）：
  普通会话才预上传图片，子代理续跑时图片随 prompt 内联——与 `apply.ts` 里拖拽/粘贴的分支一致。

进入场景预置的东西——技能 token、模板正文、附件——都走用户自己那条路，插件不再创造只有
「从场景进来」才看得到的形态。场景栏里的技能入口（1.10.0 的产物）作为第二条路保留。

---

## 5. HTTP 接口（同源、方法白名单）

`POST /crm-workspace/api`，请求体 `{ method, params }`，响应 `{ ok: true, ...result }` 或 `{ ok: false, message, errors? }`。

| method | params | 用途 |
| --- | --- | --- |
| `bootstrap` | `{ sessions?: string[] }` | 面板首屏：插件信息、配置、词表、全部场景、指定会话的激活状态 |
| `skills.list` | `{ query? }` | 技能仓库检索（供编辑器选择 `pinnedSkills`） |
| `skills.check` | `{ names: string[], cwd? }` | 进入场景前的技能预检：按 `cwd` 的分层视图判断每个技能能不能用 `/技能名` 真正路由，返回 `skillTokens`（可拼进输入框的 token 串）与 `missing` / `unroutable` / `clashing` / `disabled` 四组名字。只读，不建会话、不改激活状态 |
| `scenario.save` | `{ draft, previousId? }` | 新建 / 编辑（`previousId` 存在即编辑） |
| `scenario.delete` | `{ scenarioId }` | 删除，并清掉指向它的激活记录 |
| `scenario.enable` | `{ scenarioId, enabled }` | 启停 |
| `scenario.move` | `{ scenarioId, direction: 'up'\|'down' }` | 排序 |
| `scenario.duplicate` | `{ scenarioId }` | 复制为新卡片（新编码、新指令） |
| `activation.activate` | `{ sessionId, scenarioId, source, stack?, cwd? }` | 激活场景并返回解析后的技能栈；`stack: true` 时**叠加**到当前会话（上限 `maxScenariosPerSession` = 8），默认替换整栈。返回的 `skillTokens` 可直接拼进输入框；`cwd`（场景工作区目录）决定按哪一层解析技能 |
| `activation.state` | `{ sessionId, cwd? }` | 当前会话的激活栈：`scenarios` 是卡片数组（栈首另有兼容字段 `scenario`）；`draft` 带回 `reference`（`/场景名称`，仅供展示，1.6.0 起不再写进输入框）、`welcome`（场景介绍投影）、`text`/`inputDraft`、`skillTokens`（1.9.0）与可拉取的附件 URL |
| `activation.deactivate` | `{ sessionId, scenarioId }` | 从激活栈里**只摘掉一个**场景；摘空即等同于退出 |
| `activation.clear` | `{ sessionId }` | 退出场景（清整栈） |
| `workspace.ensure` | `{ system }` | 按业务系统找到/创建对应工作区，返回 `{ workspace: { workspaceId, path, title }, created, key }`；标题或目录命中即复用 |
| `diagnostics` | `{ sessionId?, host? }` | 插件诊断：版本、数据目录、存档版本、场景/激活计数、注入开关、当前会话激活栈、客户端上报的 slot 崩溃 |
| `preview.injection` | `{ scenarioId, mode?: 'full'\|'reminder'\|'brief' }` | 管理员预览模型到底会看到什么；返回 `mode` 与 `characters`。未开 `injectSkillBodies` 时首次为 `names`、后续为 `brief` |
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
- 目标对象与动作：不预设，先根据用户描述与可用工具确认对象，再判断是新建还是修改
- 表单入口：不预设，按当前可用的标准表单入口或快速操作入口自动选择
- 附件材料：允许…/不允许…

## 技能栈（严格按此顺序执行）
- 1. <skill>            ← 只有名称，没有介绍
- 2. <skill>

## 执行要求
- 技能栈的顺序就是执行顺序：从上到下，用 skill 工具逐个按名称加载正文 …
  （1.9.0 起：如果这些技能是随预填的 `/技能名` 一起提交的，宿主已经把正文注入本次请求，
   这一句会换成「直接按正文执行，不要用 skill 工具重复加载」）
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

**进入场景先落到业务系统的工作区**（1.7.0）：每张卡片都必须声明 `businessSystem`（CRM / TAPD / 其他，或自定义名）。
点「进入场景」时客户端先调 `workspace.ensure`，按「标题 = 业务系统名 → 标题 = key → 目录 = `<workspaceRoot>/<key>`」的顺序
找已有工作区：命中就直接用，一个都没有就建目录 + 建工作区（标题改成业务系统名），然后**在这个工作区里**拿一个空白会话
（有就复用，没有就新建）。所以 CRM 场景永远落在 CRM 工作区，TAPD 场景落在 TAPD 工作区，不会都堆在用户随手打开的那个目录里。

叠加（`stack: true`）走同一条前置：当前会话已经在目标工作区 → 直接叠；不在 → 先在目标工作区开一段会话再叠
（否则「叠加」会静默把 CRM 场景带进 TAPD 的工作区）。宿主不提供工作区服务时降级为原行为，只在面板上提示一句。

**跨业务系统不能叠加**：会话是按业务系统分域的，一个对话里同时跑 TAPD 与 CRM 场景，会让注入块出现两套
系统上下文，也说不清这段会话属于哪个工作区。所以叠加前会比对当前栈里已激活场景的业务系统，不一致就
直接拦下并提示「请先退出当前场景」，不会静默替换掉原有场景。要换系统就单独「进入场景」（会在目标系统的
工作区另开一段对话）。

**新会话的四个联动**（`conversation.input.dock` + `inputActions` / `conversation` 服务）：

1. 输入框正上方常驻状态条：1 个场景时是 `🟢 正在使用场景：【<标题>】 | 挂载技能：a + b`；叠加多个场景时标题变成「正在使用 2 个场景」，下面按栈序列出每个场景一个 chip。右侧 [切换场景]（打开工作台面板）与 [× 退出场景]（清整栈）；每个 chip 上另有一个 `×`，可以**只移除那一个**场景。只要状态条还在，该会话后续每条消息都会经过 pre-step 注入。
2. 新会话（`session.blank === true`）里再叠一张「场景开场」卡片：场景图标 + 场景介绍（`description`）。它是 UI 投影，不写会话历史、不产生消息气泡，用户发出第一条消息后自动消失；场景介绍留空则不渲染这张卡片。
3. 输入框预填：写「技能 token 行 + 管理员填的 `inputDraft`」，不带 `/场景名称` 首行（原因见下）。1.9.0 起第一行是 `/crm-core /crm-record-change` 这样的技能引用（`activation.activate` / `activation.state` 返回的 `skillTokens`），换行接模板；用户可以删改。写入有两条独立路径——面板在激活后直接 `conversation.input.for(sessionScope).setDraft()` 并回读确认（不依赖输入框组件是否挂载），`conversation.input.dock` 组件挂载后再兜一次（用 `inputActions.setDraft`）；两处都只在输入框为空时写**一次**，写完即记为已就位——用户之后把内容全选删掉也不会被回填，更不会覆盖用户已经输入的内容，失败会在面板上弹错误提示；输入框 dock 里另外常驻一行可点提示（`预填还没写进输入框` → 点此重试 / `这是已有对话，模板没有自动填入` → 填入输入框，中性色，可点 × 关掉 / `输入框里已有内容，没有覆盖` → 只说明不写入，用户清空输入框后按钮会自动回来），避免「预填」这个核心卖点静默失效。1.14.0 起卡片上也会先露出一行 `预填 <模板第一行>`，点进去之前就知道输入框里会出现什么。草稿比对会忽略开头的技能 token 行（`isKnownTemplate`），所以宿主把草稿搬到新会话时仍认得出这是我们自己的模板；只是缺 token 前缀的草稿不重写（重写会把光标弹到末尾）。
4. 预设附件进待发送托盘：面板在激活后把 `presetAttachments` 的字节从资产路由取回，交给唯一入口 `attachPresetFilesToTray`：先查账本里这一批是不是已经挂过（同 `scenarioSeedKey` 且 id 都还在托盘 → 直接成功），再摘掉托盘里属于我们的旧附件，最后 `conversation.createDrafts(sessionId, files)` → `facade.addAttachments(ids)` 并回读 `attachmentIds` 确认。`facade.addAttachments` 是 **append 语义、不去重**，所以「只由一处挂 + 挂之前先对账」是硬要求认；`conversation.input.dock` 挂载后再兜一次（托盘里已有附件就跳过，不会重复挂）。托盘里显示文件名与「场景内置附件」标签，随首条消息一起发送。退出场景或单独移除时，这些草稿 id 会走 `conversation.discardDrafts` 回收，不在会话里留孤儿文件。

**退出与移除的四种路径**（缺任何一种都会让用户「引入之后删不掉」）：状态条上的 [× 退出场景]（清整栈）、每个场景 chip 上的 `×`（只移除该场景）、工作台面板顶部的 [退出全部场景] / 当前场景条上的 `×`、以及在输入框里敲 `/crm-exit`。退出会清掉该会话的激活记录、清掉我们写进去的那份预填，并调 `dropSeededAttachments` 把托盘里属于我们的预设附件摘掉（用户自己拖进来的不动），然后把预填内容里仍属于我们的那一段撤掉（用户自己改过的正文保留）。<br>`/crm-exit` 与 `/crm-doctor` 的名字只能是 ASCII：宿主 `commands.register` 只接受 `/^[a-z][a-z0-9_-]*$/u`，中文只能出现在指令描述里。

**预设附件的账本**（1.8.0）：客户端用 `seededAttachments`（`sessionId → { seedKey, ids }`）记住「这个会话的托盘里哪几个附件是插件挂的」，
`scenarioSeedKey(cards)` 是这一批的去重键（场景 id + 版本拼起来，换场景/换版本就换键）。
挂载统一走 `attachPresetFilesToTray`、回收统一走 `dropSeededAttachments`，两者都在 `withAttachmentLock` 里逐会话串行，
面板预填与场景栏预填这两条并发路径因此不会各挂一份。宿主切会话时会把草稿连同附件搬到新会话，
所以回收时按「id 在我们账本里」判断，而不是按当前会话判断。

**注入是分级的**（`injectSkillsOnStep` 打开时）：首次注入 `names`（场景说明 + 默认上下文 + 预设附件 + 技能栈名称 + 执行要求）；**同一会话的后续轮次改发 `brief`**，只留一行「场景仍然生效 + 技能栈顺序 + 沿用首次说明」。开了 `injectSkillBodies` 时首次是 `full`（含 Skill 正文），之后是 `reminder`。所以「进入场景」并不等于把面板里预览的那份全文每轮都提交一次——只有第一轮是全文，之后是几百字符的提醒。

**面板的查找与筛选**（1.14.0）：两个页签用法一致——关键词输入框 + `全部`/业务系统 chip + `筛出 N / 共 M` 计数 + `清除筛选`。关键词口径共用 `scenarioSearchText`：标题、场景介绍、**输入框预填**、业务系统、业务分类、`/指令`、技能栈名，所以搜「拜访」也能命中「预填里写着拜访记录」的场景。筛选条件按页签各自保存（在「我的场景」筛了 CRM 不会把标准场景也筛空）；标准场景的业务系统 chip 只列库里真实出现过的系统，不掺本机 taxonomy 的建议值——显示一个点进去一条都没有的标签比没有更糟。筛不出结果时给出可操作空状态（列出当前关键词/业务系统 + 提示清除筛选看全部 N 张）。卡片上另有一行 `预填 <模板第一行>`（只取第一行、压成单行、悬停看全文），因为业务人员判断「这张卡是不是我要的」靠的就是这一句。

**面板页脚与诊断**：面板底部显示 `场景工作台 · 客户端 v<CLIENT_VERSION> · 宿主 v<PLUGIN_VERSION>`，两边版本对不上（改了客户端没刷新页面）一眼能看出。旁边的 [诊断] 按钮拉 `diagnostics`：版本、数据目录、存档版本、场景/激活计数、注入开关、当前会话激活栈，以及客户端捕获到的 slot 崩溃记录。命令行也可以敲 `/crm-doctor` 拿到同样的摘要。

> 状态条依赖宿主注入的 `useInput` hook，它其实是「带 selector 的 `useSelector`」（宿主源码里写作 `useInput((s) => s)`）。传空参会在内部抛 `TypeError: selector is not a function`，宿主随即把整个 `conversation.input.dock` 槽条目判为崩溃并吞掉——徽标、退出按钮、开场卡片会一起消失。1.5.4 修的就是这个。

> 徽标只注册一个 slot（`conversation.input.dock`，order 20），不替换 `conversation.input.attachments` 这类官方单占位槽，因此不会遮蔽原生附件 UI。

**宿主空态标题改不了**：新会话里那行「小犇，我帮你…」是 DSH 自己的空会话标题（`HeroShell` 的 `hero.headline`），只对插件开放了品牌标记（`conversation.hero.brand.mark`）与工作区选择两个插槽，没有替换标题的插槽。因此插件只能在同一个位置补一张「场景开场」卡片，**要改那行文案本身必须改 DSH 的本地化/品牌配置或源码**。

**预填为什么只写模板、不再带 `/场景名称`**：1.6.0 之前预填第一行是 `/场景名称` 引用标记。它有两个问题：一是那行字**不是用户说的话**，回车后会被模型当成用户自己输入的指令；二是标题含中文或空格时宿主根本收不成 chip，只是普通文本，白白占一行。现在场景身份由注入块（`scenario=<id>`）与输入框上方的状态条表达，输入框里只留管理员写的填写模板。`activationState.draft.reference` 仍返回，但只用于展示。

**为什么 `/技能名` 可以写、`/场景名称` 不能写**：技能 token 是宿主自己认的手势（`dsh-tool-skill` 扫用户消息，命中就注入技能正文），写进去等同于用户亲手引用；场景标题不是任何手势，写进去只是一行死文本。两者的区别不在我们的预填代码，而在宿主有没有这个命名空间。

> 1.6.0 起每个 slot 条目（面板、会话标题标签、输入框上方状态条）各自包了一层 `SlotBoundary`：某个条目渲染失败只把它自己降级成一条黄色提示（带 [重试]），不会像 1.5.4 之前那样整个 dock 槽条目被宿主吞掉。失败原因会记进诊断弹层。

**`/指令` 回车为什么现在有反馈了**：宿主把卡片的 `slashCommand` 注册成真正的 Host 指令后，裸回车（无参数）只会在服务端跑 handler——客户端把 token 吃掉、界面上没有任何输出，看起来像「输入框被清空、场景没进来」。客户端因此用 `commandUi.decorate()` 给同名指令挂了一个**动作**：回车/菜单选中即调用 `activation.activate`，弹一条「已切换到「XX」场景：技能栈…」的提示，并广播 `crm-workspace:activation` 让徽标与开场卡片立刻刷新。宿主 handler 保留给非 UI 入口。

**激活落在哪个会话上**：`currentSessionId` 按 `uiSession.adapter.current`（`retainedBy.mainView > 0` 的那个会话）解析；工作台把对话面板顶掉、当前绑定变空时回退到 `lastSessionId`（最近真正显示过的会话）。进入场景时，如果这个会话本来就是空白会话就直接复用，否则新建一个空白会话再激活——所以「进入场景」永远是一段新对话。导航统一用 `uiWorkspace.openSession()`。`sessions.list` 快照里没有 `current` 字段，`ctx.sessions` 上也没有 `open` —— 这是 1.5.1/1.5.2 修掉的坑。

**卡片视觉统一**（1.8.0）：卡片网格 `align-items: stretch` + `min-height: 196px`，同一行等高；
标题固定两行、介绍固定两行（超出裁剪，`title` 属性里是全文，鼠标悬停可看）；
技能行压成一行不换行，预设附件在卡片底部只显示 `📌 n` 徽标（悬停看文件名）。
尺寸统一之后「一眼看出这个场景是做什么的」靠的是标题 + 两行介绍，而不是卡片被内容撑成不同高度。

**面板按业务系统过滤**：工具条上的 chip 是业务系统（CRM / TAPD / 其他 + 卡片里出现的自定义系统），不再是业务分类。
三个预设值即使还没有对应卡片也会列出来，否则用户要在做出第一张 CRM 场景之前根本点不到「CRM」这个筛选项。
业务分类降级成选填的备注，只参与搜索、不参与过滤。

**新建场景的默认值**：业务系统预填 `CRM`（必填项给个起点，要建 TAPD 场景再改），
**「允许附件」默认勾选**（存档里缺省仍是 `false`，兼容 1.6.x 老卡片）。技能栈不再有「追加」按钮：
输入名称出候选、回车加第一条、或直接点候选；敲一个本地没装的名字会报「本地没有名为「x」的 Skill」，
不会把一个模型加载不到的 Skill 写进栈里。

**业务系统与图标随标准场景同步**（1.8.0）：`toRemoteWritePayload` 会把 `businessSystem` 与 `icon` 放进
`scenarioPayload`（服务端对顶层是 `zod .strict()`，多一个键就 400；`scenarioPayload` 是 `passthrough()`，
插件自有字段原样往返）。推出前本地必填的业务系统因此不会在别的机器上退回 CRM，图标也不会被重置。
服务端把业务系统提升为可查询字段的改造清单（含给 MCP 侧智能体的 Prompt）见 [`docs/mcp-business-system.md`](docs/mcp-business-system.md)。

**场景名在对话里可见**：插件在会话标题栏注册一个「场景 · <标题>」标签（`conversation.session.header.actions`，order 30），每 8 秒轮询当前会话的激活状态（页面隐藏时暂停），点击标签直接打开工作台面板。标签是 UI 投影，不写会话历史、不产生消息气泡、不消耗模型调用。

- 技能栈解析失败（Skill 服务不可用）：不阻断对话，缺失项在带正文模式下明确标注「未预载」，模型会如实告知用户缺哪个 Skill。

---

## 7. 运维与故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板提示「只读模式」 | 存档损坏或版本高于插件 | 日志/面板里有具体文件路径；损坏文件已被重命名为 `state.corrupt-<时间戳>.json`，确认后删除 `state.json` 重启即可 |
| 点卡片后模型没看到场景 | `injectSkillsOnStep: false`，或激活发生在上一条消息发送之后 | 打开配置开关；重新发送一条消息即可（激活状态持久化在存档里） |
| `/record` 指令不存在 | 卡片 `enabled: false`，或指令名与内置指令冲突 | 启用卡片；换一个 `slashCommand` |
| `/指令` 回车后输入框清空、场景没反应 | 1.5.3 之前裸回车只跑服务端 handler，客户端没有任何输出 | 升级到 1.5.3+：客户端动作会激活并弹提示；仍无反应说明卡片停用或指令名与内置指令冲突 |
| 技能栈里出现「未预载正文」 | 该 Skill 不在 Host 根视图，也不在 `skillCatalogDir` 目录里，且 `injectSkillBodies: true` | 正常降级：注入块会要求模型用 `skill` 工具按名加载；想让它预载正文，把 `skillCatalogDir` 指到公司 Skill 根目录。默认（不注入正文）不会出现该标注 |
| 会话标题旁没有「场景 · …」标签 | 该会话没有激活场景，或页面还是旧的客户端模块 | 在面板里点一张卡片；客户端改动需刷新页面（Ctrl+R） |
| 输入框上方没有场景徽标 | 该会话未激活场景，或客户端模块未刷新 | 从面板「进入场景」；刷新页面 |
| 新会话里看不到「场景开场」卡片 | 会话已经有消息（只在空白会话显示），或卡片没填场景介绍（1.13.0 起选填） | 新建一个会话再进入场景；在卡片里补场景介绍 |
| 新会话顶部仍是「小犇，我帮你」 | 那是 DSH 自己的空会话标题（`hero.headline`），没有对插件开放替换插槽 | 插件只能在同位置补一张「场景开场」卡片；要改那行字必须改 DSH 侧的品牌/本地化配置或源码 |
| 输入框没有被预填草稿 | 用户已经键入过内容（不会被覆盖）、`inputDraft` 为空，或（1.5.1 之前）激活被写到了一个用户看不见的后台会话上 | 升级到 1.5.2+；清空输入框后重新进入场景；面板会弹「预填没写进去」的提示说明是会话没就绪 |
| 进入场景后多出一个空会话 | 1.5.1 之前 `currentSessionId` 读不到当前会话，`ensureSession` 每次都新建 | 升级到 1.5.2+：空白会话直接复用，只有当前会话已有消息时才新建 |
| 输入框里出现 `/场景名` 那行字 | 1.6.0 之前预填会带 `/场景名称` 引用首行 | 升级到 1.6.0+：预填只写 `inputDraft`；旧会话里残留的那行可用 [× 退出场景] 清掉 |
| 进了新场景，输入框里还是上一个场景的模板 | 宿主切换会话时会把上一段会话的草稿「搬」过来（`rebindDraftFiles`）；1.6.0 之前插件把它当成用户输入保留 | 升级到 1.6.0+：`seedConflict` 把「我们写过的模板」与「所有场景的填写模板」都认作已知模板，空白会话里的这类文本会被换成这次场景的模板；用户自己打的字仍然不动。旧会话里残留的可手动清空 |
| 想在一个对话里用两个场景 | 1.6.0 之前一个会话只能有一个激活 | 用卡片上的 [＋ 叠加]（或在面板当前场景条里逐个 `×` 移除）；上限 8 个 |
| 叠加时提示「跨业务系统不能叠加」 | 当前对话里已经有别的业务系统的场景；会话是按业务系统落在各自工作区的 | 先退出当前场景，再单独进入新场景（会落到它自己的业务系统工作区）；确实要在同一对话里跑多个场景时，只叠同一个业务系统的卡片 |
| 对话页状态条变成一条黄色提示 | 该 slot 条目渲染时抛错，`SlotBoundary` 把它降级了（1.6.0 之前会整块消失） | 点 [重试]；打开面板页脚 [诊断] 或敲 `/crm-doctor` 看具体错误，把摘要反馈给插件维护者 |
| 保存失败的红字一直挂着 | 1.7.0 之前字段报错只在下一次保存时才清 | 升级到 1.7.0+：增删预设附件、改技能栈会立刻清掉对应字段的报错 |
| 面板页脚两端版本不一致 | 客户端模块是刷新前加载的旧 bundle | Ctrl+R 刷新页面；仍不一致说明 profile 里 link 的仓库没更新 |
| 模型每轮都在重复场景说明 | 注入分级没生效：`injectSkillsOnStep` 每轮都在发 `names` 而不是 `brief` | 正常应为首次 `names`、之后 `brief`；`/crm-doctor` 能看到 `config.injectSkillBodies`，确认不是开了正文注入 |
| 退出场景后预设附件还留在托盘里 | 1.8.0 之前场景栏自己建的草稿附件从不登记，退出时无从摘除 | 升级到 1.8.0+：四条退出路径都会调 `dropSeededAttachments` 回收；还留着说明附件不是我们挂的（用户自己拖进来的不会被删） |
| 预设附件在托盘里出现两份 | 1.8.0 之前面板与场景栏各挂一次，而 `addAttachments` 不去重 | 升级到 1.8.0+：统一入口 + 账本 + 逐会话锁，同 `scenarioSeedKey` 只挂一次 |
| 标准场景推上去再拉下来，业务系统变成 CRM | 服务端清洗了 `scenarioPayload`，或客户端还是 1.7.x（那时只存本地） | 升级到 1.8.0+；服务端需保留 `scenarioPayload` 的 `passthrough`（契约见 `docs/mcp-business-system.md`） |
| 预设附件没进托盘 | 附件下载失败（远端 404/超时）、卡片里没有 `presetAttachments`，或 1.5.2 及之前只靠输入框组件挂载 | 升级到 1.5.3+（面板侧直接挂托盘，并回读确认）；面板会弹「预设附件没能挂到输入框」的提示；仍失败看 Host 日志与资产文件是否还在 |
| 输入框里没有 `/技能名` | 卡片没绑技能、`skillRoutePrefill: false`，或那些技能被判成 `missing` / `not-routable` / `command-clash` / `user-disabled` 中的一个 | 点卡片进入时会弹窗逐条说明；缺的就装（弹窗里的「打开智能体中心安装」），名字不是 kebab-case 的改 Skill 目录名或换一个，撞指令的改卡片的 `slashCommand` |
| 技能明明装了，进入场景还是被拦 | 技能装在用户级 `$DSH_HOME/skills`，但场景的工作区里有同名项目级 Skill 覆盖；或技能市场里没有同名项 | 预检按**场景工作区目录**的分层视图判断（项目级 `.dsh/skills` 优先），所以看到的是会话里真实生效的那一层；点「仍然进入」也能进，只是这次不会带那个 token |
| 点「打开智能体中心安装」跳不过去 | 该部署没有智能体中心面板（`ui-library` 被禁用，或路由返回 401/503） | 手动把技能装进 `$DSH_HOME/skills/<name>/SKILL.md` 后重新进入场景 |
| 从场景进来，输入框里的 `/技能名` 长得跟手打的不一样 | 1.11.0 用 `setDraft({text, references})` 把 token 造成 `ReferenceChipNode`，而手打出来的是 lexicon 装饰的普通文本（`TextRefNode`）——同一个框两种长相 | 升级到 1.11.1+：预填只递纯字符串，走和手打完全相同的 `setDraft(text)` 路径 |
| 从场景进来，点输入框里的 `/技能名` 只是弹出指令菜单 | 草稿里那个 token 没被 lexicon 认成引用（技能目录还没结算，名字不在名字表里） | 插件会把自己的 `skills.list` 名字表并入 lexicon（`crm-workspace-skill` 源）；若仍不生效，确认该技能在 `skills.list` 里且名字是 kebab-case。1.11.1+ 的预填不再依赖写入时序，光标落进 token 后按一次空格/回车也会重新扫描 |
| 点输入框里的技能 chip 没打开右侧栏 | 该技能在宿主侧找不到 `SKILL.md` 路径（内置技能包没有文件路径），或宿主没装 `sidebarRight` 服务 | 插件侧的 `skills.check` 只认有文件路径的技能；此时正文仍会随 `/技能名` 注入本次请求，只是没有本地预览，场景栏里也有同一入口 |
| 点场景栏里的技能名没打开右侧栏 | 该技能没有文件路径（来自内置技能包），或宿主没装 `sidebarRight` 服务 | 会弹出「没有可打开的文件路径」提示；此时正文仍会随 `/技能名` 注入本次请求，只是没有本地预览 |
| 「标准场景」为空 | 未配置/无法访问 `apiBaseUrl`，请求未认证，或远端返回 0 条 | 检查 `apiBaseUrl`；点「同步」看 Host 日志里的 HTTP 状态与 `correlationId` |
| 页签显示「未认证」 | 既没有 `internal_bearer` 凭据也没有可用 Buntu Token | 优先补部署客户端 Token：环境变量或 `<DSH_HOME>/.env` 写 `CRM_MCP_CLIENT_TOKEN=…`（控制面的 `MCP_CLIENT_TOKEN`），用户身份会从 `<DSH_HOME>/identity.json` 的 `salary_id` 自动补齐；仍不行再看 `buntuToken`。控制面要求两个头：`Authorization: Bearer <客户端 Token>` + `X-Platform-User-Id: <薪号>` |
| 标准场景没有编辑/删除按钮 | 服务端 `auth.canManageStandardScenario !== true` | 这是权限红线：普通用户只能「进入场景 / 复制为本地场景 / 下载到本地」 |
| 抽屉里没有「设为插件标准场景」 | 当前账号没有标准场景管理权限（`auth.canManageStandardScenario !== true`），或权限请求失败 | 这是刻意的：无权限时整块不渲染，避免用户勾了之后白保存；让管理员补权限 |
| 「创建人」显示的是本机/DSH 用户名 | 这是设计如此：创建人只取 DSH 身份 | 远端 Salesforce 账号只在编辑抽屉的提示里作为「远端记录创建人」出现，不参与创建人字段 |
| 已安装标准场景版本没变化 | 远端 `version/revision` 未变，或同步请求失败 | 切到「标准场景」点「同步」；看 Host 日志 |
| 附件上传返回 `DSH_SCENARIO_INPUT_INVALID` | 请求体混入了 `version/revision/createdAt/updatedAt/presetAttachments` | 本插件所有写请求统一经 `toRemoteWritePayload` 剔除；若仍出现，检查是否有其他调用方绕过它 |
| 上传附件报「不支持的附件类型」 | 扩展名不在 `.docx/.xlsx/.csv/.pdf/.md/.txt` 内 | 转成受支持的格式，或改用远端 URL |
| 面板打不开 | 插件未装配（不在 `dsh.profile.bundles`） | 检查 profile 的 `package.json` 与重启日志 |

存档位置与备份：`<profile>/crm-workspace/state.json`（每次写入前会把上一份复制到 `state.backup.json`）。

---

## 8. 开发与验收

```powershell
node --test          # 222 个用例：schema / 激活栈 / 存档 / 上下文块 / 客户端纯函数 / Skill 目录 / 登录身份 / 业务门面 / MCP 契约 / HTTP / 资产路由 / 整装集成
node scripts/check.mjs   # 交付前自检：清单字段、被引用文件、客户端加载方式、主题变量、locale、bundle patch
```

测试覆盖的关键行为：

- 缺 `description` 必须报错；`pinnedSkills` 去重且保持顺序；看不见的 Skill 只警告、不谎称不存在；
- 场景配置：预设附件类型/MIME/大小/数量与越界路径校验、`inputDraft` 与发布元数据、非法版本收敛、`sourceType` 兜底；
- Skill 目录：frontmatter 解析、目录扫描去重排序、目录缺失静默降级；
- 激活栈（`lib/core/activation.js`）：旧存档（只有 `scenarioId`）升级成单元素栈、坏记录丢弃、`stack: false` 替换 / `stack: true` 追加且保留注入进度、逐个移除到空即消失、`pruneActivations` 的过期/闲置/悬空/超限四类计数；
- 存档原子写、`changed:false` 不落盘、损坏隔离、版本降级保护、激活记录 7 天 + 24 小时闲置 + 悬空 + 上限 50 条裁剪；
- 注入块：顺序、缺失标注、预算截断、`names → brief` 与 `full → reminder` 两条分级链、叠加 N 个场景时拼 N 个块并在块内注明、预填模板「已经随用户消息一起提交 / 没有一起发出来」两种文案、预设附件的附件边界声明、对象/动作/入口不再预设；
- 输入框契约：`activationState.draft` 的 `reference`（`/场景名称`，仅供参考）、`welcome`（场景介绍投影）、`inputDraft` 必填预填、附件带可拉取 URL 且不泄露落盘路径；`seededDraftTextFor` 只吃 `inputDraft`、`shouldClearSeededDraft` 的四个边界（`test/client.test.js` 用 `node:vm` 直接加载 `lib/client.js` 的 `__pure` 出口）；
- 创建人：只用 DSH 身份（宿主账号资料 / `defaultAuthor` / 进程用户），MCP 的 `crmUsername` 不参与、前端伪造无效、编辑保留原创建人；
- 公司标准场景：默认地址、Buntu/internal_bearer 身份头、8 个 `/api/dsh` 接口、写请求剔除 `version/revision/createdAt/updatedAt/presetAttachments`、`revision/version` 自动升级、`sha256` 附件增量同步、`deletedScenarioIds` 自动卸载、普通用户只读与「复制为本地场景」；
- 新会话带入：只有 `inputDraft` 的预填（不再有 `/场景名称` 首行）、空白会话的「场景开场」卡片、`SCENARIO_PRESET` 附件自动挂载、无权限时抽屉不渲染发布入口、「进入场景」必须落在主面板当前会话（不用 `sessions.list.current` / `ctx.sessions.open`）；
- 多场景：同一会话叠加两个场景后注入两个块、`activation.deactivate` 摘一个后仍剩一个、摘空后 `store.activation()` 为 `undefined`、超过 8 个被拒绝、`diagnostics` 报出 `lifecycle.ttlHours / idleHours` 与当前会话的激活栈；
- 业务系统：`businessSystem` 必填（缺就报错、超长与保留字符被拒）、`category` 选填、自定义系统名派生稳定 key（`CRM → crm`、`其他 → other`、中文名走 slug/哈希）、1.6.x 老存档 coerce 成 `CRM`、公司标准场景缺字段时按 `CRM` 兜底；
- 工作区：标题命中 / 标题等于 key / 目录命中三条复用路径、都没有时建目录 + 建工作区、registry 不返回 id 时按目录回查、只有 controller 时 `create + rename`、没有工作区服务时返回可读失败原因（`test/workspaces.test.js`）；
- 客户端契约：技能栈只接受本地已有 Skill（无「追加」按钮、找不到就报错、Skill 列表人人可读）、新建默认业务系统 + 允许附件、列表按业务系统过滤、进入/叠加前先 `workspace.ensure`、`CLIENT_VERSION` 与 `package.json` 一致；
- 叠加边界：跨业务系统的场景会被拦下（不建会话、不动原栈），同系统叠两个场景仍然正常叠成两项；
- 附件生命周期：面板/场景栏两条并发路径只挂一份（`withAttachmentLock` + 账本）、`activationState.draft.attachments` 取整个场景栈的并集、四条退出路径回收托盘附件（`dropSeededAttachments`）、`/指令` 进入同样预填并挂附件；
- 场景卡片视觉：标题两行、介绍两行 + `title` 全文、技能行不换行、公司标准卡的附件只留 `📌 n` 徽标；
- 技能路由（1.9.0）：`skills.check` 把技能判成 `ok` / `missing` / `not-routable` / `command-clash` / `user-disabled` 五类、只有 `ok` 进 `skillTokens`、空名单不读技能仓库、重复名字去重、`cwd` 参与分层解析、`bootstrap` 下发 `skillRoutePrefill` / `autoInstallSkills`；
- 预填拼装（1.9.0）：token 行在模板之前、任一侧为空都不留空行、`stripSkillTokens` 只吃「整行都是 `/kebab-case`」的行（正文里的 `/usr/bin`、`5/8` 不动）、`isKnownTemplate` 认得被宿主搬过来的旧草稿、只缺 token 前缀的草稿不重写；
- 标准场景同步：`toRemoteWritePayload` 的顶层只保留服务端契约字段（`icon` / `businessSystem` 放进 `scenarioPayload`），并断言「推上去再拉回来」业务系统不丢；
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
    activation.js 激活栈与生命周期（叠加/移除/注入进度/过期闲置回收），纯函数
    workspaces.js 业务系统 → 工作区的解析与创建（标题/目录命中复用，缺失时建目录 + 建工作区）
    assets.js     预设附件资产目录（类型校验、防目录穿越）
    registry.js   公司标准场景注册中心客户端（列表/发布/下载）
    block.js      注入块组装（names / brief / full / reminder 四档，含附件边界声明）
    api.js        业务门面（含 diagnostics）
locale/           zh.json / en.json
test/             node:test 用例（client.test.js 用 node:vm 加载 lib/client.js 的 __pure 出口）
scripts/check.mjs 交付自检
```
