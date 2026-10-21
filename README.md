# Enhanced Prompt Card

给 OpenCode 的顶层会话追加两段提醒：**纪律提醒（S）落盘到用户消息**，**首轮提醒（F）只在第一次模型调用临时注入**。

只拦截、只拼装、只追加：插件不自带任何文案，文本为空就不落盘/不注入。S 在 prompt hook 追加到用户消息并落盘；F 只改当前请求副本，不落盘，也不会出现成第二条用户消息。

## 目录

```
plugin/                        OpenCode 插件
  enhanced-prompt-card.ts
  enhanced-prompt-card.example.json
openchamber-extension/         OpenChamber 面板扩展（设置 + 诊断）
  package.json
  build.mjs
  panel/
```

## 行为

- `first`：用户发出问题的第一次模型调用临时注入，需同时命中 agent 与模型。
- `step`：用户提问时追加到用户消息尾部并落盘，之后每步从历史读取，不再重复注入。
- 首次调用 = `S + "\n" + F`；后续调用不再追加。
- 两段各自独立配置启用的 agent，默认 `plan`、`build`；不对子代理生效。
- 文本为空、agent 未勾选、开关关闭 → 该段不生效；两段都不生效时消息原样发送。
- `[系统提醒(非用户问题)]` 这类前缀只是文本内容，插件不会额外加标题或标记。

成本参考：first ≈ 58 tokens，step ≈ 32 tokens（o200k 估算）。S 落盘后进入前缀，跨轮可复用；每轮只有临时 F 无法复用。

## 安装插件

```bash
cp plugin/enhanced-prompt-card.ts ~/.config/opencode/plugins/
```

配置文件（必填，插件与面板都不内置任何默认文本）：

```bash
cp plugin/enhanced-prompt-card.example.json ~/.config/opencode/enhanced-prompt-card.json
```

```json
{
  "version": 2,
  "enabled": true,
  "first": { "enabled": true, "agents": ["plan", "build"], "models": [], "text": "..." },
  "step":  { "enabled": true, "agents": ["plan", "build"], "text": "..." },
  "logging": { "enabled": true, "path": "~/.config/opencode/enhanced-prompt-card-events.jsonl" }
}
```

插件只读这个文件：文件缺失或解析失败时不注入任何内容，不会用代码里的默认值顶替。配置按 mtime 热加载，改完下一轮生效，无需重启。

## 安装面板扩展

把 `openchamber-extension/` 整个目录放到 OpenChamber 的扩展目录，例如：

```bash
cp -r openchamber-extension ~/.config/openchamber/extensions/enhanced-prompt-card
cd ~/.config/openchamber/extensions/enhanced-prompt-card
npm install
npm run build
```

然后在 OpenChamber 的扩展列表里加入该目录（或写进 `~/.config/openchamber/extensions.json` 的 `paths`）。

面板提供：

- 概览：今日事件、首轮 F、S 落盘、跳过、错误数、最近事件表
- 设置：总开关、两段各自的开关 / agent 多选 / 文本、first 作用模型、日志开关、拼接预览
- 诊断：最近事件表（时间 / 类型 / 会话 / 结果 / 原因 / 模型 / 错误）、刷新、复制 JSONL、清空

概览显示今天最近 8 条，诊断最多显示 300 条。

## 日志

用户消息落盘时写一条 `kind:"prompt"`，首轮调用再写一条 `kind:"first"`：

```json
{"ts":"2026-10-21T06:29:35.220Z","kind":"prompt","sessionID":"ses_...","agent":"build","messageID":"msg_...","persistedStep":true,"persistReason":"appended","injectedFirst":false,"injectedStep":true,"error":null}
{"ts":"2026-10-21T06:29:35.292Z","kind":"first","sessionID":"ses_...","agent":"build","messageID":"msg_...","model":"deepseek/deepseek-flash","injectedFirst":true,"injectedStep":false,"reason":"injected","error":null}
```

无事件且无错误时不写。

## License

MIT

> After updating the plugin code, restart OpenCode once to load it. Editing `enhanced-prompt-card.json` alone needs no restart: the plugin reloads it by mtime.
