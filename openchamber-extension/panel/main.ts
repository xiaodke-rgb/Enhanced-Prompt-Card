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
  mountSelect,
  mountSwitch,
  mountTabs,
  mountTextField,
  type BannerHandle,
  type ButtonHandle,
  type TabsHandle,
} from '@openchamber/sdk/ui';

const CONFIG_PATH = '~/.config/opencode/enhanced-prompt-card.json';
const MODELS_PATH = '~/.config/opencode/enhanced-prompt-card-models.json';
const EVENTS_PATH = '~/.config/opencode/enhanced-prompt-card-events.jsonl';
const AGENTS_DIR = '~/.config/opencode/agents';
const POLL_MS = 5000;

const KNOWN_AGENTS = ['plan', 'build'];

type TabId = 'overview' | 'settings' | 'diagnostics';

type Part = { enabled: boolean; agents: string[]; text: string };

type FirstPart = Part & { models: string[] };

type Config = {
  version: number;
  enabled: boolean;
  first: FirstPart;
  step: Part;
  logging: { enabled: boolean; path: string };
};

type EventRow = {
  ts: string;
  kind?: string;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  injectedFirst?: boolean;
  injectedStep?: boolean;
  persistedStep?: boolean;
  persistReason?: string;
  syntheticStep?: boolean;
  reason?: string;
  model?: string;
  error?: string | null;
};

type ModelEntry = { id: string; name: string; providerName?: string };

const host = connectHost();
const root = document.querySelector('#root') as HTMLElement;

let built = false;
let booting = false;
let tab: TabId = 'overview';
let config: Config = cloneConfig(emptyConfig());
let draft: Config = cloneConfig(emptyConfig());
let dirty = false;
let events: EventRow[] = [];
let allAgents: string[] = [];
let baseAgents: string[] = [];
let modelCatalog: ModelEntry[] = [];
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

