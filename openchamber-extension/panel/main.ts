/**
 * 增强提示卡面板：概览 / 设置 / 诊断。
 *
 * 面板只读写三个位置：
 * - ~/.config/opencode/enhanced-prompt-card.json（配置）
 * - ~/.config/opencode/enhanced-prompt-card-events.jsonl（插件写的诊断事件）
 * - ~/.config/opencode/agents/*.md（读取可用 agent 名）
 *
 * 没有后台服务；保存由宿主原子写入，插件下一轮按 mtime 读取。
 */
import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountSwitch,
  mountTabs,
  mountTextField,
  type BannerHandle,
  type ButtonHandle,
  type TabsHandle,
} from '@openchamber/sdk/ui';

const CONFIG_PATH = '~/.config/opencode/enhanced-prompt-card.json';
const EVENTS_PATH = '~/.config/opencode/enhanced-prompt-card-events.jsonl';
const AGENTS_DIR = '~/.config/opencode/agents';
const POLL_MS = 5000;

const DEFAULT_AGENTS = ['plan', 'build'];
const DEFAULT_FIRST =
  '[系统提醒(非用户问题)] 先判意图：ANSWER 直接答；SEARCH/READ 确需才查；DO 明确要求才做，问句不算；不明确按上下文补全，仍不唯一就问，不动手。';
const DEFAULT_STEP =
  '[纪律提醒(非用户问题)] 先结论，默认简洁回答，不复述，不铺垫；用户要求详细时除外。';

type TabId = 'overview' | 'settings' | 'diagnostics';

type Part = { enabled: boolean; agents: string[]; text: string };

type Config = {
  version: number;
  enabled: boolean;
  first: Part;
  step: Part;
  logging: { enabled: boolean; path: string };
};

type EventRow = {
  ts: string;
  sessionID?: string;
  agent?: string;
  injectedFirst?: boolean;
  injectedStep?: boolean;
  error?: string | null;
};

const host = connectHost();
const root = document.querySelector('#root') as HTMLElement;

let built = false;
let booting = false;
let tab: TabId = 'overview';
let config: Config = cloneConfig(defaultConfig());
let draft: Config = cloneConfig(defaultConfig());
let dirty = false;
let events: EventRow[] = [];
let allAgents: string[] = [];
let baseAgents: string[] = [];
const agentRebuilders: Array<() => void> = [];

function removeAgent(name: string): void {
  allAgents = allAgents.filter((item) => item !== name);
  baseAgents = baseAgents.filter((item) => item !== name);
  draft.first.agents = draft.first.agents.filter((item) => item !== name);
  draft.step.agents = draft.step.agents.filter((item) => item !== name);
  for (const rebuild of agentRebuilders) rebuild();
  markDirty();
  updatePreview();
}
let configError = '';
let eventError = '';

let bannerSlot!: HTMLElement;
let bannerHandle: BannerHandle | null = null;
let tabsHandle: TabsHandle | null = null;
let saveHandle: ButtonHandle | null = null;
let saveStateEl!: HTMLElement;
let statusPillEl!: HTMLElement;
let overviewPage!: HTMLElement;
let settingsPage!: HTMLElement;
let diagnosticsPage!: HTMLElement;
let kpisEl!: HTMLElement;
let recentEl!: HTMLElement;
let previewEl!: HTMLElement;
let diagSummaryEl!: HTMLElement;
let diagTableEl!: HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function defaultConfig(): Config {
  return {
    version: 2,
    enabled: true,
    first: { enabled: true, agents: [...DEFAULT_AGENTS], text: DEFAULT_FIRST },
    step: { enabled: true, agents: [...DEFAULT_AGENTS], text: DEFAULT_STEP },
    logging: { enabled: true, path: EVENTS_PATH },
  };
}

