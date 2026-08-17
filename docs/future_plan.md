# V1 - Jian：从个人远程 TUI 演变为 Agent Session Fabric

  ## 一、战略结论

  截至 2026-08-03，对当前仓库、官方产品、GitHub 竞品、HN、Reddit、GitHub issues 和邻近商业产品的综合判断是：

  > Jian 有机会成为流行开源项目和可持续商业产品，但前提是从“手机/Web 上使用 Codex、Hermes TUI”升级为“自托管、厂商中立、跨设备与跨主机的 Agent Session
  > Fabric”。

  推荐定位：

  > Jian 让任意 CLI/ACP Agent 持续运行在你的机器上，并可从 Web、iOS、Android 安全续接、观察、审批和接管；原始 TUI 完全保真，结构化体验渐进增强。

  核心判断：

  - “移动端远程控制单一 Agent”已经成为市场准入能力，而非差异化能力。OpenAI 已把线程、审批、终端输出、diff、测试和安全中继带到移动端，并披露 Codex
    每周用户超过 400 万；Anthropic 也已提供 Web/iOS/Android、多会话、worktree、推送和 server mode。OpenAI Codex Anywhere
    (https://openai.com/index/work-with-codex-from-anywhere/)、Claude Remote Control (https://code.claude.com/docs/en/remote-control)

  - 真正未被完全解决的是：跨 Agent、跨主机、Linux/headless、私有网络、自定义模型网关、可验证的断线恢复、统一审批收件箱和团队治理。
  - Jian 最可能形成的护城河不是 UI 数量，而是会话正确性、安全可信度、Agent Driver 生态和长期积累的兼容性测试。
  - “流行开源”与“商业成功”必须分开衡量。Vibe Kanban (https://www.vibekanban.com/blog/shutdown)
    即使每天有数千名工程师使用，仍因绝大多数是免费用户且找不到满意商业模式而关闭公司。

   发展路径                        可能性                判断
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   成为有影响力的 OSS              中等，可提升至中高    需要抢占“exact-TUI、vendor-neutral、session-correct”心智
  ──────────────────────────────  ────────────────────  ──────────────────────────────────────────────────────────
   个人原生 App/终端订阅           低到中                官方免费能力和 SSH+tmux 构成强价格上限
  ──────────────────────────────  ────────────────────  ──────────────────────────────────────────────────────────
   付费零知识中继与推送            中等                  有真实便利价值，但必须低价、可信、稳定
  ──────────────────────────────  ────────────────────  ──────────────────────────────────────────────────────────
   SMB/企业控制平面                中长期较高            SSO、策略、审计、设备信任和审批治理才是强付费点
  ──────────────────────────────  ────────────────────  ──────────────────────────────────────────────────────────
   仅靠远程终端成为大型 SaaS       低                    功能容易商品化，且安全、支持成本很高
  ──────────────────────────────  ────────────────────  ──────────────────────────────────────────────────────────
   OSS 核心加托管服务的独立公司    可行                  是最现实的商业目标

  ## 二、市场与竞品结论

  ### 竞品格局

  截至调研日，GitHub 星数会持续波动：

  - 官方垂直产品：Codex Remote、Claude Remote、Hermes Dashboard、OpenCode Web/Attach
    (https://github.com/anomalyco/opencode)。它们会持续吸收各自生态中的远程与移动能力。

  - 直接跨 Agent 竞品：Happy (https://github.com/slopus/happy) 约 23.1k★、Paseo (https://github.com/getpaseo/paseo) 约 11.9k★、Omnigent
    (https://github.com/omnigent-ai/omnigent) 约 8.1k★、CloudCLI (https://github.com/siteboon/claudecodeui) 约 13k★，此外还有
    HAPI、Happier、VibeTunnel、MobileCLI、yepanywhere。

  - 通用终端基线：ttyd (https://github.com/tsl0922/ttyd)、tmux、Mosh、Tailscale、Termius 已经解决“能连上终端”；原始 Web Terminal 本身接近商品。
  - 上层开发平台：code-server、OpenHands、Coder、Daytona、E2B 已占据浏览器 IDE、Agent 平台和沙箱基础设施，不宜正面复制。
  - 协议层：Agent Client Protocol (https://github.com/agentclientprotocol/agent-client-protocol) 已开始标准化客户端与 Agent 的交互。Jian 应兼容
    ACP，但仍需自己的远程会话、持久化和多设备协议。

  最直接的 benchmark 是 Paseo：它已经覆盖多 Agent、daemon-owned sessions、iOS/Android/Web、E2EE relay 和语音。Jian 要胜出，必须比它更专注于：

  1. 原始 CLI TUI 随时可用且行为一致。
  2. 会话身份、重连、审批和多端接管绝不混乱。
  3. 更小、更容易审计的 Go 节点和安全默认配置。
  4. Linux/headless、内网、air-gapped、自定义模型网关等官方产品覆盖较弱的场景。

  ### 用户真实需求

  Reddit、HN 和 GitHub issues 给出的证据一致，但应视为定性信号而非 TAM：

  - 用户已经用 tmux + SSH/Tailscale/Termius 拼装远程工作流；他们缺少的是状态、权限边界和移动友好的 checkpoint 界面。Codex Linux 手机遥控讨论
    (https://www.reddit.com/r/codex/comments/1uw6p75/question_is_there_a_way_to_remote_control_codex/)

  - 官方远程能力仍出现失联、重连后会话不一致、手机看不到活跃会话等问题；用户明确区分“连接已解决”和“连续性仍未解决”。Claude 长会话可靠性讨论
    (https://www.reddit.com/r/ClaudeCode/comments/1rphlyl/how_do_you_maintain_reliable_remote_access_to/)

  - 高频移动动作不是完整写代码，而是查看状态、回答问题、批准、看 diff、纠偏、暂停和补充 prompt。
  - 多 Agent 用户开始同时运行十几个甚至几十个会话，最需要的是统一的“谁在运行、谁在等待我、谁失败了”视图。
  - Anthropic Remote Control 会将 transcript 和工具活动存储在其服务端，ZDR 组织、自定义 API endpoint、API key 等场景受限，这为自托管和企业 BYOC
    留下空间。Claude Remote Control 安全与限制 (https://code.claude.com/docs/en/remote-control)

  因此，移动端默认首页应是 Agent Attention Inbox，完整 TUI 是“一键打开的全能力逃生舱”，而不是手机首屏。

  ## 三、产品与技术演进

  ### 当前基础与必须补齐的事实

  当前项目已经是可信的个人 MVP：

  - internal/runtime/pty.go:16 确实由服务器持有进程，浏览器只是可丢弃订阅者，并有 1 MiB 内存回放。
  - Catalog 已能合并本地、Codex 和 Hermes 原生会话；Codex app-server 与 Hermes ACP 为结构化能力奠定了基础。
  - PWA 已具备 xterm.js、移动键盘、IME、安全区和离线应用壳。
  - 当前 Go 测试、race、vet 和前端静态检查均通过。

  但现在“无中断”只能承诺：浏览器刷新或短暂断开、且 Jian 服务与 PTY 仍存活时可恢复。尚不包括：

  - 慢客户端导致的静默事件丢失、服务重启、主机重启或 Agent 崩溃。
  - internal/httpapi/server.go:669 中存在订阅未释放问题。
  - frontend/src/features/terminal/mountTerminal.ts:73 没有自动重连、退避、cursor 或缺口检测。
  - 多端同时输入和 resize 没有控制权语义。
  - internal/cli/cli.go:15 的 0.0.0.0、默认密码和非 Secure Cookie 不适合公开发布。
  - 没有版本化 API、设备凭证、推送、原生客户端 SDK、CI、LICENSE、SECURITY.md。没有 LICENSE 时，公开仓库法律上并不等于开源。GitHub licensing 指南
    (https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

  ### 目标架构与公共接口

  1. Terminal/Session Supervisor
      - 由独立于 HTTP/UI 的 session worker 持有 PTY；API 进程升级或重启不终止任务。
      - 输出写入有界持久 journal，每帧有单调 cursor；客户端携带 cursor 重连，服务端返回连续 replay 或明确的 gap/truncated 事件，绝不静默丢失。
      - 主机重启后不虚假承诺“同一进程复活”：保留日志和状态，标记为 interrupted，再通过原生 Agent session resume 恢复对话。

  2. 多端控制语义
      - 默认一个 writer lease，同时允许多个只读观察者。
      - writer 拥有输入和 PTY resize；观察者只做本地缩放/滚动。
      - 接管必须显式完成，展示当前控制设备；未来 co-drive 使用服务器排序和输入审计，不允许字节任意交错。

  3. 双平面 Agent Driver
      - 每个 Driver 必须实现原始 PTY 的 discover/create/resume/start/stop。
      - 通过 capability manifest 声明可选的 structured events、approval、question、diff、usage、artifact、rename 和 native identity。
      - Codex 使用 app-server，Hermes 使用 ACP/gateway；下一批 Driver 固定为 Claude Code 和 OpenCode，之后开放 Gemini CLI/Aider 社区适配。
      - 结构化信息只能来自官方协议、ACP、SDK 或 hooks；禁止把 ANSI 解析作为审批和状态的唯一事实源。

  4. 版本化跨端协议
      - 固化 /api/v1、OpenAPI/schema、稳定的 SessionID、HostID、DeviceID 和 Agent native identity。
      - 会话状态统一为 starting/running/waiting-input/waiting-approval/completed/failed/interrupted/stopped。
      - 终端流、语义事件、设备认证、writer lease 和幂等 approval 都有明确版本与兼容策略。
      - 由 schema 生成 TypeScript、Swift 和 Kotlin 客户端。

  5. 两种安全部署模式
      - Personal：客户端与节点端到端加密，托管 relay 只看到必要路由元数据；设备 QR 配对、独立密钥、撤销和 outbound-only 连接。
      - Enterprise/BYOC：组织掌握密钥并可选择审计、保留和搜索。该模式不得同时宣称 zero-knowledge。
      - 默认仅监听 loopback，无默认口令，首次启动强制 bootstrap，配置 workspace allowlist；公开 relay 上线前完成独立安全审计。远程 Shell
        的安全失败是生存性风险，已有同类产品出现默认配置可串联为未认证 RCE 的案例。CVE-2026-31975 (https://github.com/advisories/GHSA-gv8f-wpm2-m5wr)

  明确不进入近期范围：

  - 不做另一个完整 Web IDE 或复杂 Kanban。
  - 不自建云算力、模型推理和多租户 Runner；先集成 Coder、Daytona、E2B、Kubernetes。
  - 不靠支持 Agent 数量制造虚假进展。
  - 不替换现有 Go 技术栈。
  - 不把服务直接暴露公网作为默认部署方式。

  ## 四、分阶段路线与商业化

  ### 阶段 0：0–6 周，先建立可信底盘

  - 修复订阅泄漏、慢消费者、自动重连、ping/pong、cursor replay 和明确缺口提示。
  - 引入 session worker、持久 journal、状态机、writer lease、只读观察者和进程组清理测试。
  - 改为安全默认配置：loopback、无默认密码、首次配对、workspace allowlist、TLS/VPN 指引。
  - 固化 /api/v1 和事件 schema。
  - 添加 Apache-2.0 LICENSE、SECURITY.md、CONTRIBUTING、CI、威胁模型、兼容矩阵、英文主 README/中文镜像、60–90 秒演示。
  - 项目描述统一为：Jian — self-hosted session fabric for AI coding agents。

  ### 阶段 1：6–12 周，OSS v1

  - 完成 capability-driven Agent Driver；保留 Codex/Hermes，并加入 Claude Code、OpenCode。
  - 发布 Attention Inbox：waiting approval/question/error/completed、去重、幂等操作、静默时段和深链。
  - 增加 session timeline、结构化 diff/test/artifact 旁路视图；任何时刻可返回原始 TUI。
  - 发布 Linux x86_64/arm64 签名二进制、checksums、SBOM 和一键安装；PWA 保持完整自托管。
  - 建立公开的 adapter SDK、兼容性测试套件和贡献者 registry。

  ### 阶段 2：3–6 个月，多主机、iOS 与托管中继

  - 增加 Jian Node catalog：主机配对、在线状态、标签、能力、跨主机搜索和接力。
  - 开发 SwiftUI iOS 客户端：Attention Inbox、结构化 prompt、语音、审批、diff、文件、终端、APNs、后台恢复和 deep link。
  - 上线可选的 outbound-only、端到端加密 relay；节点、客户端、协议和 reference relay 继续开源，商业收入来自托管可靠性、推送和设备发现。
  - 增加 macOS node/launchd 支持；Linux/headless 仍是第一优先级。
  - 加入 worktree、Git diff、测试结果和 dev-server preview，但定位为 review 旁路而非 IDE。

  ### 阶段 3：6–12 个月，团队产品与 Android

  - 开发 Kotlin Compose Android 客户端，与 iOS 使用同一协议和语义。
  - 增加组织、RBAC、OIDC/SAML、SCIM、设备信任、只读共享、批准委托、审计导出、保留与脱敏策略。
  - 增加 host fleet、资源/会话配额、Agent 成本和孤儿进程监控。
  - 支持 execution-provider 插件，连接 Coder、Daytona、E2B、Kubernetes，而非自己托管 compute。
  - 在 API 之上增加 GitHub/Slack/Telegram/Linear webhook 与审批通知。

  ### 商业模型

  - Community：Apache-2.0；节点、PWA、原生客户端、Driver SDK、协议和可自托管 reference relay 免费，不人为限制本地会话数。
  - Relay Pro 定价实验：建议从 8 美元/月或 72 美元/年测试，收费点是托管 E2EE relay、推送、设备发现、稳定域名和多主机便利，不收费于 Agent 或模型调用。
  - Team：建议从 20 美元/用户/月测试，收费点是 SSO/SCIM、RBAC、审批委托、审计、策略、fleet 和支持。
  - Enterprise：BYOC/VPC/on-prem、HA、合规、SLA 和商业支持，定制报价。
  - OEM：将 session worker、移动终端和 adapter SDK 作为嵌入式 gateway 提供支持合同，可作为次级收入。
  该模型与 Coder (https://coder.com/pricing)、Tailscale (https://tailscale.com/pricing)、Termius (https://termius.com/pricing)
  的共同规律一致：基础连接免费或低价，组织身份、同步、审计和策略才是主要商业价值。

  ## 五、验收、验证与默认决策

  ### 工程验收

  - 连续 7 天 soak test，经历浏览器刷新、Wi-Fi/蜂窝切换、设备休眠、代理切换、输出洪泛和 API 部署；PTY 继续运行且无静默输出缺口。
  - 健康网络下重连 p95 小于 2 秒；超过 journal 保留范围时必须明确展示截断。
  - 多设备测试证明只有 lease holder 能输入和 resize；接管、撤销、只读观察确定可复现。
  - stop/delete 必须终止全部后代进程，服务与 Agent 崩溃后状态不得虚假显示 running。
  - Driver contract tests 不依赖真实 Codex/Hermes 安装，并覆盖 CLI 缺失、协议降级、native identity 冲突和幂等 approval。
  - 安全测试覆盖 Origin/CSRF、路径穿越、设备撤销、默认配置、WebSocket fuzz、速率限制、参数注入和 relay 密文不可读。
  - iOS/Android 测试覆盖后台挂起、通知操作、离线队列、重复推送和 deep-link 恢复到同一 session。

  ### 产品与商业验证门槛

  - 安装到首次可用 session 小于 5 分钟。
  - OSS v1 前至少完成 25 名外部自托管用户访谈和真实安装；GitHub stars 不作为北极星指标。
  - 以周活跃节点、四周留存、每周 session 数、移动端解除阻塞次数和平均 unblock latency 衡量价值。
  - 托管 relay 开发到正式收费前，至少取得 20 次付费意愿访谈和 10 个明确预购/试付承诺。
  - 重型团队功能只在至少 5 个团队设计伙伴反复提出 SSO、审计、策略或审批委托需求后扩展。
  - 公开 relay 前完成第三方安全审计、SBOM、签名发布和漏洞披露流程。

  ### 已锁定的默认决策

  - 首批用户：自托管开发者，之后才扩展团队。
  - 产品体验：手机默认结构化 Attention Inbox，原生 TUI 始终完整保留。
  - 商业路径：免费 OSS + 可选零知识中继 + 后续团队治理。
  - 许可证：Apache-2.0，保留 Jian 商标；reference relay 同样开源。
  - 平台顺序：Linux/PWA → iOS/SwiftUI 与 macOS node → Android/Compose。
  - Agent 顺序：Codex、Hermes → Claude Code、OpenCode → Gemini CLI、Aider 和社区 Driver。
  - 不托管模型推理、不自建云算力、不在近期构建完整 IDE。
  - “无中断”被严格定义为分层承诺：客户端断线保持原 PTY；控制平面重启保持 worker；主机重启则保留 journal 并通过原生 session resume 恢复，而不是宣称原进
    程复活。

# V2 - Jian「Terminal as the Source of Truth」战略方案

  ## 一、核心判断与竞品重分类

  ### 最重要的结论

  “terminal only”不是 Jian 的局限，前提是将它定义为：

  > 一个真实 Agent 进程、一个服务器持有的 PTY、一个终端状态；Web、iOS、Android和本地终端只是不同的附着窗口。

  Jian 不应被定位成“Codex/Hermes 的 Web Terminal”，而应定位为：

  > Agent-native terminal multiplexer + secure session fabric
  > 面向 AI CLI 的远程终端连续性与安全接管基础设施。

  这里需要区分四种经常被混称为“同一会话”的能力：

  1. 相同 conversation ID。
  2. 相同 Agent thread/backend。
  3. 相同正在运行的 Agent 进程和子进程树。
  4. 相同 PTY、终端模式、光标、alternate screen 和输入状态。

  Happy、HAPI、Paseo、官方 Remote Control 大多实现前两层；Jian 应把第三、第四层做成不可妥协的产品契约。

  ### 竞品矩阵

   路线                 代表项目                          是否共享同一 Agent PTY    主要优势                          Jian 的机会
  ━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   结构化远程 UI        Happy、HAPI                                           否    手机体验、语音、审批按钮、消息    保留原生 CLI 全部能力，不切换
                                                                                    排版                              launcher
  ───────────────────  ────────────────────────────────  ────────────────────────  ────────────────────────────────  ─────────────────────────────────
   结构化 Agent 平台    Paseo、OpenCode、CloudCLI                             否    多 Agent timeline、diff、工具     避免长期维护 provider event 映
                                                                                    卡片、编排                        射
  ───────────────────  ────────────────────────────────  ────────────────────────  ────────────────────────────────  ─────────────────────────────────
   混合路线             Omnigent、Paseo terminal                            部分    同时提供原生终端和丰富页面        复杂度极高，容易出现两个事实源
                        subsystem
  ───────────────────  ────────────────────────────────  ────────────────────────  ────────────────────────────────  ─────────────────────────────────
   原生终端路线         VibeTunnel、MobileCLI、Hermes                         是    原始 TUI 保真、任意 CLI 可用      这是 Jian 真正的直接竞争区
                        Dashboard
  ───────────────────  ────────────────────────────────  ────────────────────────  ────────────────────────────────  ─────────────────────────────────
   基础替代方案         tmux/Zellij + Tailscale/SSH、                         是    免费、稳定、用户熟悉              用 Agent catalog、移动体验和低
                        zmx、ttyd                                                                                     配置门槛胜出

  关键竞品结论：

  - Happy (https://github.com/slopus/happy) 本地模式运行原生 Claude CLI，但手机接管时会进入另一套 remote/SDK 运行路径；Codex 则主要依赖 app-server
    和结构化渲染。其 session resume 同步问题 (https://github.com/slopus/happy/issues/875) 说明“逻辑上同一会话”仍可能产生状态分叉。

  - HAPI 的架构文档 (https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md) 将体验分为 local/remote mode；运行循环源码
    (https://github.com/tiann/hapi/blob/main/cli/src/agent/loopBase.ts) 也明确在不同 launcher 间切换。它保留上下文，但不是手机直接接管原 PTY。

  - Paseo (https://github.com/getpaseo/paseo) 的 Agent 主界面由 Claude SDK、Codex app-server、ACP 等驱动；它同时拥有成熟的独立终端子系统
    (https://github.com/getpaseo/paseo/blob/main/packages/server/src/terminal/terminal-session-controller.ts)，包括 headless terminal
    snapshot。这证明终端能力本身很重要，也证明结构化 Agent 与终端双轨维护成本很高。

  - Omnigent (https://github.com/omnigent-ai/omnigent) 是最强的混合竞品：native harness 运行真实 TUI，同时通过 transcript、hook 和 provider-specific
    forwarder 镜像结构化页面。其 Hermes forwarder (https://github.com/omnigent-ai/omnigent/blob/main/omnigent/hermes_native_forwarder.py)
    展示了双事实源需要承担的同步、去重、完成状态推断和版本兼容成本。

  - VibeTunnel (https://github.com/amantus-ai/vibetunnel) 已覆盖 PTY、Web/iOS、录制、移动键盘和多主机，是 Jian 的成熟直接竞品。
  - MobileCLI (https://github.com/MobileCLI/mobilecli) 与 Jian 的理念最接近：Rust daemon 持有 PTY/tmux，手机运行
    xterm.js，并提供推送、配对和文件操作。它依赖 ANSI/pattern matching 推断 Agent 等待状态，这恰好给 Jian
    留下“严格区分终端事实与启发式信息”的差异化空间。

  - Hermes Web Dashboard (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-dashboard.md) 已能远程显示
    Hermes 原 TUI，因此 Jian 对单个 Hermes 的价值有限；真正价值必须来自跨 Agent、跨主机、统一 catalog 和统一安全入口。

  - Reddit 用户反馈同时验证了需求和天花板：用户广泛使用 tmux+Tailscale，但抱怨移动网络切换、手机键盘和触控体验；结构化 Remote Control 则出现 slash
    command、停止操作和会话切换不完整的问题。Claude Remote Control 讨论
    (https://www.reddit.com/r/ClaudeAI/comments/1rdr9pn/claude_code_just_got_remote_control/)、移动终端讨论
    (https://www.reddit.com/r/ClaudeAI/comments/1qusdwg/claude_code_terminal_on_the_phone/)。

  ## 二、潜在价值、护城河与商业上限

  ### 可以形成长期价值的部分

  1. 零日兼容新 Agent 和新版本

     新的 slash command、模型选择器、插件、权限窗口、子 Agent、主题和私有扩展由原生 TUI 自动呈现，不需要 Jian 更新事件模型。

  2. 真正的物理连续性

     远端接管时 PID、子进程、cwd、环境变量、正在执行的工具、TUI modal 和未提交输入全部不变。这比“恢复同一个 conversation ID”更强。

  3. 清晰的责任边界

     Jian 只对进程生命周期、字节顺序、重连、终端状态和安全访问负责；Agent 厂商继续负责 UI、权限语义和工作流。

  4. 私有与长尾 Agent

     内部 CLI、无 ACP 的工具、代理模型、air-gapped 环境和未来尚未发布协议的 Agent 都能运行。

  5. 跨 Agent 的统一入口

     VibeTunnel 更像通用远程终端；Jian 可以知道终端对应 Codex thread、Hermes profile、workspace 和 native session identity，并执行正确的 discover/
     create/resume。

  6. 可验证的原始审计记录

     PTY journal 是用户真正看到和输入的内容，可用于回放、搜索、故障复现、会话分享和团队审计。

  ### 必须承认的天花板

  - 手机上的 TUI 更适合监控、补充提示和解除阻塞，不适合长时间复杂编辑。
  - PTY 字节本身无法安全、稳定地理解“批准什么”“风险是什么”“turn 是否完成”。
  - 多设备同时连接会产生输入冲突和终端尺寸争夺。
  - 免费的 tmux/Zellij、Tailscale、SSH 和 ttyd 会压低个人订阅价格。
  - 如果产品最终只是“一个更漂亮的 xterm.js”，VibeTunnel 和 MobileCLI 已经足以替代。
  - 纯个人 terminal 工具难以形成很高客单价；商业天花板必须由 relay、设备安全、团队共享、fleet 和 OEM 扩展。

  ### 商业潜力判断

   方向                               潜力      原因
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   流行开源项目                       中高      定位清晰、Agent 适配成本低、self-host/Linux 用户需求真实
  ─────────────────────────────────  ────────  ──────────────────────────────────────────────────────────────────
   个人订阅                           中低      免费替代多，适合为 relay、push、原生客户端付小额费用
  ─────────────────────────────────  ────────  ──────────────────────────────────────────────────────────────────
   可持续独立商业项目                 高        维护面小，可通过托管服务和 Pro 客户端持续运营
  ─────────────────────────────────  ────────  ──────────────────────────────────────────────────────────────────
   团队产品                           中高      writer handoff、只读分享、录制、设备信任和审计有付费价值
  ─────────────────────────────────  ────────  ──────────────────────────────────────────────────────────────────
   大型企业                           中        需要补齐 SSO、RBAC、fleet、合规和 SLA，并面对 Teleport/ShellHub
  ─────────────────────────────────  ────────  ──────────────────────────────────────────────────────────────────
   纯 terminal-only 的大型平台公司    低至中    必须扩展到多主机安全访问或 white-label terminal gateway 才能放大

  推荐收费面：

  - 托管零知识/E2EE relay、push、稳定域名和设备发现。
  - iOS/Android Pro 客户端。
  - 团队 session sharing、writer handoff、录制与保留策略。
  - SSO、设备信任、fleet、BYOC 和审计。
  - 面向 Agent/CLI 厂商的 white-label remote TUI gateway。

  不建议依赖模型差价、Agent compute 托管或重做结构化编排来商业化。

  ## 三、产品边界与成长路线

  ### 不可动摇的产品边界

  “terminal-only”应表示终端是唯一交互数据面，而不是整个产品只能有一块黑色屏幕。

  允许增加：

  - session catalog、workspace、Agent kind、进程与退出状态；
  - 多主机目录、设备在线状态和 presence；
  - view-only、writer lease、临时分享；
  - BEL、OSC、exit code、显式 hook 产生的等待/完成通知；
  - voice-to-paste、快捷键栏、剪贴板、文件上传后粘贴路径；
  - 录制、回放、全文搜索；
  - ACP/app-server 用于 discovery 或旁路 telemetry。

  明确不做：

  - 重新渲染 Agent 对话、tool card、diff、model picker 和 approval 页面；
  - 维护第二份 conversation history；
  - 根据 ANSI 文本执行安全敏感的一键批准；
  - 手机和桌面分别运行两个 launcher，再将其称为同一终端；
  - 让 ACP/app-server 成为 Agent 交互的主数据面。

  等待通知只应跳转到原终端；审批仍在原生 TUI 内完成。

  ### Phase 0：把“同一终端”做成可验证的契约

  当前实现方向正确：服务端持有 PTY、浏览器只是订阅者，internal/runtime/pty.go:18。但现在仍是 1 MiB 尾部缓冲、慢订阅者静默丢帧，internal/runtime/
  pty.go:112；前端连接失败后没有自动恢复，frontend/src/features/terminal/mountTerminal.ts:73。

  第一阶段应完成：

  - 将 PTY supervisor 与 HTTP/UI 进程生命周期分离，服务升级不终止 Agent。
  - 使用 snapshot + ordered journal + sequence cursor 恢复 alternate screen、光标、终端模式和标题。
  - 禁止静默丢帧；客户端落后时发送明确 gap 并重新获取 snapshot。
  - 建立单 writer lease；其他设备默认只读，必须显式接管输入权。
  - writer 同时成为 resize owner，避免手机和桌面反复改变 PTY geometry。
  - 提供本地 jian attach，让本机终端、Web 和移动端也确实附着同一个 PTY。
  - 发布开源的 Terminal Continuity Test Suite，覆盖所有终端正确性场景。

  ### Phase 1：Agent-aware，但保持 protocol-independent

  引入声明式 AgentTerminalProfile：

  - id/name/icon
  - executable 与 create/resume argv
  - workspace 规则
  - native session discovery 与 identity
  - 环境变量白名单
  - 可选显式 hook/OSC 通知方式

  社区新增 Agent 应主要提交 profile、discovery fixture 和兼容测试，而不是编写新 UI。

  支持：

  - jian run -- <command> 任意 TUI。
  - jian codex、jian hermes --profile ... 等快捷入口。
  - attach/import tmux、Zellij、zmx 会话。
  - Codex/Hermes/OpenCode/Claude 等显式 hook 发送 needs-input/idle/done。
  - 通知标记来源：explicit-hook、osc、process、heuristic；只有前三者可作为可信状态，heuristic 默认关闭。

  ### Phase 2：移动端与跨主机

  - iOS App 仍是原生终端客户端，不演变成聊天气泡页面。
  - 优先完善软键盘工具栏、组合键、可配置宏、voice-to-paste、缩放和平移。
  - 实现 per-device credential、二维码配对、撤销、只读模式和接管确认。
  - 建立 outbound-only E2EE relay；中继只看到加密帧和最小路由元数据。
  - 多 Jian node 聚合成统一 session catalog。
  - 推送只携带最小元数据，点击后直接恢复对应终端。
  - Android 复用相同 attach protocol，平台侧使用各自安全存储与后台机制。

  ### Phase 3：团队与商业化

  - 团队空间、短期访问授权、view-only share。
  - writer handoff 和多人 presence。
  - terminal recording、检索、导出与保留策略。
  - 底层支持 debugger、数据库 console、k9s、nvim 等任意 TUI，但公开营销继续聚焦 AI Agent，避免退化成泛 WebSSH。

  ## 四、公开接口、验收标准与默认假设

  ### 核心公开接口

  - TerminalSession：稳定 Jian ID、node、workspace、PTY worker、Agent profile、native identity、生命周期。
  - AttachProtocol：snapshot、output(seq)、gap、exit、input、resize、ack。
  - WriterLease：唯一 writer、resize owner、租约过期、显式 handoff。
  - AgentTerminalProfile：仅负责发现、启动、恢复和环境，不描述消息或工具 schema。
  - AttentionSignal：session_id/type/source/confidence/timestamp，永远不是第二份 Agent 状态。
  - DeviceIdentity：配对、权限、撤销、最后在线与节点访问范围。

  ### 必须通过的测试

  - Web 刷新、iOS 后台恢复、Wi‑Fi/蜂窝切换后仍是同一 PID、进程树和 PTY。
  - alternate screen、光标、鼠标模式、Unicode/中日韩宽字符、IME、OSC 和 resize 恢复一致。
  - 大量输出、慢客户端和长期离线不存在静默丢失；超出保留范围必须显式报告 gap。
  - 两台设备同时连接时只有 lease owner 能输入和 resize。
  - Jian 服务升级后 Agent 不退出，客户端可重新发现并 attach。
  - Codex/Hermes 升级并增加新 TUI 功能时，无 Jian adapter 更新也能正常使用。
  - hook/OSC 失效只影响通知，不影响终端正确性。
  - 非可信 heuristic 不能触发批准、输入或其他高风险操作。
  - 配对撤销、origin/auth、重放攻击、临时分享过期和只读隔离均有集成测试。
  - 安装到手机首次接管控制在五分钟内，作为开源采用的发布门槛。

  ### 默认假设

  - 首批用户是 self-host、terminal-native、多 Agent 开发者。
  - “terminal-only”表示原 PTY 是唯一交互事实源；catalog、通知、录制、设备管理属于允许的外围控制面。
  - ACP/app-server 可以继续用于发现和 metadata，但不用于重新绘制 Agent 主界面。
  - iOS/Android 主要服务“观察、解除阻塞、补充输入和短时操作”，不以替代桌面 IDE 为目标。
  - 近期最重要的 benchmark 是 VibeTunnel、MobileCLI 和 tmux/Zellij，而不是 Happy/Paseo 的功能数量。
  - 最现实的终局是一个高口碑开源项目加可持续商业服务；若追求更大商业规模，应向安全多主机 session fabric、团队治理和 OEM gateway 扩展，而不是放弃
    terminal 核心去复制结构化 Agent UI。