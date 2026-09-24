# RouterCoder 架构说明

## 目录职责

| 路径 | 职责 | 主要入口 |
| --- | --- | --- |
| `src/cli.ts` | 解析命令行参数，分发单次或交互模式 | `parseArgs`、`main` |
| `src/app/run.ts` | 编排单次任务、保存结果 | `run` |
| `src/core/` | 校验三档模型配置、执行难度路由、计算模拟费用、定义共享类型 | `config.ts`、`decision.ts`、`pricing.ts`、`types.ts` |
| `src/pi/` | 启动 Pi、在交互任务前切换模型、运行单次 Pi 会话 | `interactive.ts`、`extension.ts`、`runner.ts` |
| `src/repository/workspace.ts` | 检查目标目录，获取语言和文件数，计算任务前后差异 | `inspectWorkspace`、`snapshotWorkspace` |
| `src/telemetry/trace.ts` | 脱敏并写入 JSON 运行记录 | `writeTrace` |
| `test/` | 对配置、路由、仓库操作、费用和端到端行为的已有测试 | `*.test.ts` |
| `experiments/` | 基准任务输入、实验脚本、生成补丁和评估结果 | `run_verified_three.py` |
| `traces/` | 本机 JSON 运行记录；仅说明文件纳入 Git | `README.md` |
| `docs/reference/` | 项目原始设计文档 | 两份 `.docx` |

`scripts/create-demo-repo.mjs` 只负责创建演示仓库。`configs/models.yaml` 存放本机模型映射和价格，不存放密钥；Jev 从环境变量读取 `JEV_API_KEY`，Pi 从环境变量读取供应商 API Key。OpenAI Codex 的 OAuth 登录状态由 Pi 管理。`.env.example` 只是变量名称示例，程序不会自动加载。

## 任务流程

```mermaid
flowchart LR
  A[用户任务] --> B[检查本地目录并生成摘要]
  B --> C[路由器判断 easy/medium/hard]
  C --> D[映射 small/medium/strong]
  D --> E[Pi 切换模型并执行]
  E --> F[收集 Token、工具调用和代码差异]
  C --> G[JSON 运行记录]
  F --> G
```

单次模式由 `cli.ts` 调用 `app/run.ts`。交互模式由 `pi/interactive.ts` 启动 Pi 并加载 `pi/extension.ts`；扩展在每次新任务提交后、Pi 开始执行前完成路由和模型切换。两种模式都按任务前后的目录快照计算差异，允许已有修改。普通目录和没有提交的 Git 仓库也可作为目标；未指定 `--workspace` 时使用当前目录。

两种模式共用 `core/decision.ts` 的路由策略和 `core/config.ts` 的模型配置。Jev 请求只包含任务文本、目录语言和文件数；Pi 在选定模型后读取具体代码。Jev 调用失败或置信度低于 `0.60` 时使用 Strong 档，原因会写入运行记录。

## 运行记录与结果含义

默认记录目录为项目根目录的 `traces/`，可通过 `--trace-dir` 改写。`decision` 保存路由来源、Jev 难度与概率、最终档位和回退原因；`selectedModel` 保存实际配置的 Pi 模型；`agent.metrics` 保存 Pi 的用量和工具调用；`diff` 保存本轮代码差异。

当前版本把“Pi 无错误完成且产生代码差异”作为任务成功条件。因此一次只分析代码、或者目标文件在任务前已经修好时，记录可能显示 `failed` 和 `Pi completed without a code change`；这不表示 Jev 路由失败。结果质量和测试通过情况需要单独检查。

## 修改位置

- 调整任务难度标准或路由回退：`src/core/decision.ts`。
- 修改三档模型、上下文长度和价格：`configs/models.yaml`；共享样例同步修改 `configs/models.example.yaml`。
- 修改 Pi 交互任务的模型切换与轮次记录：`src/pi/extension.ts`。
- 修改单次运行流程：`src/app/run.ts`。
- 修改目录摘要或差异捕获：`src/repository/workspace.ts`。
- 修改运行记录格式或脱敏：`src/telemetry/trace.ts` 和 `src/core/types.ts`。

源码编译到 `dist/`，`dist/cli.js` 是对外命令入口。`npm run build` 会先清理旧的编译文件，避免目录调整后遗留过期模块，再生成新的输出。修改源码后重新构建，再启动 RouterCoder。
