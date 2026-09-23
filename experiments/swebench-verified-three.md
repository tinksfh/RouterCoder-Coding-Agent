# SWE-bench Verified 三题路由实验

数据集：[princeton-nlp/SWE-bench_Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)，`test` 分片。难度采用数据集自带的 `difficulty` 字段，不由 RouterCoder 预先判断。完整原始问题描述与基准提交号见 [swebench-verified-three.json](swebench-verified-three.json)。任务输入只使用 `problem_statement`，不传入官方修复补丁、测试补丁或人工难度标签。

| 人工难度 | 实例 | 问题概述 | 固定基准提交 |
| --- | --- | --- | --- |
| `<15 min fix` | `pytest-dev__pytest-5262` | `EncodedFile.mode` 错误地包含二进制标记 | `58e6a09db49f34886ff13f3b7520dd0bcd7063cd` |
| `15 min - 1 hour` | `pytest-dev__pytest-10051` | `caplog.clear()` 后 `get_records()` 与记录列表脱节 | `aa55975c7d3f6c9f6d7f68accc41bb7cadf0eb9a` |
| `1-4 hours` | `pytest-dev__pytest-10356` | 多重继承时 pytest 类标记未合并 | `3c1534944cbd34e8a41bc9e76818018fadefc9a1` |

本机已从 `pytest-dev/pytest` 克隆并创建三个独立、未修改的工作树，分别位于 `/tmp/routercoder-swebench-verified-experiment/easy`、`medium` 和 `hard`。在 Jev 凭据配置完成后，分别以 `--router jev` 运行三个实例，记录 Jev 选择的档位、Pi 实际模型、Token、API 等价模拟费用、耗时和生成补丁。对照数据集难度时，只比较路由方向；三道题不足以估计准确率或成本优势。

官方 SWE-bench 结果需要在 [Docker 评测环境](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/harness.md)中应用生成补丁并运行指定测试。本机已于 2026-09-23 安装 Docker Desktop 4.92.0，当前用户通过 `desktop-linux` context 成功运行 `hello-world`。原先的系统 Docker Engine 已停止。第三题现已运行官方 Docker harness，结果见下文；前两题仍只有本地指定测试结果。运行 Python Docker SDK 时，需设置 `DOCKER_HOST=unix:///home/zhang/.docker/desktop/docker.sock`，以连接 Desktop 的用户 socket。

## 首次运行结果（2026-09-23）

三题均以原始 `problem_statement` 输入 `--router jev`，在对应的基准提交上运行。表中金额是按 API 标准价格计算的模拟值，不是 ChatGPT 订阅账单，也不包含 Jev 费用。RouterCoder 的 `success` 只表示 Pi 没有报告错误且生成了 diff。

| 实例 | 人工难度 | Jev 判断 / 置信度 | 实际档位 / 模型 | 耗时 | 模拟费用 | 结果 |
| --- | --- | --- | --- | ---: | ---: | --- |
| `pytest-dev__pytest-5262` | `<15 min fix` | easy / 0.95 | Small / `gpt-5.6-luna` | 66.6 秒 | $0.00688 | 官方指定失败测试通过；107 项可运行的原有通过测试通过 |
| `pytest-dev__pytest-10051` | `15 min - 1 hour` | easy / 0.62 | Small / `gpt-5.6-luna` | 48.2 秒 | $0.00904 | 官方指定失败测试通过；15 项原有通过测试通过 |
| `pytest-dev__pytest-10356` | `1-4 hours` | medium / 0.59，触发低置信度回退 | Strong / `gpt-6-sol` | 155.3 秒 | $0.13228 | 官方指定失败测试仍失败；未解决 |

第二题的 Jev 判断与数据集人工难度不一致。第三题选中 Strong 是 0.60 阈值回退的结果，不是 Jev 直接判断为 hard。不能据此把三题路由结果称为准确率，也不能把补丁生成率当作 Verified 解决率。

运行记录与补丁：

- 简单题：[trace](artifacts/easy-trace.json)、[patch](artifacts/easy.patch)
- 中等题：[trace](artifacts/medium-trace.json)、[patch](artifacts/medium.patch)
- 困难题：[trace](artifacts/hard-trace.json)、[patch](artifacts/hard.patch)

## 补充判定

为进一步判断是否解决问题，我们在另外三个独立评估副本中只应用模型的源码改动及数据集的官方 `test_patch`，再运行 `FAIL_TO_PASS` 和 `PASS_TO_PASS` 指定测试。简单题使用隔离的 Python 3.7 环境，中等和困难题使用隔离的 Python 3.10 环境，均在 `/tmp/routercoder-swebench-verified-experiment` 下；没有更改生成补丁的原始工作树。

- 简单题：指定的 `test_capfd_sys_stdout_mode` 通过。`PASS_TO_PASS` 列表有一个非测试项 `[100%]`，其余 107 项均通过。因此可认为该题**在本地指定测试下解决**。
- 中等题：指定的 `test_clear_for_call_stage` 通过，15 项 `PASS_TO_PASS` 全部通过。因此可认为该题**在本地指定测试下解决**，即使 Jev 把它判为 easy。
- 困难题：指定的 `test_mark_mro` 仍失败；模型修改后的 `get_unpacked_marks(C)` 返回生成器，而官方测试要求按 MRO 顺序返回标记列表。使用同一 Python 3.10 环境、官方参考修复补丁时，这项测试通过，因此失败不是测试环境本身造成的。该题**未解决**。模型新增的两项相关测试通过，未覆盖官方失败情形。

以上三题的“补充判定”均为本地测试；第三题另有下文的官方 Docker harness 结果。第三题模型运行时曾在基础 Python 环境安装可编辑的 pytest；实验后已移除该安装，恢复为未安装状态。

## 第三题官方评测（2026-09-23）

使用 `swebench 5.0.2`、`SWE-bench/SWE-bench_Verified` 数据集和第三题完整原始补丁，单任务运行官方 Docker harness。实例镜像为 `swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-10356:latest`。首次按旧文档使用 `princeton-nlp/SWE-bench_Verified` 时，新版 harness 因数据集中没有 `image` 字段退出，未进入测试；随后使用与该版本匹配的新数据集完成评测，运行 ID 为 `routercoder-hard-20260923-2`。

结果：补丁成功应用，测试实际运行；`test_mark_mro` 失败，`FAIL_TO_PASS` 为 0/1，`PASS_TO_PASS` 指定测试全部通过。pytest 总结为 1 失败、88 通过、1 xfail。失败原因是 `get_unpacked_marks(C)` 返回生成器，而官方测试要求列表。官方汇总报告为 **0/1 resolved，1/1 unresolved，0 infrastructure failures**。

汇总报告同时把该实例标记为 `ambiguous_failure: no_tests_collected`。这是该版本 harness 对完整测试输出的文本匹配结果：输出中包含嵌套测试的“0 items”信息，但主测试明确收集了 90 项并运行到 `test_mark_mro` 断言失败。因此该标记不改变未解决的判定。

- [预测文件](evaluation/hard/prediction.jsonl)
- [官方汇总](evaluation/hard/routercoder-jev-gpt-6-sol.routercoder-hard-20260923-2.json)
- [实例报告](evaluation/hard/logs/run_evaluation/routercoder-hard-20260923-2/routercoder-jev-gpt-6-sol/pytest-dev__pytest-10356/report.json)
- [测试输出](evaluation/hard/logs/run_evaluation/routercoder-hard-20260923-2/routercoder-jev-gpt-6-sol/pytest-dev__pytest-10356/test_output.txt)
