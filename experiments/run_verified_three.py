#!/usr/bin/env python3
"""在已准备的独立工作树上运行一条 SWE-bench Verified Jev 路由实验。"""

import json
import os
import subprocess
import sys
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
EXPERIMENT = Path("/tmp/routercoder-swebench-verified-experiment")
WORKTREES = {"small": "easy", "medium": "medium", "strong": "hard"}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in WORKTREES:
        print("用法：python3 experiments/run_verified_three.py small|medium|strong", file=sys.stderr)
        return 2
    if not os.environ.get("JEV_API_KEY"):
        print("当前进程无法读取 JEV_API_KEY", file=sys.stderr)
        return 2

    tier = sys.argv[1]
    manifest = json.loads((PROJECT / "experiments/swebench-verified-three.json").read_text())
    task = next(item for item in manifest["tasks"] if item["tier"] == tier)
    repo = EXPERIMENT / WORKTREES[tier]
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    status = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain"], text=True).strip()
    if commit != task["base_commit"] or status:
        print(f"工作树 {repo} 不在干净的基准提交，拒绝重复运行", file=sys.stderr)
        return 2

    output = EXPERIMENT / "output"
    output.mkdir(exist_ok=True)
    command = [
        "node", str(PROJECT / "dist/cli.js"), "run",
        "--repo", str(repo), "--task", task["problem_statement"],
        "--router", "jev", "--config", str(PROJECT / "configs/models.yaml"),
        "--trace-dir", str(output / "traces"),
    ]
    print(f"开始 {task['instance_id']}；人工难度 {task['difficulty']}；RouterCoder 将自行路由", flush=True)
    try:
        result = subprocess.run(command, cwd=PROJECT, text=True, capture_output=True, timeout=600)
        log = result.stdout + result.stderr
        (output / f"{tier}.log").write_text(log)
        print(log, end="", flush=True)
        return result.returncode
    except subprocess.TimeoutExpired:
        print("超过 600 秒；已终止本次运行", file=sys.stderr)
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
