# 运行记录

RouterCoder 默认在此目录写入每轮任务的 JSON trace。文件包含任务文本、路由判断、模型用量和代码差异；这些 JSON 文件已被 Git 忽略。旧版本默认写入 `~/.local/state/routercoder/traces/`，原有文件仍可在那里查看。

要查看最新一轮的路由判断，可在项目根目录运行：

```bash
jq '.decision' "$(ls -t traces/*.json | head -n 1)"
```

`--trace-dir` 可以指定其他输出目录。