// The panel carries no canned prompt text either: whatever sits in the config
// file is shown and saved verbatim. A missing file starts empty, not defaulted.
function emptyConfig(): Config {
  return {
    version: 2,
    enabled: false,
    first: { enabled: false, agents: [], models: [], text: '' },
    step: { enabled: false, agents: [], text: '' },
    logging: { enabled: false, path: '' },
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

function normalizePart(raw: unknown, withModels = false): Part {
  const next: Part = { enabled: false, agents: [], text: '' };
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  next.enabled = value.enabled === true;
  if (Array.isArray(value.agents)) next.agents = normalizeNames(value.agents);
  if (typeof value.text === 'string') next.text = value.text.trim();
  if (withModels) {
    (next as FirstPart).models = Array.isArray(value.models) ? normalizeNames(value.models) : [];
  }
  return next;
}

function normalizeConfig(raw: unknown): Config {
  const next = emptyConfig();
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  next.enabled = value.enabled === true;
  next.first = normalizePart(value.first, true) as FirstPart;
  next.step = normalizePart(value.step);
  const logging = value.logging as Record<string, unknown> | undefined;
  if (logging && typeof logging === 'object') {
    next.logging.enabled = logging.enabled === true;
    if (typeof logging.path === 'string') next.logging.path = logging.path;
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
    config = emptyConfig();
    configError = '配置文件不存在：插件当前不注入任何内容，保存后创建。';
  } else {
    try {
      config = normalizeConfig(JSON.parse(raw) as unknown);
    } catch (err) {
      config = emptyConfig();
      configError = `配置解析失败，未注入任何内容：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!dirty) draft = cloneConfig(config);
}

async function loadAgents(): Promise<void> {
  const set = new Set<string>([
    ...KNOWN_AGENTS,
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

async function loadModels(): Promise<void> {
  modelCatalog = [];
  const raw = await readText(MODELS_PATH);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { models?: ModelEntry[] };
    if (!Array.isArray(parsed.models)) return;
    modelCatalog = parsed.models
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' && item.name ? item.name : item.id,
        providerName: typeof item.providerName === 'string' ? item.providerName : '',
      }));
  } catch {
    modelCatalog = [];
  }
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

function reasonLabel(value?: string): string {
  switch (value) {
    case 'injected':
      return '已注入';
    case 'model-mismatch':
      return '模型不符';
    case 'no-model':
      return '未取到模型';
    case 'appended':
      return '已追加';
    case 'already-persisted':
      return '已存在';
    case 'synthetic':
      return '隐藏注入';
    case 'synthetic-error':
      return '隐藏注入失败';
    default:
      return value || '—';
  }
}

function eventKindLabel(row: EventRow): string {
  const base = row.kind === 'prompt' ? '用户消息' : row.kind === 'first' ? '首轮调用' : '旧记录';
  return row.agent ? `${base} · ${row.agent}` : base;
}

function injectionLabel(row: EventRow): string {
  if (row.kind === 'prompt') {
    if (row.syntheticStep) return 'S 已注入（隐藏）';
    return row.persistedStep ? 'S 已落盘' : 'S 未落盘';
  }
  if (row.kind === 'first') return row.injectedFirst ? 'F 已注入' : 'F 未注入';
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
  scheduleAutoSave();
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
  { label: '时间', width: '96px' },
  { label: '类型', width: '120px' },
  { label: '会话', width: 'auto' },
  { label: '结果', width: '100px' },
  { label: '原因', width: '96px' },
  { label: '模型', width: 'auto' },
  { label: '错误', width: '110px' },
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
      el('td', '', eventKindLabel(row)),
      session,
      el('td', row.error ? 'bad' : 'ok', injectionLabel(row)),
      el('td', row.error ? 'bad' : '', reasonLabel(row.reason || row.persistReason)),
      el('td', 'mono', row.model || '—'),
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
  const persisted = rows.filter((row) => Boolean(row.persistedStep)).length;
  const skipped = rows.filter((row) => row.reason === 'model-mismatch' || row.reason === 'no-model').length;
  const errors = rows.filter((row) => !!row.error).length;

  statusPillEl.textContent = config.enabled ? 'Active' : 'Inactive';
  statusPillEl.classList.toggle('off', !config.enabled);

  kpisEl.textContent = '';
  kpisEl.append(
    kpi('今日事件', String(rows.length)),
    kpi('首轮 F', String(first), '次注入'),
    kpi('S 注入', String(persisted), '条隐藏消息'),
    kpi('跳过 F', String(skipped), skipped ? '模型不符/无模型' : ''),
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

function previewValues(): { first: string; step: string } {
  // Read the live textarea values, not only the draft: the preview must mirror
  // what is on screen even when a host re-render or IME path skips onChange.
  const areas = settingsPage ? Array.from(settingsPage.querySelectorAll('textarea')) : []
  const read = (index: number, key: 'first' | 'step'): string =>
    areas[index] ? areas[index].value : draft[key].text
  return { first: read(0, 'first').trim(), step: read(1, 'step').trim() }
}

function previewText(): string {
  if (!draft.enabled) return '插件已关闭：不拦截、不注入。';
  const values = previewValues();
  const first = draft.first.enabled ? values.first : '';
  const step = draft.step.enabled ? values.step : '';
  if (!first && !step) return '两段都为空：不注入任何内容，消息原样发送。';
  const models = draft.first.models.length ? `（仅限模型：${draft.first.models.join(', ')}）` : '';
  return [
    '用户消息（S 落盘）',
    step || '（不落盘）',
    '',
    `首轮调用（临时 F）${models}`,
    first || '（不注入）',
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
  showModels = false,
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

  if (showModels) {
    const firstPart = part as FirstPart;
    const modelRow = el('div', 'part-grid');
    modelRow.append(el('span', 'row-label', '作用模型'));
    const modelSlot = el('div');
    modelRow.append(modelSlot);
    body.append(modelRow);

    const chips = el('div', 'agent-chips');
    const addSlot = el('div', 'agent-extra');
    modelSlot.append(chips, addSlot);

    const rebuild = (): void => {
      chips.textContent = '';
      for (const id of firstPart.models) {
        const wrap = el('span', 'agent-chip-wrap');
        const chip = el('span', 'agent-chip', id);
        chip.title = id;
        const remove = el('button', 'agent-chip-x', '×');
        remove.type = 'button';
        remove.title = '移除';
        remove.addEventListener('click', () => {
          firstPart.models = firstPart.models.filter((item) => item !== id);
          rebuild();
          markDirty();
          updatePreview();
        });
        wrap.append(chip, remove);
        chips.append(wrap);
      }
    };

    const options = modelCatalog.map((item) => ({
      id: item.id,
      label: item.id,
      hint: item.providerName || '',
    }));
    const select = mountSelect(addSlot, {
      label: '添加模型',
      value: null,
      options,
      searchable: true,
      searchPlaceholder: '搜索 provider/model',
      placeholder: options.length ? '选择要注入 first 的模型' : '模型列表未生成，重启 OpenCode 后可用',
      disabled: !options.length,
      onChange: (id) => {
        if (!id) return;
        if (!firstPart.models.includes(id)) firstPart.models = [...firstPart.models, id];
        select.update({ value: null });
        rebuild();
        markDirty();
        updatePreview();
      },
    });
    rebuild();
    modelRow.append(
      el('div', 'oc-sdk-field-note', '留空 = 全部模型；选中后需 agent 与模型同时命中。'),
    );
  }

  const textSlot = el('div');
  body.append(textSlot);
  const field = mountTextField(textSlot, {
    label: '注入文本',
    value: part.text,
    multiline: true,
    rows: 4,
    placeholder: '输入这段要注入的文本',
    onChange: (value) => {
      part.text = value;
      markDirty();
      updatePreview();
    },
  });

  const actions = el('div', 'diag-actions');
  body.append(actions);
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
      '只在本轮第一次模型调用时临时追加，需同时满足所选 agent 与模型；文本为空就不加这一段。',
      true,
    ),
  );

  settingsPage.append(
    buildPartCard(
      'step',
      '纪律提醒（S）',
      '落盘',
      '用户提问时追加到消息尾部并落盘；之后每步从历史读取，不再重复注入。文本为空就不加。',
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
  logCard.append(logBody, settingsNote('用户消息落盘记一条，首轮临时注入再记一条；没有事件时不写。'));
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
  previewCard.append(previewBody, settingsNote('S 写入用户消息；F 只临时加在首轮请求，按 agent 与模型过滤。'));
  settingsPage.append(previewCard);
  updatePreview();

  // Safety net: keep the preview in sync even if a control's own handler misses
  // an event (IME commits, browser autofill, host re-render).
  if (settingsPage.dataset.previewBound !== '1') {
    settingsPage.dataset.previewBound = '1';
    settingsPage.addEventListener('input', () => { updatePreview(); scheduleAutoSave(); }, true);
    settingsPage.addEventListener('change', () => { updatePreview(); scheduleAutoSave(); }, true);
  }

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
  settingsPage.append(
    settingsNote('写入 ~/.config/opencode/enhanced-prompt-card.json；改动 0.6 秒内自动保存，插件下一轮按 mtime 读取。'),
  );
}

function renderDiagnostics(): void {
  diagSummaryEl.textContent = eventError
    ? eventError
    : events.length
      ? `诊断事件 ${events.length} 条 · 用户消息落盘 + 首轮调用`
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
      '为所选 agent 追加两段提醒：S 落盘到用户消息，F 只在首轮调用临时注入\n不修改工具结果、不发第二条消息。',
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

let autoSaveTimer: number | null = null;

function scheduleAutoSave(): void {
  if (!built || booting) return;
  if (autoSaveTimer !== null) window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    void saveConfig(true);
  }, 600);
}

async function saveConfig(auto = false): Promise<void> {
  if (!dirty) return;
  saveHandle?.update({ loading: !auto });
  if (auto && saveStateEl) saveStateEl.textContent = '自动保存中…';
  try {
    const next = normalizeConfig(draft);
    // Save what is on screen, not a possibly stale draft copy.
    const live = previewValues();
    next.first.text = live.first;
    next.step.text = live.step;
    const payload = JSON.stringify(next, null, 2) + '\n';
    await host.writeFile(CONFIG_PATH, payload);

    // Read back: the file is the contract the plugin loads, so prove it matches.
    const backRaw = await readText(CONFIG_PATH);
    if (backRaw == null) throw new Error('写入后读不到配置文件');
    const back = normalizeConfig(JSON.parse(backRaw) as unknown);
    if (JSON.stringify(back) !== JSON.stringify(next)) {
      throw new Error('写入校验失败：文件内容与面板不一致');
    }

    config = cloneConfig(next);
    // Keep the draft object identity: the built controls hold references to its
    // parts, and replacing it would leave them editing a detached copy.
    draft.first.text = next.first.text;
    draft.step.text = next.step.text;
    dirty = false;
    configError = '';
    saveHandle?.update({ disabled: true });
    if (saveStateEl) saveStateEl.textContent = auto ? '已自动保存 · 下一轮生效' : '已保存 · 下一轮生效';
    if (!auto) setBanner('info', '已保存', '配置已写入并校验，插件下一轮读取；无需重启。');
    renderOverview();
  } catch (err) {
    if (saveStateEl) saveStateEl.textContent = auto ? '自动保存失败' : '保存失败';
    setBanner('error', auto ? '自动保存失败' : '保存失败', err instanceof Error ? err.message : String(err));
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
    await loadModels();
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
  config = emptyConfig();
  draft = cloneConfig(config);
  allAgents = [...new Set([...KNOWN_AGENTS, 'general', 'explore'])].sort((a, b) => a.localeCompare(b));
  baseAgents = [...allAgents];
  const now = Date.now();
  const session = 'ses_3e342829-9df5-4bda-b5d0-428ada3ab8b8';
  events = [
    { kind: 'prompt', ts: new Date(now - 4 * 60e3).toISOString(), sessionID: session, agent: 'plan', persistedStep: true, persistReason: 'appended', injectedFirst: false, injectedStep: true, error: null },
    { kind: 'first', ts: new Date(now - 4 * 60e3 + 80).toISOString(), sessionID: session, agent: 'plan', injectedFirst: true, reason: 'injected', model: 'deepseek/deepseek-flash', error: null },
    { kind: 'prompt', ts: new Date(now - 26 * 60e3).toISOString(), sessionID: 'ses_71a0c4de-2b46-4d7a-9c19-0f5c2b7d8e11', agent: 'build', persistedStep: true, persistReason: 'already-persisted', injectedFirst: false, injectedStep: true, error: null },
    { kind: 'first', ts: new Date(now - 26 * 60e3 + 80).toISOString(), sessionID: 'ses_71a0c4de-2b46-4d7a-9c19-0f5c2b7d8e11', agent: 'build', injectedFirst: false, reason: 'model-mismatch', model: 'opencode-go/grok-4.7', error: null },
    { kind: 'first', ts: new Date(now - 58 * 60e3).toISOString(), sessionID: session, agent: 'plan', injectedFirst: false, reason: 'no-model', model: '', error: 'write failed: EACCES' },
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
  // The preview must never lag behind the visible inputs.
  setInterval(() => {
    if (!document.hidden && built && tab === 'settings') updatePreview();
  }, 400);
}
