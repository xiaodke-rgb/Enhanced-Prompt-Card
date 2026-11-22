/**
 * 增强提示卡面板：概览 / 设置 / 诊断。
 *
 * 面板读写两个位置：
 * - ~/.local/share/opencode/plugin-data/enhanced-prompt-card/（配置、模型缓存、诊断事件）
 * - ~/.config/opencode/agents/*.md（只读可用 agent 名）
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

const DATA_DIR = '~/.local/share/opencode/plugin-data/enhanced-prompt-card';
const CONFIG_PATH = `${DATA_DIR}/config.json`;
const MODELS_PATH = `${DATA_DIR}/models.json`;
const EVENTS_PATH = `${DATA_DIR}/events.jsonl`;
const AGENTS_DIR = '~/.config/opencode/agents';
const POLL_MS = 5000;
const EVENT_TABLE_LIMIT = 300;
const CLIPBOARD_TIMEOUT_MS = 3000;

const KNOWN_AGENTS = ['plan', 'build'];

type TabId = 'overview' | 'settings' | 'diagnostics';

type Part = { enabled: boolean; agents: string[]; text: string };

type FirstPrompt = {
  label: string;
  enabled: boolean;
  agents: string[];
  models: string[];
  text: string;
};

type FirstPart = { enabled: boolean; prompts: FirstPrompt[] };

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
  promptIndex?: number;
  promptLabel?: string;
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
  draft.first.prompts = draft.first.prompts.map((prompt) => ({
    ...prompt,
    agents: prompt.agents.filter((item) => item !== name),
  }));
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
let refreshHandle: ButtonHandle | null = null;
let copyHandle: ButtonHandle | null = null;
let clearHandle: ButtonHandle | null = null;
let clearing = false;
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
let clearConfirmEl!: HTMLElement;
let clearConfirmTextEl!: HTMLElement;
let copyFallbackEl!: HTMLElement;
let copyFallbackTextEl!: HTMLTextAreaElement;

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
    version: 3,
    enabled: false,
    first: { enabled: false, prompts: [] },
    step: { enabled: false, agents: [], text: '' },
    logging: { enabled: false, path: `${DATA_DIR}/events.jsonl` },
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

function normalizePart(raw: unknown): Part {
  const next: Part = { enabled: false, agents: [], text: '' };
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  next.enabled = value.enabled === true;
  if (Array.isArray(value.agents)) next.agents = normalizeNames(value.agents);
  if (typeof value.text === 'string') next.text = value.text.trim();
  return next;
}

function normalizeFirstPrompt(raw: unknown): FirstPrompt {
  const next: FirstPrompt = { label: '', enabled: false, agents: [], models: [], text: '' };
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  if (typeof value.label === 'string') next.label = value.label.trim().slice(0, 60);
  next.enabled = value.enabled === true;
  if (Array.isArray(value.agents)) next.agents = normalizeNames(value.agents);
  if (Array.isArray(value.models)) next.models = normalizeNames(value.models);
  if (typeof value.text === 'string') next.text = value.text.trim();
  return next;
}

// The list is the only shape written from now on. A config still carrying the
// old single `text` becomes the first entry, so nothing needs retyping.
function normalizeFirst(raw: unknown): FirstPart {
  const next: FirstPart = { enabled: false, prompts: [] };
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  next.enabled = value.enabled === true;
  if (Array.isArray(value.prompts)) {
    for (const item of value.prompts.slice(0, 20)) next.prompts.push(normalizeFirstPrompt(item));
  }
  if (!next.prompts.length && (typeof value.text === 'string' || Array.isArray(value.models))) {
    next.prompts.push({
      label: '',
      enabled: value.enabled === true,
      agents: Array.isArray(value.agents) ? normalizeNames(value.agents) : [],
      models: Array.isArray(value.models) ? normalizeNames(value.models) : [],
      text: typeof value.text === 'string' ? value.text.trim() : '',
    });
  }
  return next;
}

function normalizeConfig(raw: unknown): Config {
  const next = emptyConfig();
  if (!raw || typeof raw !== 'object') return next;
  const value = raw as Record<string, unknown>;
  next.enabled = value.enabled === true;
  next.first = normalizeFirst(value.first);
  next.step = normalizePart(value.step);
  const logging = value.logging as Record<string, unknown> | undefined;
  if (logging && typeof logging === 'object') {
    next.logging.enabled = logging.enabled === true;
    next.logging.path =
      typeof logging.path === 'string' && logging.path.trim()
        ? logging.path
        : `${DATA_DIR}/events.jsonl`;
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
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
    ...config.first.prompts.flatMap((prompt) => prompt.agents),
    ...config.step.agents,
    ...draft.first.prompts.flatMap((prompt) => prompt.agents),
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
  events = rows.reverse();
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

function injectionLabel(row: EventRow): string {
  if (row.kind === 'first') return row.injectedFirst ? 'F 已注入' : 'F 未注入';
  if (row.kind === 'prompt') {
    return row.syntheticStep || row.persistedStep || row.injectedStep ? 'S 已注入' : 'S 未注入';
  }
  if (row.injectedFirst) return 'F 已注入';
  return row.syntheticStep || row.persistedStep || row.injectedStep ? 'S 已注入' : 'S 未注入';
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
  { label: '会话', width: 'auto' },
  { label: '结果', width: '110px' },
  { label: '提示词', width: '120px' },
  { label: '模型', width: 'auto' },
  { label: '错误', width: '110px' },
];

function promptCell(row: EventRow): string {
  if (typeof row.promptIndex !== 'number') return '—';
  const name = (row.promptLabel || '').trim();
  return name ? `F${row.promptIndex + 1} ${name}` : `F${row.promptIndex + 1}`;
}

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
      session,
      el('td', row.error ? 'bad' : 'ok', injectionLabel(row)),
      el('td', 'mono', promptCell(row)),
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
  const firstInjected = rows.filter((row) => row.kind === 'first' && row.injectedFirst).length;
  const firstMissed = rows.filter((row) => row.kind === 'first' && !row.injectedFirst).length;
  const stepInjected = rows.filter(
    (row) => row.kind === 'prompt' && (row.syntheticStep || row.persistedStep || row.injectedStep),
  ).length;
  const stepMissed = rows.filter(
    (row) => row.kind === 'prompt' && !(row.syntheticStep || row.persistedStep || row.injectedStep),
  ).length;
  const errors = rows.filter((row) => !!row.error).length;

  statusPillEl.textContent = config.enabled ? 'Active' : 'Inactive';
  statusPillEl.classList.toggle('off', !config.enabled);

  kpisEl.textContent = '';
  kpisEl.append(
    kpi('今日事件', String(rows.length)),
    kpi('F 已注入', String(firstInjected)),
    kpi('F 未注入', String(firstMissed)),
    kpi('S 已注入', String(stepInjected)),
    kpi('S 未注入', String(stepMissed)),
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

function liveTextarea(selector: string): string | null {
  if (!settingsPage) return null;
  const node = settingsPage.querySelector(selector) as HTMLTextAreaElement | null;
  return node ? node.value : null;
}

// Single-line fields (the prompt name) need the same treatment as textareas:
// an IME commit or a host re-render can leave the control ahead of the draft.
function liveInput(selector: string): string | null {
  if (!settingsPage) return null;
  const node = settingsPage.querySelector(selector) as HTMLInputElement | null;
  return node ? node.value : null;
}

function previewValues(): { first: string[]; step: string } {
  // Read the live textarea values, not only the draft: the preview must mirror
  // what is on screen even when a host re-render or IME path skips onChange.
  const first = draft.first.prompts.map((prompt, index) => {
    const live = liveTextarea(`textarea[data-prompt-index="${index}"]`);
    return (live === null ? prompt.text : live).trim();
  });
  const stepLive = liveTextarea('textarea[data-step-text]');
  return { first, step: (stepLive === null ? draft.step.text : stepLive).trim() };
}

function previewText(): string {
  if (!draft.enabled) return '插件已关闭：不拦截、不注入。';
  const values = previewValues();
  const step = draft.step.enabled ? values.step : '';
  const prompts = draft.first.enabled ? draft.first.prompts : [];
  const blocks: string[] = [];
  if (step) blocks.push('用户消息前（S 隐藏注入）', step);
  prompts.forEach((prompt, index) => {
    const text = values.first[index] || '';
    if (!prompt.enabled || !text) return;
    const models = prompt.models.length ? `模型：${prompt.models.join(', ')}` : '模型：全部';
    const name = prompt.label ? ` ${prompt.label}` : '';
    blocks.push('', `首轮调用 F${index + 1}${name}（${models}）`, text);
  });
  if (!blocks.length) return '两段都为空：不注入任何内容，消息原样发送。';
  return blocks.join('\n');
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

function buildModelEditor(slot: HTMLElement, prompt: FirstPrompt): void {
  const chips = el('div', 'agent-chips');
  const addSlot = el('div', 'agent-extra');
  slot.append(chips, addSlot);

  const rebuild = (): void => {
    chips.textContent = '';
    for (const id of prompt.models) {
      const wrap = el('span', 'agent-chip-wrap');
      const chip = el('span', 'agent-chip', id);
      chip.title = id;
      const remove = el('button', 'agent-chip-x', '×');
      remove.type = 'button';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        prompt.models = prompt.models.filter((item) => item !== id);
        rebuild();
        markDirty();
        updatePreview();
      });
      wrap.append(chip, remove);
      chips.append(wrap);
    }
    if (panel.hidden) trigger.textContent = `选择模型（${prompt.models.length}）`;
  };

  // The SDK's select opens a fixed-position popup, which the panel's iframe
  // clips to a couple of rows. Use an in-card dropdown instead: click the
  // trigger to expand a search box plus a scrollable list, click outside to
  // collapse. Everything stays inside the card, so nothing gets clipped.
  const picker = el('div', 'model-picker');
  const trigger = el('button', 'model-trigger', '选择模型');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  const panel = el('div', 'model-panel');
  panel.hidden = true;
  const search = el('input', 'oc-sdk-input model-search');
  search.type = 'search';
  search.autocomplete = 'off';
  search.placeholder = modelCatalog.length ? '搜索 provider/model，点击添加' : '模型列表未生成，重启 OpenCode 后可用';
  search.disabled = !modelCatalog.length;
  const list = el('div', 'model-list');
  panel.append(search, list);
  // The catalog is a file the plugin rewrites when providers change; reload it
  // without reopening the panel so a newly added provider shows up.
  const refresh = el('button', 'model-refresh', '刷新');
  refresh.type = 'button';
  refresh.title = '重新读取模型列表';
  const triggerRow = el('div', 'model-trigger-row');
  triggerRow.append(trigger, refresh);
  picker.append(triggerRow, panel);
  addSlot.append(picker);

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    picker.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.textContent = open ? '收起模型列表' : `选择模型（${prompt.models.length}）`;
    if (open) search.focus();
  };
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(panel.hidden);
  });
  const closeOnOutside = (event: MouseEvent): void => {
    if (!picker.isConnected) {
      document.removeEventListener('click', closeOnOutside, true);
      return;
    }
    if (!picker.contains(event.target as Node)) setOpen(false);
  };
  document.addEventListener('click', closeOnOutside, true);

  const paintList = (): void => {
    list.textContent = '';
    const needle = search.value.trim().toLowerCase();
    const matched = modelCatalog.filter(
      (item) => !needle || item.id.toLowerCase().includes(needle),
    );
    if (!matched.length) {
      list.append(el('div', 'model-empty', modelCatalog.length ? '没有匹配的模型' : '模型列表未生成'));
      return;
    }
    for (const item of matched.slice(0, 300)) {
      const picked = prompt.models.includes(item.id);
      const row = el('button', 'model-row');
      row.type = 'button';
      row.setAttribute('aria-pressed', picked ? 'true' : 'false');
      row.append(el('span', 'model-row-id', item.id));
      if (item.providerName) row.append(el('span', 'model-row-src', item.providerName));
      row.addEventListener('click', () => {
        // Toggle: the same list both adds and removes, chips above stay the view.
        prompt.models = picked
          ? prompt.models.filter((value) => value !== item.id)
          : [...prompt.models, item.id];
        rebuild();
        paintList();
        markDirty();
        updatePreview();
      });
      list.append(row);
    }
    if (matched.length > 300) {
      list.append(el('div', 'model-empty', `仅显示前 300 条，共 ${matched.length} 条，请输入关键字缩小范围`));
    }
  };

  search.addEventListener('input', paintList);

  const reloadCatalog = async (): Promise<void> => {
    refresh.disabled = true;
    refresh.textContent = '刷新中';
    await loadModels();
    refresh.disabled = false;
    refresh.textContent = '刷新';
    search.disabled = !modelCatalog.length;
    search.placeholder = modelCatalog.length
      ? '搜索 provider/model，点击添加'
      : '模型列表未生成，重启 OpenCode 后可用';
    paintList();
  };
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    void reloadCatalog();
  });

  paintList();
  rebuild();
}

// One reminder per model family. Each card carries its own agents, models and
// text; the plugin injects the first card that matches the turn's model.
function buildFirstCard(): HTMLElement {
  const card = el('div', 'settings-card');
  card.append(sectionHead('每轮首次注入', '按模型分配', 'green'));
  const body = el('div', 'settings-card-body');

  const head = el('div', 'mode-head');
  head.append(el('span', 'row-label', '启用'));
  const switchSlot = el('div');
  head.append(switchSlot);
  body.append(head);

  let partSwitch: ReturnType<typeof mountSwitch> | null = null;
  partSwitch = mountSwitch(switchSlot, {
    label: '',
    checked: draft.first.enabled,
    onChange: (checked) => {
      draft.first.enabled = checked;
      partSwitch?.update({ checked });
      markDirty();
      updatePreview();
    },
  });

  const list = el('div', 'prompt-list');
  body.append(list);

  const renderList = (): void => {
    list.textContent = '';
    if (!draft.first.prompts.length) {
      list.append(empty('还没有提示词。点下面「添加提示词」，一条对应一组模型。'));
      return;
    }
    draft.first.prompts.forEach((prompt, index) => {
      list.append(buildPromptCard(prompt, index, renderList));
    });
  };

  const addRow = el('div', 'diag-actions');
  body.append(addRow);
  mountButton(addRow, {
    label: '添加提示词',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      draft.first.prompts.push({
        label: `F${draft.first.prompts.length + 1}`,
        enabled: true,
        agents: [...KNOWN_AGENTS],
        models: [],
        text: '',
      });
      renderList();
      markDirty();
      updatePreview();
    },
  });

  renderList();
  card.append(body, settingsNote('按顺序取第一条「启用 + agent 命中 + 模型命中」的文本注入；模型留空 = 该条对所有模型生效。'));
  return card;
}

function buildPromptCard(prompt: FirstPrompt, index: number, rerender: () => void): HTMLElement {
  const wrap = el('div', 'prompt-card');
  const head = el('div', 'prompt-head');
  head.append(el('span', 'prompt-title', prompt.label || `F${index + 1}`));

  const headActions = el('div', 'prompt-head-actions');
  head.append(headActions);

  let promptSwitch: ReturnType<typeof mountSwitch> | null = null;
  const switchSlot = el('div');
  headActions.append(switchSlot);
  promptSwitch = mountSwitch(switchSlot, {
    label: '',
    checked: prompt.enabled,
    onChange: (checked) => {
      prompt.enabled = checked;
      promptSwitch?.update({ checked });
      markDirty();
      updatePreview();
    },
  });

  mountButton(headActions, {
    label: '删除',
    size: 'xs',
    variant: 'ghost',
    onClick: () => {
      draft.first.prompts.splice(index, 1);
      rerender();
      markDirty();
      updatePreview();
    },
  });
  wrap.append(head);

  const body = el('div', 'prompt-body');

  const nameSlot = el('div');
  body.append(nameSlot);
  const nameField = mountTextField(nameSlot, {
    label: '名称',
    value: prompt.label,
    placeholder: '例如 F1 / DeepSeek',
    onChange: (value) => {
      prompt.label = value.trim().slice(0, 60);
      const title = head.querySelector('.prompt-title');
      if (title) title.textContent = prompt.label || `F${index + 1}`;
      markDirty();
      updatePreview();
    },
  });
  // Saving reads this control directly, so a missed onChange (IME commit,
  // autofill, host re-render) can no longer write an empty name.
  const nameInput = nameSlot.querySelector('input');
  if (nameInput) {
    nameInput.dataset.promptName = String(index);
    // IME commits can land without an `input` event; sync on blur too.
    nameInput.addEventListener('change', () => {
      prompt.label = nameInput.value.trim().slice(0, 60);
      const title = head.querySelector('.prompt-title');
      if (title) title.textContent = prompt.label || `F${index + 1}`;
      markDirty();
      updatePreview();
    });
  }
  void nameField;

  const agentRow = el('div', 'part-grid');
  agentRow.append(el('span', 'row-label', '作用 agent'));
  const agentSlot = el('div');
  agentRow.append(agentSlot);
  body.append(agentRow);
  buildAgentEditor(agentSlot, prompt);
  agentRow.append(el('div', 'oc-sdk-field-note', '未勾选 = 对该 agent 不注入。'));

  const modelRow = el('div', 'part-grid');
  modelRow.append(el('span', 'row-label', '作用模型'));
  const modelSlot = el('div');
  modelRow.append(modelSlot);
  body.append(modelRow);
  buildModelEditor(modelSlot, prompt);
  modelRow.append(el('div', 'oc-sdk-field-note', '留空 = 所有模型；多条命中时取列表中靠前的一条。'));

  const textSlot = el('div');
  body.append(textSlot);
  const field = mountTextField(textSlot, {
    label: '注入文本',
    value: prompt.text,
    multiline: true,
    rows: 4,
    placeholder: '输入这条提示词要注入的文本',
    onChange: (value) => {
      prompt.text = value;
      markDirty();
      updatePreview();
    },
  });
  const area = textSlot.querySelector('textarea');
  if (area) area.dataset.promptIndex = String(index);

  const actions = el('div', 'diag-actions');
  body.append(actions);
  mountButton(actions, {
    label: '清空文本',
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      prompt.text = '';
      field.update({ value: '' });
      markDirty();
      updatePreview();
    },
  });

  wrap.append(body);
  return wrap;
}

function buildStepCard(
  title: string,
  badge: string,
  description: string,
): HTMLElement {
  const part = draft.step;
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
    placeholder: '输入这段要注入的文本',
    onChange: (value) => {
      part.text = value;
      markDirty();
      updatePreview();
    },
  });
  const area = textSlot.querySelector('textarea');
  if (area) area.dataset.stepText = '1';

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

  settingsPage.append(buildFirstCard());

  settingsPage.append(
    buildStepCard(
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
  logCard.append(logBody, settingsNote('用户消息提交时记一条（S 隐藏注入），首轮临时注入再记一条；没有事件时不写。'));
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
    settingsNote('写入 ~/.local/share/opencode/plugin-data/enhanced-prompt-card/config.json；改动 0.6 秒内自动保存，插件下一轮按 mtime 读取。'),
  );
}

function renderDiagnostics(): void {
  const shown = Math.min(events.length, EVENT_TABLE_LIMIT);
  diagSummaryEl.textContent = eventError
    ? eventError
    : events.length
      ? `诊断事件 ${events.length} 条 · 表格显示 ${shown} 条 · S 隐藏注入 + 首轮调用`
      : '诊断事件 0 条 · 插件产生第一轮后会出现';
  diagSummaryEl.classList.add('foot');

  diagTableEl.textContent = '';
  if (!events.length) {
    diagTableEl.append(empty(eventError ? eventError : '暂无诊断事件。'));
    return;
  }
  diagTableEl.append(eventTable(events.slice(0, EVENT_TABLE_LIMIT)));
}

function buildDiagnostics(): void {
  diagnosticsPage.textContent = '';

  diagSummaryEl = el('div', 'foot', '正在读取诊断事件…');
  diagnosticsPage.append(diagSummaryEl);

  const tools = el('div', 'diag-tools');
  const actions = el('div', 'diag-actions');
  tools.append(actions);
  diagnosticsPage.append(tools);

  refreshHandle = mountButton(actions, {
    label: '刷新',
    size: 'sm',
    variant: 'outline',
    onClick: () => void refreshEvents(true),
  });
  copyHandle = mountButton(actions, {
    label: '复制 JSONL',
    size: 'sm',
    variant: 'outline',
    onClick: () => void copyEvents(),
  });
  clearHandle = mountButton(actions, {
    label: '清空',
    size: 'sm',
    variant: 'ghost',
    onClick: () => requestClearEvents(),
  });

  clearConfirmEl = el('div', 'clear-confirm');
  clearConfirmEl.hidden = true;
  clearConfirmTextEl = el('span', 'clear-confirm-text');
  const clearConfirmActions = el('div', 'diag-actions');
  clearConfirmEl.append(clearConfirmTextEl, clearConfirmActions);
  mountButton(clearConfirmActions, {
    label: '取消',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      clearConfirmEl.hidden = true;
    },
  });
  mountButton(clearConfirmActions, {
    label: '确认清空',
    size: 'sm',
    variant: 'destructive',
    onClick: () => void clearEvents(),
  });
  diagnosticsPage.append(clearConfirmEl);

  copyFallbackEl = el('div', 'copy-fallback');
  copyFallbackEl.hidden = true;
  const fallbackHead = el('div', 'copy-fallback-head');
  fallbackHead.append(el('span', 'copy-fallback-title', '复制未完成，可手动全选复制'));
  const close = el('button', 'copy-fallback-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', () => {
    copyFallbackEl.hidden = true;
  });
  fallbackHead.append(close);
  copyFallbackTextEl = el('textarea', 'copy-fallback-text');
  copyFallbackTextEl.readOnly = true;
  copyFallbackTextEl.spellcheck = false;
  copyFallbackEl.append(fallbackHead, copyFallbackTextEl);
  diagnosticsPage.append(copyFallbackEl);

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
      '为所选 agent 追加两段提醒：S 作为隐藏消息排在用户消息前，F 只在首轮调用临时注入\n不修改工具结果，不把 S 拼进用户消息。',
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

async function refreshEvents(manual = false): Promise<void> {
  if (manual) refreshHandle?.update({ loading: true, label: '刷新中…' });
  try {
    await loadEvents();
    if (!built) return;
    renderOverview();
    renderDiagnostics();
    if (manual) setBanner('info', '已刷新', `读取 ${events.length} 条诊断事件。`);
  } finally {
    if (manual) refreshHandle?.update({ loading: false, label: '刷新' });
  }
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
    // The draft already holds every control's value except the textarea, which a
    // host re-render or an IME path can leave ahead of the draft. Bring the
    // draft up to date first, then normalise ONCE: writing a half-normalised
    // object and comparing it to the normalised read-back always fails on a
    // trailing newline or space, which is what made saving look broken.
    const live = previewValues();
    draft.first.prompts.forEach((prompt, index) => {
      if (live.first[index] !== undefined) prompt.text = live.first[index];
      // Names come from the live controls too: mountTextField only reports on
      // `input`, and an IME commit or a host re-render can skip that.
      const name = liveInput(`input[data-prompt-name="${index}"]`);
      if (name !== null) prompt.label = name.trim().slice(0, 60);
    });
    draft.step.text = live.step;

    const next = normalizeConfig(draft);
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
    const prompts = draft.first.prompts;
    next.first.prompts.forEach((prompt, index) => {
      const held = prompts[index];
      if (!held) return;
      // Copy every field back, not just the text: the controls hold these
      // objects, and a field left behind silently reverts on the next save.
      held.label = prompt.label;
      held.enabled = prompt.enabled;
      held.agents = [...prompt.agents];
      held.models = [...prompt.models];
      held.text = prompt.text;
    });
    draft.step.text = next.step.text;
    dirty = false;
    configError = '';
    saveHandle?.update({ disabled: true });
    if (saveStateEl) saveStateEl.textContent = auto ? '已自动保存 · 下一轮生效' : '已保存 · 下一轮生效';
    if (!auto) {
      const names = next.first.prompts
        .map((prompt, index) => `F${index + 1}「${prompt.label || '未命名'}」`)
        .join('、');
      setBanner('info', '已保存', names ? `已写入并校验：${names}` : '配置已写入并校验，插件下一轮读取；无需重启。');
    }
    renderOverview();
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? ` [${String((err as { code?: unknown }).code)}]` : '';
    const message = err instanceof Error ? err.message : String(err);
    if (saveStateEl) saveStateEl.textContent = (auto ? '自动保存失败' : '保存失败') + code;
    setBanner('error', auto ? '自动保存失败' : '保存失败', `${message}${code}`);
  } finally {
    saveHandle?.update({ loading: false });
  }
}

async function copyEvents(): Promise<void> {
  if (!events.length) {
    copyFallbackEl.hidden = true;
    setBanner('info', '没有事件', '当前没有可复制的诊断事件。');
    return;
  }
  const count = events.length;
  const text = [...events]
    .reverse()
    .map((row) => JSON.stringify(row))
    .join('\n');
  copyHandle?.update({ loading: true });
  try {
    await withTimeout(
      host.writeClipboard(text),
      CLIPBOARD_TIMEOUT_MS,
      `宿主剪贴板 ${CLIPBOARD_TIMEOUT_MS / 1000} 秒未响应`,
    );
    copyFallbackEl.hidden = true;
    setBanner('info', '已复制', `已复制全部 ${count} 条事件 JSONL。`);
  } catch (err) {
    copyFallbackTextEl.value = text;
    copyFallbackEl.hidden = false;
    copyFallbackTextEl.focus();
    copyFallbackTextEl.select();
    const reason = err instanceof Error ? err.message : String(err);
    setBanner('warning', '复制失败，已展开文本', `${reason}。可手动全选复制。`);
  } finally {
    copyHandle?.update({ loading: false });
  }
}

function requestClearEvents(): void {
  if (!events.length) {
    setBanner('info', '没有事件', '当前没有可清空的诊断事件。');
    return;
  }
  clearConfirmTextEl.textContent = `确认清空全部 ${events.length} 条诊断事件？此操作不可撤销。`;
  clearConfirmEl.hidden = false;
  clearConfirmEl.scrollIntoView({ block: 'nearest' });
}

async function clearEvents(): Promise<void> {
  if (!events.length || clearing) return;
  const count = events.length;
  clearing = true;
  clearHandle?.update({ loading: true });
  try {
    await host.writeFile(EVENTS_PATH, '');
    events = [];
    clearConfirmEl.hidden = true;
    copyFallbackEl.hidden = true;
    renderOverview();
    renderDiagnostics();
    setBanner('info', '已清空', `已清空全部 ${count} 条诊断事件。`);
  } catch (err) {
    setBanner('error', '清空失败', err instanceof Error ? err.message : String(err));
  } finally {
    clearing = false;
    clearHandle?.update({ loading: false });
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
    { kind: 'prompt', ts: new Date(now - 4 * 60e3).toISOString(), sessionID: session, agent: 'plan', persistedStep: true, persistReason: 'synthetic', syntheticStep: true, injectedFirst: false, injectedStep: true, error: null },
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
