# AgentCommit（中文说明）

**审阅 AI 编码改动。恢复被中断的还原。**

AgentCommit 包装你现有的编码 Agent：Agent 动手前保存受保护文件；结束后审阅精确的
变更；需要回退时，默认拒绝覆盖 Agent 运行之后发生的新修改；如果恢复本身被中断，
新进程会依据持久化 Journal 继续，而不是靠猜。

> **Alpha 软件（`0.1.0-alpha.1`）。** 事务核心真实且经过充分验证：三平台 CI
> （Windows/Linux/macOS × Node 22/24）全绿，并有 20 个真实 Agent dogfood 会话
> （Z Code 与 Codex）——见下方支持矩阵。AgentCommit 不是备份产品、
> 不是模型服务、也不是 Git 的替代品。

## 安装

```bash
npm install -g @agentcommit/cli
```

需要 Node.js 22+（Node 24 可用）。无需账号与 API Key。AgentCommit 本身完全本地运行
——无遥测、不上传任何内容。（你的 Agent 与其模型服务商之间的通信走 Agent 自身的
通道，不经过 AgentCommit。）

## 60 秒上手

以下都是真实命令。每个工作区先执行一次 `init`，不会覆盖已有配置。

```bash
mkdir ac-demo && cd ac-demo
agentcommit init

# 包装任意 Agent 命令。运行前会精确打印受保护范围：
agentcommit run -- <你的 agent 命令>

# 审阅变更，然后接受或撤销：
agentcommit status
agentcommit diff
agentcommit commit     # 接受本 Session。注意：这不是 git commit。
# 或者把工作区恢复原样：
agentcommit rollback
```

- **Agent 结束后你又改了文件？** 默认拒绝回退——你的新修改优先，且本次调用零恢复
  写入。可用 `agentcommit status` 审阅、`agentcommit restore <路径>` 只恢复安全路径，
  或走交互式 Force 流程显式决定。
- **恢复过程本身被打断？** 再次运行 `agentcommit rollback`：已完成动作跳过、未完成
  动作继续——依据持久化 Journal。
- **状态可疑？** `agentcommit doctor` 提供只读诊断；`doctor --report` 生成本地脱敏
  报告。

## AgentCommit 不做什么

- `agentcommit commit` **不是** `git commit`，绝不触碰 Git 历史、索引、引用或推送。
- 回退只恢复该 Session 中受保护路径的**工作区文件内容**；不撤销邮件、付款、部署、
  API 调用等任何外部世界动作。
- 只有 Protection Summary 里显示为受保护的路径可恢复；存在不可恢复路径时，"完全
  可逆"不成立。
- 不做写入者归因：无法区分同一窗口内是 Agent 还是你的编辑器写入；不保证捕获后台
  进程在运行结束后的写入。
- 不是原子文件系统快照，也不是整工作区事务。
- 已接受（commit）的 Session 不会被后续 Session 的回退波及。
- CAS 本地明文存储——是安全网，不是加密保险箱。

## 支持矩阵

当前发布候选（`0.1.0-alpha.1`）已验证：GitHub Actions CI 三平台矩阵
（ubuntu-latest / windows-latest / macos-latest × Node 22/24）6/6 全绿；另含
20 个真实 Agent dogfood 会话——18 个 Z Code（Windows，GLM）、2 个 Codex
（Windows，ChatGPT plan），覆盖 commit、rollback、single-path restore、冲突拒绝、
真实 Ctrl+C 中断与中断恢复续作。

| 能力 | 状态 |
| --- | --- |
| Windows（原生），Node 22/24 | **已验证** — 完整本机套件 + Windows GitHub-hosted CI（windows-latest） |
| Linux (x64)，Node 22/24 | **已验证** — CI 矩阵（ubuntu-latest） |
| macOS，Node 22/24 | **已验证** — CI 矩阵（macos-latest） |
| Z Code（真实 Agent） | **已验证** — 18 个真实会话 |
| Codex（真实 Agent） | **已验证** — 2 个真实会话 |
| 通用 synthetic Agent | **已验证** — 自动化套件使用 |
| Claude Code / DeepSeek 等其他 adapter | **adapter 已实现；仅 synthetic 验证** — 尚无真实 Agent 运行 |
| POSIX 普通文件 rwx 恢复 | **支持，CI 已验证** — rwx 位扫描捕获、rollback 恢复并校验；识别 mode-only 变化与计划后 chmod 漂移。边界：特殊位、属主、xattr、ADS、mtime 不在范围内 |
| 符号链接 / junction | Windows junction 已在套件验证；POSIX symlink 恢复由 CI 验证 |

## 反馈与安全

Alpha 阶段，反馈按性质分渠道：

- **普通恢复异常、非敏感内容的疑似数据丢失** → **Recovery Incident** 公开
  Issue 表单（仅元数据——不要附工作区内容、凭证、完整 state 目录或敏感日志）。
- **安全漏洞、越界写入、凭证/隐私泄露、安全边界绕过、涉及敏感业务数据的数据
  丢失** → **GitHub 私密漏洞报告**（见 [SECURITY.md](SECURITY.md)）——绝不在
  公开 Issue 提交。该渠道在公开仓库创建后即可用，且必须在 npm 发布与任何公开
  宣传之前启用。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)。