function cloneConfig(value: Config): Config {
  return JSON.parse(JSON.stringify(value)) as Config;
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name = String(item ?? '').trim().slice(0, 100);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

function splitNames(value: string): string[] {
  return String(value || '')
    .split(/[,，、\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizePart(raw: unknown, fallback: Part): Part {
  const next: Part = { enabled: fallback.enabled, agents: [...fallback.agents], text: fallback.text };
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
  // Presence of the array is meaningful: [] means "no agent", not "default".
  if (Array.isArray(value.agents)) next.agents = normalizeNames(value.agents);
  if (typeof value.text === 'string') next.text = value.text.trim();
  return next;
}

function normalizeConfig(raw: unknown): Config {
  const next = defaultConfig();
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
  next.first = normalizePart(value.first, next.first);
  next.step = normalizePart(value.step, next.step);
  const logging = value.logging as Record<string, unknown> | undefined;
  if (logging && typeof logging === 'object') {
    if (typeof logging.enabled === 'boolean') next.logging.enabled = logging.enabled;
    if (typeof logging.path === 'string' && logging.path.startsWith('~/')) next.logging.path = logging.path;
  }
  return next;
}

async function readText(path: string): Promise<string | null> {
  try {
    const result = await host.readFile(path);
    return typeof result.content === 'string' ? result.content : '';
  } catch {
    return null;
  }
}

async function loadConfig(): Promise<void> {
  const raw = await readText(CONFIG_PATH);
  configError = '';
  if (raw == null) {
    config = defaultConfig();
  } else {
    try {
      config = normalizeConfig(JSON.parse(raw) as unknown);
    } catch (err) {
      config = defaultConfig();
      configError = `配置解析失败，使用默认值：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!dirty) draft = cloneConfig(config);
}

async function loadAgents(): Promise<void> {
  const set = new Set<string>([
    ...DEFAULT_AGENTS,
    ...config.first.agents,
    ...config.step.agents,
    ...draft.first.agents,
    ...draft.step.agents,
  ]);
  try {
    const result = await host.listDir(AGENTS_DIR);
    for (const entry of result.entries ?? []) {
      const name = String(entry?.name || '');
      if (!name.endsWith('.md')) continue;
      set.add(name.slice(0, -3));
    }
  } catch {
    // Agent discovery is optional; plan/build and configured names still work.
  }
  allAgents = [...set].sort((a, b) => a.localeCompare(b));
  baseAgents = [...allAgents];
}

async function loadEvents(): Promise<void> {
  const raw = await readText(EVENTS_PATH);
  eventError = '';
  if (!raw) {
    events = [];
    return;
  }
  const rows: EventRow[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text) as EventRow;
      if (value && typeof value === 'object' && typeof value.ts === 'string') rows.push(value);
    } catch {
      // Skip malformed line.
    }
  }
  events = rows.slice(-300).reverse();
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDay(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function todayRows(): EventRow[] {
  const today = localDay(new Date());
  return events.filter((row) => {
    const date = parseDate(row.ts);
    return date !== null && localDay(date) === today;
  });
}

function fmtDayTime(value: string): string {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function injectionLabel(row: EventRow): string {
  return [row.injectedFirst ? 'F' : '', row.injectedStep ? 'S' : ''].filter(Boolean).join('+') || '—';
}

function setBanner(tone: 'info' | 'warning' | 'error', title: string, body: string): void {
  if (bannerHandle) {
    bannerHandle.update({ tone, title, body });
    return;
  }
  bannerHandle = mountBanner(bannerSlot, { tone, title, body });
}

function markDirty(): void {
  dirty = true;
  saveHandle?.update({ disabled: false });
  if (saveStateEl) saveStateEl.textContent = '有未保存更改';
}

function kpi(label: string, value: string, sub = ''): HTMLElement {
  const box = el('div', 'kpi');
  box.append(el('div', 'k', label), el('div', 'v', value));
  if (sub) box.append(el('div', 's', sub));
  return box;
}

function empty(text: string): HTMLElement {
  return el('div', 'empty', text);
}

function sectionHead(title: string, badge: string, tone: 'green' | 'amber'): HTMLElement {
  const head = el('div', 'section-head');
  head.append(el('h3', '', title), el('span', `badge ${tone}`, badge));
  return head;
}

function settingsNote(text: string): HTMLElement {
  return el('div', 'settings-note', text);
}

const EVENT_COLUMNS: Array<{ label: string; width: string }> = [
  { label: '时间', width: '112px' },
  { label: 'agent', width: '88px' },
  { label: '会话', width: 'auto' },
  { label: '注入', width: '68px' },
  { label: '错误', width: '150px' },
];

function eventTable(rows: EventRow[]): HTMLElement {
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'event-table');
  const colgroup = el('colgroup');
  for (const col of EVENT_COLUMNS) {
    const cell = el('col');
    cell.style.width = col.width;
    colgroup.append(cell);
  }
  const head = el('thead');
  const hr = el('tr');
  for (const col of EVENT_COLUMNS) hr.append(el('th', '', col.label));
  head.append(hr);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const session = el('td', 'mono session', String(row.sessionID || '—'));
    session.title = row.sessionID || '';
    tr.append(
      el('td', 'num', fmtDayTime(row.ts)),
      el('td', 'mono', row.agent || '—'),
      session,
      el('td', row.error ? 'bad' : 'ok', injectionLabel(row)),
      el('td', row.error ? 'bad' : '', row.error || ''),
    );
    body.append(tr);
  }
  table.append(colgroup, head, body);
  wrap.append(table);
  return wrap;
}

function renderOverview(): void {
  const rows = todayRows();
  const first = rows.filter((row) => Boolean(row.injectedFirst)).length;
  const step = rows.filter((row) => Boolean(row.injectedStep)).length;
  const errors = rows.filter((row) => !!row.error).length;

  statusPillEl.textContent = config.enabled ? 'Active' : 'Inactive';
  statusPillEl.classList.toggle('off', !config.enabled);

  kpisEl.textContent = '';
  kpisEl.append(
    kpi('今日轮次', String(rows.length)),
    kpi('首次注入', rows.length ? fmtPct(first / rows.length) : '—', 'F'),
    kpi('每步注入', rows.length ? fmtPct(step / rows.length) : '—', 'S'),
    kpi('错误', String(errors), errors ? '查看诊断' : ''),
  );

  recentEl.textContent = '';
  const recent = rows.slice(0, 8);
  if (!recent.length) {
    recentEl.append(empty('今天还没有事件。产生一轮对话后，这里会出现记录。'));
    return;
  }
  recentEl.append(eventTable(recent));
}

function previewText(): string {
  if (!draft.enabled) return '插件已关闭：不拦截、不注入。';
  const first = draft.first.enabled ? draft.first.text.trim() : '';
  const step = draft.step.enabled ? draft.step.text.trim() : '';
  if (!first && !step) return '两段都为空：不注入任何内容，消息原样发送。';
  const firstCall = [first, step].filter(Boolean).join('\n');
  return [
    '首次调用（first + step）',
    firstCall || '（不注入）',
    '',
    '后续调用（step）',
    step || '（不注入）',
  ].join('\n');
}

function updatePreview(): void {
  if (previewEl) previewEl.textContent = previewText();
}

function buildAgentEditor(slot: HTMLElement, part: Part): void {
  const block = el('div', 'agent-block');
  const chips = el('div', 'agent-chips');
  block.append(chips);

  const addSlot = el('div', 'agent-extra');
  block.append(addSlot);
  slot.append(block);

  const rebuild = (): void => {
    chips.textContent = '';
    for (const name of allAgents) {
      const wrap = el('span', 'agent-chip-wrap');
      const button = el('button', 'agent-chip', name);
      button.type = 'button';
      button.title = '点击启用或取消';
      button.setAttribute('aria-pressed', part.agents.includes(name) ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (part.agents.includes(name)) part.agents = part.agents.filter((item) => item !== name);
        else part.agents = [...part.agents, name];
        button.setAttribute('aria-pressed', part.agents.includes(name) ? 'true' : 'false');
        markDirty();
        updatePreview();
      });
      wrap.append(button);
      if (!baseAgents.includes(name)) {
        const remove = el('button', 'agent-chip-x', '×');
        remove.type = 'button';
        remove.title = '从列表移除';
        remove.addEventListener('click', () => removeAgent(name));
        wrap.append(remove);
      }
      chips.append(wrap);
    }
  };
  agentRebuilders.push(rebuild);
  rebuild();

  let pending = '';
  mountTextField(addSlot, {
    label: '其他 agent',
    value: '',
    placeholder: '逗号分隔，例如 general',
    helper: '输入后点添加；与上面勾选的名字合并',
    onChange: (value) => {
      pending = value;
    },
  });
  const addButtonSlot = el('div', 'variant-refresh');
  addSlot.append(addButtonSlot);
  mountButton(addButtonSlot, {
    label: '添加',
    size: 'xs',
    variant: 'outline',
    onClick: () => {
      const names = splitNames(pending);
      if (!names.length) return;
      for (const name of names) {
        if (!allAgents.includes(name)) allAgents.push(name);
        if (!part.agents.includes(name)) part.agents.push(name);
      }
      allAgents.sort((a, b) => a.localeCompare(b));
      pending = '';
      rebuild();
      markDirty();
      updatePreview();
    },
  });
}

function buildPartCard(
  key: 'first' | 'step',
  title: string,
  badge: string,
  description: string,
  fallbackText: string,
): HTMLElement {
  const part = draft[key];
  const card = el('div', 'settings-card');
  card.append(sectionHead(title, badge, 'green'));
  const body = el('div', 'settings-card-body');

  const head = el('div', 'mode-head');
  head.append(el('span', 'row-label', '启用'));
  const switchSlot = el('div');
  head.append(switchSlot);
  body.append(head);

  let partSwitch: ReturnType<typeof mountSwitch> | null = null;
  partSwitch = mountSwitch(switchSlot, {
    label: '',
    checked: part.enabled,
    onChange: (checked) => {
      part.enabled = checked;
      partSwitch?.update({ checked });
      markDirty();
      updatePreview();
    },
  });

  const agentRow = el('div', 'part-grid');
  agentRow.append(el('span', 'row-label', '作用 agent'));
  const agentSlot = el('div');
  agentRow.append(agentSlot);
  body.append(agentRow);
  buildAgentEditor(agentSlot, part);
  agentRow.append(
    el('div', 'oc-sdk-field-note', '未勾选 = 对该 agent 不注入；全部不勾 = 这段关闭。'),
  );

  const textSlot = el('div');
  body.append(textSlot);
  const field = mountTextField(textSlot, {
    label: '注入文本',
    value: part.text,
    multiline: true,
    rows: 4,
    placeholder: fallbackText,
    onChange: (value) => {
      part.text = value;
      markDirty();
      updatePreview();
    },
  });

  const actions = el('div', 'diag-actions');
  body.append(actions);
  mountButton(actions, {
    label: '恢复默认',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      part.text = fallbackText;
      field.update({ value: fallbackText });
      markDirty();
      updatePreview();
    },
  });
  mountButton(actions, {
    label: '清空文本',
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      part.text = '';
      field.update({ value: '' });
      markDirty();
      updatePreview();
    },
  });

  card.append(body, settingsNote(description));
  return card;
}

function buildSettings(): void {
  settingsPage.textContent = '';

  const globalCard = el('div', 'settings-card');
  globalCard.append(sectionHead('总开关', '插件', 'green'));
  const globalBody = el('div', 'settings-card-body');
  const globalHead = el('div', 'mode-head');
  globalHead.append(el('span', 'row-label', '启用'));
  const globalSwitchSlot = el('div');
  globalHead.append(globalSwitchSlot);
  globalBody.append(globalHead);
  globalCard.append(globalBody, settingsNote('关闭后插件不拦截、不注入；面板仍可读写配置。'));
  settingsPage.append(globalCard);

  let globalSwitch: ReturnType<typeof mountSwitch> | null = null;
  globalSwitch = mountSwitch(globalSwitchSlot, {
    label: '',
    checked: draft.enabled,
    onChange: (checked) => {
      draft.enabled = checked;
      globalSwitch?.update({ checked });
      markDirty();
      updatePreview();
    },
  });

  settingsPage.append(
    buildPartCard(
      'first',
      '每轮首次注入',
      '每轮第一次',
      '只在本轮第一次模型调用时追加，排在每步注入前面；文本为空就不加这一段。',
      DEFAULT_FIRST,
    ),
  );

  settingsPage.append(
    buildPartCard(
      'step',
      '每步注入',
      '每次模型调用',
      '用户提问那一步和之后每次工具调用都追加；文本为空就不加这一段。',
      DEFAULT_STEP,
    ),
  );

  const logCard = el('div', 'settings-card');
  logCard.append(sectionHead('日志', '诊断', 'amber'));
  const logBody = el('div', 'settings-card-body');
  const logHead = el('div', 'mode-head');
  logHead.append(el('span', 'row-label', '记录'));
  const logSwitchSlot = el('div');
  logHead.append(logSwitchSlot);
  logBody.append(logHead);
  const pathRow = el('div', 'setting-row');
  pathRow.append(el('span', 'row-label', '路径'), el('div', 'setting-value', draft.logging.path));
  logBody.append(pathRow);
  logCard.append(logBody, settingsNote('每个轮次首次调用记一条；没有注入时不写。'));
  settingsPage.append(logCard);

  let logSwitch: ReturnType<typeof mountSwitch> | null = null;
  logSwitch = mountSwitch(logSwitchSlot, {
    label: '',
    checked: draft.logging.enabled,
    onChange: (checked) => {
      draft.logging.enabled = checked;
      logSwitch?.update({ checked });
      markDirty();
    },
  });

  const previewCard = el('div', 'settings-card');
  previewCard.append(sectionHead('拼接预览', '按当前选择', 'green'));
  const previewBody = el('div', 'settings-card-body');
  previewEl = el('div', 'preview');
  previewBody.append(previewEl);
  previewCard.append(previewBody, settingsNote('实际注入时按各段所选 agent 过滤；这是合并后的样子。'));
  settingsPage.append(previewCard);
  updatePreview();

  const saveRow = el('div', 'save-row');
  saveHandle = mountButton(saveRow, {
    label: '保存',
    variant: 'default',
    disabled: !dirty,
    onClick: () => void saveConfig(),
  });
  saveStateEl = el('span', 'save-state', dirty ? '有未保存更改' : '已同步');
  saveRow.append(saveStateEl);
  settingsPage.append(saveRow);
}

function renderDiagnostics(): void {
  diagSummaryEl.textContent = eventError
    ? eventError
    : events.length
      ? `诊断事件 ${events.length} 条 · 每轮首次调用一条`
      : '诊断事件 0 条 · 插件产生第一轮后会出现';
  diagSummaryEl.classList.add('foot');

  diagTableEl.textContent = '';
  if (!events.length) {
    diagTableEl.append(empty(eventError ? eventError : '暂无诊断事件。'));
    return;
  }
  diagTableEl.append(eventTable(events));
}

function buildDiagnostics(): void {
  diagnosticsPage.textContent = '';

  diagSummaryEl = el('div', 'foot', '正在读取诊断事件…');
  diagnosticsPage.append(diagSummaryEl);

  const tools = el('div', 'diag-tools');
  const actions = el('div', 'diag-actions');
  tools.append(actions);
  diagnosticsPage.append(tools);

  mountButton(actions, {
    label: '刷新',
    size: 'sm',
    variant: 'outline',
    onClick: () => void refreshEvents(),
  });
  mountButton(actions, {
    label: '复制 JSONL',
    size: 'sm',
    variant: 'outline',
    onClick: () => void copyEvents(),
  });
  mountButton(actions, {
    label: '清空',
    size: 'sm',
    variant: 'ghost',
    onClick: () => void clearEvents(),
  });

  diagTableEl = el('div');
  diagnosticsPage.append(diagTableEl);
}

function showTab(next: TabId): void {
  tab = next;
  tabsHandle?.update({ activeId: tab });
  overviewPage.hidden = tab !== 'overview';
  settingsPage.hidden = tab !== 'settings';
  diagnosticsPage.hidden = tab !== 'diagnostics';
  overviewPage.classList.toggle('on', tab === 'overview');
  settingsPage.classList.toggle('on', tab === 'settings');
  diagnosticsPage.classList.toggle('on', tab === 'diagnostics');
  if (tab === 'overview') renderOverview();
  if (tab === 'diagnostics') renderDiagnostics();
}

function buildDom(): void {
  if (built) return;
  built = true;
  root.textContent = '';

  const hd = el('div', 'hd');
  hd.append(el('h1', '', '增强提示卡'));
  hd.append(
    el(
      'div',
      'hd-desc',
      '为所选 agent 注入两段临时提醒：每轮首次（first）+ 每步（step）\n追加在当前用户消息请求副本尾部，不落盘、不发第二条消息。',
    ),
  );
  root.append(hd);

  const tabsRow = el('div', 'tabs-row');
  const tabsSlot = el('div', 'tabs-slot');
  statusPillEl = el('span', 'status-pill', 'Active');
  tabsRow.append(tabsSlot, statusPillEl);
  root.append(tabsRow);
  tabsHandle = mountTabs(tabsSlot, {
    items: [
      { id: 'overview', label: '概览' },
      { id: 'settings', label: '设置' },
      { id: 'diagnostics', label: '诊断' },
    ],
    activeId: tab,
    onChange: (value) => showTab(value as TabId),
  });

  bannerSlot = el('div', 'banner-slot');
  root.append(bannerSlot);

  overviewPage = el('div', 'ic-page on');
  kpisEl = el('div', 'kpis');
  recentEl = el('div');
  overviewPage.append(kpisEl, el('div', 'section-title', '最近轮次'), recentEl);
  root.append(overviewPage);

  settingsPage = el('div', 'ic-page behavior');
  settingsPage.hidden = true;
  root.append(settingsPage);

  diagnosticsPage = el('div', 'ic-page');
  diagnosticsPage.hidden = true;
  root.append(diagnosticsPage);

  buildSettings();
  buildDiagnostics();
  showTab('overview');

  if (configError) setBanner('warning', '配置回退', configError);
  if (eventError) setBanner('warning', '事件读取失败', eventError);
}

async function refreshEvents(): Promise<void> {
  await loadEvents();
  if (!built) return;
  renderOverview();
  renderDiagnostics();
}

async function saveConfig(): Promise<void> {
  if (!dirty) return;
  saveHandle?.update({ loading: true });
  try {
    const next = normalizeConfig(draft);
    await host.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
    config = cloneConfig(next);
    // Keep the draft object identity: the built controls hold references to its
    // parts, and replacing it would leave them editing a detached copy.
    dirty = false;
    saveHandle?.update({ disabled: true });
    if (saveStateEl) saveStateEl.textContent = '已保存 · 下一轮生效';
    setBanner('info', '已保存', '配置已写入，插件下一轮读取；无需重启。');
    renderOverview();
  } catch (err) {
    setBanner('error', '保存失败', err instanceof Error ? err.message : String(err));
  } finally {
    saveHandle?.update({ loading: false });
  }
}

async function copyEvents(): Promise<void> {
  if (!events.length) {
    setBanner('info', '没有事件', '当前没有可复制的诊断事件。');
    return;
  }
  const text = [...events]
    .reverse()
    .map((row) => JSON.stringify(row))
    .join('\n');
  try {
    await host.writeClipboard(text);
    setBanner('info', '已复制', `已复制 ${events.length} 条事件 JSONL。`);
  } catch (err) {
    setBanner('error', '复制失败', err instanceof Error ? err.message : String(err));
  }
}

async function clearEvents(): Promise<void> {
  if (!events.length) return;
  if (!window.confirm('清空增强提示卡诊断事件？此操作不可撤销。')) return;
  try {
    await host.writeFile(EVENTS_PATH, '');
    events = [];
    renderOverview();
    renderDiagnostics();
    setBanner('info', '已清空', '诊断事件已清空。');
  } catch (err) {
    setBanner('error', '清空失败', err instanceof Error ? err.message : String(err));
  }
}

async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    await loadConfig();
    await loadAgents();
    await loadEvents();
    buildDom();
    renderOverview();
    renderDiagnostics();
  } finally {
    booting = false;
  }
}

const MOCK = new URLSearchParams(location.search).has('mock');

async function bootMock(): Promise<void> {
  for (const [name, value] of Object.entries({
    '--ic-bg': '#12161a',
    '--ic-fg': '#e9eef3',
    '--ic-elevated': '#1a2027',
    '--ic-border': 'rgba(255,255,255,0.14)',
  })) {
    document.documentElement.style.setProperty(name, value);
  }
  config = defaultConfig();
  draft = cloneConfig(config);
  allAgents = [...new Set([...DEFAULT_AGENTS, 'general', 'explore'])].sort((a, b) => a.localeCompare(b));
  baseAgents = [...allAgents];
  const now = Date.now();
  const session = 'ses_3e342829-9df5-4bda-b5d0-428ada3ab8b8';
  events = [
    { ts: new Date(now - 4 * 60e3).toISOString(), sessionID: session, agent: 'plan', injectedFirst: true, injectedStep: true, error: null },
    { ts: new Date(now - 11 * 60e3).toISOString(), sessionID: session, agent: 'plan', injectedFirst: false, injectedStep: true, error: null },
    { ts: new Date(now - 26 * 60e3).toISOString(), sessionID: 'ses_71a0c4de-2b46-4d7a-9c19-0f5c2b7d8e11', agent: 'build', injectedFirst: true, injectedStep: true, error: null },
    { ts: new Date(now - 42 * 60e3).toISOString(), sessionID: 'ses_71a0c4de-2b46-4d7a-9c19-0f5c2b7d8e11', agent: 'build', injectedFirst: false, injectedStep: true, error: null },
    { ts: new Date(now - 58 * 60e3).toISOString(), sessionID: session, agent: 'plan', injectedFirst: false, injectedStep: false, error: 'write failed: EACCES' },
  ];
  buildDom();
  renderOverview();
  renderDiagnostics();
}

if (MOCK) {
  void bootMock();
} else {
  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    void boot();
  });
  setTimeout(() => {
    if (!built && !booting) void boot();
  }, 1500);
  setInterval(() => {
    if (!document.hidden && built) void refreshEvents();
  }, POLL_MS);
}
