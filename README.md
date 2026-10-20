# Enhanced Prompt Card

给 OpenCode 的顶层会话临时追加两段提醒：**每轮首次注入（first）** 和 **每步注入（step）**。

只拦截、只拼装、只追加：插件不自带任何文案，文本为空就不注入。追加发生在当前请求的消息副本里，不落盘，也不会出现成第二条用户消息。

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

- `first`：用户发出问题的第一次模型调用注入。
- `step`：用户提问那一步，以及之后每次工具调用都注入。
- 首次调用 = `first + "\n" + step`；之后的调用 = `step`。
- 两段各自独立配置启用的 agent，默认 `plan`、`build`；不对子代理生效。
- 文本为空、agent 未勾选、开关关闭 → 该段不注入；两段都不生效时消息原样发送。
- `[系统提醒(非用户问题)]` 这类前缀只是文本内容，插件不会额外加标题或标记。

成本参考：first ≈ 58 tokens，step ≈ 32 tokens（o200k 估算）。缓存上只有每轮第一次的 first 部分无法复用，后续步骤仍按前缀命中。

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
  "first": { "enabled": true, "agents": ["plan", "build"], "text": "..." },
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

- 概览：今日轮次、首次/每步注入率、错误数、最近轮次表
- 设置：总开关、两段各自的开关 / agent 多选 / 文本、日志开关、拼接预览
- 诊断：最近事件表（时间 / agent / 会话 / 注入 / 错误）、刷新、复制 JSONL、清空

概览显示今天最近 8 条，诊断最多显示 300 条。

## 日志

每轮首次调用且至少注入一段时写一条：

```json
{"ts":"2026-10-20T11:12:26.401Z","sessionID":"ses_...","agent":"plan","injectedFirst":true,"injectedStep":true,"error":null}
```

无注入且无错误时不写。

## License

MIT

> After updating the plugin code, restart OpenCode once to load it. Editing `enhanced-prompt-card.json` alone needs no restart: the plugin reloads it by mtime.
