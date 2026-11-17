/**
 * 客户端纯逻辑单测。
 *
 * lib/client.js 是「classic script + window.__ModuleLoader__」形态，不能在 Node 里
 * 直接 import。这里用 node:vm 提供最小的 window/React 桩，取出文件末尾导出的
 * `__pure`，只验证不依赖浏览器与宿主的那部分逻辑（预填文本、退出时是否清空）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE_URL = new URL('../lib/client.js', import.meta.url);

/** 最小 React 桩：只够文件顶层定义组件（不渲染）。 */
function reactStub() {
  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
    }
  }
  return {
    Component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
  };
}

async function loadPure() {
  const source = await readFile(SOURCE_URL, 'utf8');
  let exported;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          exported = definition.factory((name) => {
            if (name === 'react') return reactStub();
            throw new Error(`unexpected require: ${name}`);
          });
        },
      },
    },
    document: { addEventListener: () => undefined, removeEventListener: () => undefined },
    console,
    fetch: () => Promise.reject(new Error('no network in unit test')),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(source, vm.createContext(sandbox), { filename: 'lib/client.js' });
  assert.ok(exported !== undefined, 'client.js 没有通过 window.__ModuleLoader__.load 导出');
  assert.ok(exported.__pure !== undefined, 'client.js 没有导出 __pure');
  return exported.__pure;
}

test('场景栈去重键：同一套场景稳定，换场景或改版本就换键', async () => {
  const pure = await loadPure();
  const one = [{ scenarioId: 'crm_a', version: '1.0.0' }];
  const two = [
    { scenarioId: 'crm_a', version: '1.0.0' },
    { scenarioId: 'crm_b', version: '2.0.0' },
  ];
  // 同一个栈必须给出同一个键：面板与场景栏靠它认出「这批附件已经挂过」。
  assert.equal(pure.scenarioSeedKey(one), pure.scenarioSeedKey([...one]));
  assert.equal(pure.scenarioSeedKey(one), 'crm_a@1.0.0');
  assert.equal(pure.scenarioSeedKey(two), 'crm_a@1.0.0+crm_b@2.0.0');
  // 顺序不同 = 技能栈顺序不同，必须换键。
  assert.notEqual(pure.scenarioSeedKey(two), pure.scenarioSeedKey([...two].reverse()));
  // 版本升级后场景内容可能变了，也应该重新挂一次附件。
  assert.notEqual(pure.scenarioSeedKey(one), pure.scenarioSeedKey([{ scenarioId: 'crm_a', version: '1.0.1' }]));
  assert.equal(pure.scenarioSeedKey([]), '');
  assert.equal(pure.scenarioSeedKey(undefined), '');
});

test('预填文本只取填写模板，绝不带 /场景标题 假指令', async () => {
  const pure = await loadPure();
  assert.equal(pure.prefillTextFor({ title: 'CRM单据新建与修改（副本）', inputDraft: '  订单号：\n客户：  ' }), '订单号：\n客户：');
  assert.equal(pure.prefillTextFor({ title: 'CRM', inputDraft: '' }), '');
  assert.equal(pure.prefillTextFor({ title: 'CRM' }), '');
  assert.equal(pure.prefillTextFor(undefined), '');
  // 关键回归：旧实现会返回 `/CRM单据新建与修改` 这样的首行。
  assert.ok(!pure.prefillTextFor({ title: 'CRM', inputDraft: '正文' }).includes('/CRM'));
});

test('只有 inputDraft 才进输入框，欢迎语不进', async () => {
  const pure = await loadPure();
  assert.equal(pure.seededDraftTextFor({ source: 'inputDraft', text: ' 订单号： ' }), '订单号：');
  assert.equal(pure.seededDraftTextFor({ source: 'welcomeMessage', text: '请描述你要新建的单据。' }), '');
  assert.equal(pure.seededDraftTextFor(null), '');
  assert.equal(pure.seededDraftTextFor(undefined), '');
});

test('退出场景只在内容仍等于预填文本时清空输入框', async () => {
  const pure = await loadPure();
  assert.equal(pure.shouldClearSeededDraft('订单号：\n客户：', '订单号：\n客户：'), true);
  assert.equal(pure.shouldClearSeededDraft('  订单号：  ', '订单号：'), true);
  // 用户改过、删过、或本来就没有预填：一律不动用户的输入。
  assert.equal(pure.shouldClearSeededDraft('订单号：\n客户：A', '订单号：\n客户：'), false);
  assert.equal(pure.shouldClearSeededDraft('', '订单号：'), false);
  assert.equal(pure.shouldClearSeededDraft('订单号：', ''), false);
});

test('上一个场景的模板被宿主搬进新会话时，换成这次场景的模板', async () => {
  const pure = await loadPure();
  const templates = new Set(['请描述你要新建的单据。']);

  // 空输入框：正常写入。
  assert.equal(pure.seedConflict('', '订单号：', templates), 'write');
  // 内容就是这一份：不动。
  assert.equal(pure.seedConflict(' 订单号： ', '订单号：', templates), 'keep');
  // 内容是用户自己打的：绝不动（宿主把草稿搬过来这件事不能成为覆盖用户输入的理由）。
  assert.equal(pure.seedConflict('帮我建一张订单', '订单号：', templates), 'keep');
  // 内容是我们之前写进别的会话、被宿主搬过来的模板：替换掉。
  assert.equal(pure.seedConflict('请描述你要新建的单据。', '订单号：', templates), 'replace');
  // 没有模板可写：什么也不做。
  assert.equal(pure.seedConflict('', '', templates), 'skip');
  assert.equal(pure.seedConflict('随便什么', '', templates), 'skip');
  // 没有登记表时退化成保守行为。
  assert.equal(pure.seedConflict('请描述你要新建的单据。', '订单号：', undefined), 'keep');
});

test('空白会话里留着别的场景模板时，换成这次场景的模板', async () => {
  const pure = await loadPure();
  // 宿主会把草稿跟着会话搬，浏览器重开后旧模板也会留在空白会话里。
  pure.rememberScenarioTemplates([{ inputDraft: 'CRM问答助手' }, { inputDraft: '请你基于附件创建和编辑单据' }, {}]);
  // 注意：knownTemplates() 返回的是 vm 沙箱里的数组，先在本 realm 里展开再比较。
  assert.deepEqual([...pure.knownTemplates()].sort(), ['CRM问答助手', '请你基于附件创建和编辑单据'].sort());
  const templates = new Set(pure.knownTemplates());
  assert.equal(pure.seedConflict('CRM问答助手', '请你基于附件创建和编辑单据', templates), 'replace');
  // 用户自己打的字仍然不动。
  assert.equal(pure.seedConflict('帮我建一张线索', '请你基于附件创建和编辑单据', templates), 'keep');
});

/* ── 1.7.0：业务系统 / 技能绑定 / 默认附件 ─────────────────────────── */

/** 读源码做契约断言：这些规则写在组件里，没法单独 import 出来测。 */
async function source() {
  return readFile(SOURCE_URL, 'utf8');
}

test('技能栈只接受本地已有的 Skill：没有追加按钮，输入不存在的名字会报错', async () => {
  const text = await source();
  // 追加按钮已移除：回车或点候选才是唯一的添加方式。
  assert.ok(!text.includes('追加</'), '技能栈不该再有「追加」按钮');
  // 必须按本地池精确匹配，找不到就报错而不是硬塞一个不存在的名字。
  assert.match(text, /const findSkill = \(name\) =>/);
  assert.match(text, /本地没有名为/);
  assert.match(text, /if \(suggestions\.length > 0\) addSkill\(suggestions\[0\]\.name\)/);
  // 搜索候选要能出结果：Skill 列表对所有人加载，不再只给管理员。
  assert.ok(!text.includes('if (admin !== true || skillPool.length > 0) return;'));
  assert.match(text, /if \(skillPool\.length > 0\) return;/);
});

test('新建场景默认带业务系统，并默认允许附件', async () => {
  const text = await source();
  const draftAt = text.indexOf('function emptyDraft');
  assert.ok(draftAt > 0, '找不到 emptyDraft');
  const slice = text.slice(draftAt, draftAt + 1200);
  assert.match(slice, /businessSystem: 'CRM'/, '新建场景要预填一个业务系统（必填项）');
  assert.match(slice, /allowAttachments: true/, '新建场景默认勾选允许附件');
  assert.match(text, /const DEFAULT_BUSINESS_SYSTEMS = \[/);
});

test('场景列表按业务系统过滤，分类不再当筛选维度', async () => {
  const text = await source();
  assert.match(text, /if \(system !== '' && card\.businessSystem !== system\) return false;/);
  assert.match(text, /const systems = useMemo/);
  assert.ok(!text.includes('const categories = useMemo'), '分类筛选已换成业务系统');
  // 卡片元信息里业务系统排在分类前面。
  assert.match(text, /const meta = \[\s*card\.businessSystem,\s*card\.category,/);
});

test('进入场景前先确保业务系统工作区，叠加也落在同一工作区', async () => {
  const text = await source();
  assert.match(text, /callHost\('workspace\.ensure', \{ system: wanted \}\)/);
  assert.match(text, /const target = await ensureSystemWorkspaceEntry\(ctx, card\.businessSystem\);/);
  // 不在目标工作区时，非叠加与叠加都要先在目标工作区拿到会话。
  assert.match(text, /const alreadyThere =/);
  assert.match(text, /sessionBelongsTo\(ctx, current, target\.workspaceId, target\.path\)/);
  assert.match(text, /stack === true && alreadyThere && current !== undefined/);
});

test('字段改好之后，旧的保存报错会立刻消失', async () => {
  const text = await source();
  // 宿主把「字段: 说明」映射回表单后，这些红字只在下一次保存时才清 —— 删掉附件、改好字段都不会消失。
  assert.ok(text.includes('const clearFieldError = (key) =>'), '缺少 clearFieldError');
  assert.ok(text.includes("clearFieldError('presetAttachments')"), '删附件/传附件后要清掉附件报错');
  assert.ok(text.includes("clearFieldError('pinnedSkills')"), '技能栈变了要清掉技能报错');
});
test('跨业务系统的场景不能叠加进同一段会话', async () => {
  const text = await source();
  // 叠加前把当前栈里的业务系统与目标卡比一遍，不一致就拦住并说明怎么继续。
  assert.match(text, /if \(stack === true\) \{/);
  assert.match(text, /const conflicts = liveStack/);
  assert.match(text, /跨业务系统不能叠加/);
  // 拦住之后不能再往下走去建会话/激活：冲突判断必须排在 setBusyId 之前。
  assert.ok(text.indexOf('跨业务系统不能叠加') < text.indexOf('setBusyId(card.scenarioId)'), '冲突拦截要在激活之前');
  // 同一张卡已经在栈里时再点叠加，也不能换会话（否则旧会话的预填/附件会被收走）。
  assert.match(text, /liveStack\.some\(\(item\) => item\.scenarioId === card\.scenarioId\)/);
  assert.ok(text.includes('已经在当前对话里了'), '重复叠加要给出提示');
  // 守卫必须看宿主上的真实栈：面板里的 activation 可能是上一轮轮询的旧值。
  assert.ok(text.includes("callHost('activation.state', { sessionId: stackSession })"), '要读真实栈再判断');
});

test('/指令 进入场景时也会带上预填与预设附件', async () => {
  const text = await source();
  const at = text.indexOf('async function runScenarioCommand');
  assert.ok(at > 0, '找不到 runScenarioCommand');
  const body = text.slice(at, at + 2600);
  // 空白会话才塞内容；已有消息的会话只是换场景。
  assert.ok(body.includes('isBlankSession(ctx, sessionId) === true'), '只在空白会话里预填');
  assert.ok(body.includes('seedComposer(ctx, sessionId'), '/指令 进入后要调用 seedComposer');
  assert.ok(body.includes('scenarioSeedKey([card])'), '要与面板用同一个去重键');
});

test('客户端版本号与 package.json 一致，显示名是「场景工作台」', async () => {
  const text = await source();
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const match = text.match(/const CLIENT_VERSION = '([^']+)';/);
  assert.ok(match !== null, '找不到 CLIENT_VERSION');
  assert.equal(match[1], manifest.version);
  assert.match(text, /label: \(\) => t\('场景工作台'\)/);
  assert.ok(!text.includes('CRM 智能工作台'), '旧名字应该已经全部换掉');
});
