• 结论：以你当前的前提——主要动机是技术战略、维护者更熟悉 Go、Jian 继续是本机单用户工具——我不建议现在把后端整体改写为 Rust。

  Rust 可以让 Jian 的进程与并发模型更严谨，但不会带来明显的用户体验或性能提升。短中期内，重写反而更可能降低可靠性和开发速度。只有当“未来项目统一采用
  Rust、并愿意支付学习和重写成本”本身就是明确战略目标时，这次替换才成立；那是一项能力投资，不是 Jian 当前的技术刚需。

  ## Jian 实际上是什么负载

  当前后端约 3,111 行非测试 Go 代码。复杂度并不在 HTTP，而在：

  - PTY、Bash 进程组、子进程终止和终端输出重放：internal/runtime/pty.go:18
  - 每个 Hermes profile 一个长驻 ACP 进程，并发关联 JSON-RPC 请求与通知：internal/runtime/hermes.go:23
  - Codex app-server 与交互式 TUI 两套进程模型：internal/runtime/codex.go:21
  - 本地记录、Codex 原生 thread、Hermes profile/native ID 的合并规则：internal/httpapi/catalog.go:16
  - Cookie 认证、WebSocket、断线重连及 1 MiB 输出缓冲。

  这是“低吞吐、高状态、强生命周期语义”的控制平面。CPU 和内存大头通常是 Codex/Hermes 子进程，而不是 Jian 本身，因此 Rust 最擅长的高吞吐、低延迟、无 GC 优
  势在这里很难兑现。

  ## Rust 的真实优势

  ### 1. 并发状态会更容易被类型系统约束

  现在 PTY 会话用 done、closed、文件句柄、进程句柄、订阅者集合共同表达生命周期。Hermes 也有 pending、loaded、closed 等互相关联的状态。

  Rust 可以把某些非法状态变得更难表达，例如避免资源被并发错误持有、关闭后继续使用、跨线程移动非线程安全对象。Safe Rust
  可以防止数据竞争，但官方文档也明确指出，它不能防止一般性的逻辑竞态。Rust Nomicon (https://doc.rust-lang.org/beta/nomicon/races.html)

  所以 Rust 能减少“忘记加锁、错误共享所有权”一类问题，但不能自动解决：

  - ACP 超时后请求仍残留在 pending 中。
  - Hermes 子进程退出后 profile map 仍可能返回旧对象。
  - 慢订阅者因为容量 128 的非阻塞 channel 而静默丢事件。
  - 更换 adapter 时，仍在执行的请求如何处理旧 adapter。
  - 进程退出、重连和状态落库之间的顺序一致性。

  这些仍然需要明确的状态机和测试。

  ### 2. 协议类型可以表达得更精确

  当前大量使用 map[string]any、json.RawMessage、字符串事件名和任意 Payload。Rust 的 enum、Serde tagged enum 和穷尽匹配更适合表达 WebSocket/ACP 消息，能
  把一部分协议错误提前到编译期。

  但 ACP 通知本身具有扩展性。过度强类型化也可能导致 Codex/Hermes 增加字段或新通知时更容易拒绝消息。这里的收益取决于协议建模质量，而不只是语言。

  ### 3. 资源占用可能更稳定

  Rust 没有 GC，空闲内存和尾延迟通常更可预测。当前 Go 二进制约 31.1 MB，但其中还嵌入了前端；Rust 二进制究竟更小还是更大取决于 framework、优化和链接方
  式，不能仅凭语言断定。

  对本机单用户 Jian，这类差异大概率不可感知：终端字节转发、JSON 处理和少量 BoltDB 操作都不是主要瓶颈。

  ### 4. Rust Web 生态足够完成任务

  HTTP/WebSocket 不是障碍。Axum 已原生支持 WebSocket 及读写拆分。Axum WebSocket 文档 (https://docs.rs/axum/latest/axum/extract/ws/)

  PTY 也有 portable-pty 等库。portable-pty 文档 (https://docs.rs/crate/portable-pty/latest)

  不过“有库”不等于现有语义可以直接复制。Jian 依赖的是 Linux session/process-group、PTY resize、杀死整组后代进程、Bash 作为组长等具体行为。Rust 最终仍可
  能落到 nix/libc 和明确的 Unix 生命周期处理上；这部分不会比 Go 更简单。

  ## Rust 的主要劣势和风险

  ### 1. 当前维护能力与语言选择不匹配

  你目前主要熟悉 Go。对普通 CRUD，这只是学习成本；对 Jian 的 async、PTY、长驻子进程和取消语义，它会直接转化为可靠性风险。

  Rust 编译器能挡住一类错误，但复杂 async 系统常见的问题会转变为：

  - Arc<Mutex<...>> 和 async lock 的使用边界。
  - blocking PTY/数据库操作与 Tokio runtime 的配合。
  - task 取消不等于子进程退出。
  - Drop 不能承担需要等待的异步清理。
  - channel 关闭、backpressure 和 task 泄漏语义。

  Go 的 goroutine、channel、os/exec 与当前问题形状更自然，团队也更容易审查。

  ### 2. 前端不变意味着兼容面远大于几个 HTTP 路由

  必须保持的不只是 URL 和 JSON 字段，还包括：

  - Cookie、状态码和错误结构。
  - WebSocket 输入消息格式。
  - pty.output、pty.exit、session.started 等事件名称和顺序。
  - 首次连接与重连时缓冲输出的语义。
  - 浏览器断开后进程继续运行。
  - 原生会话、本地会话和 profile-specific Hermes 身份规则。
  - Codex 新会话尚无 native ID 时的合并启发式规则。

  这些行为没有一份独立协议规范，目前主要编码在 internal/httpapi/server.go:39 和实现细节里。重写时很容易得到“接口看起来一样、边缘行为不一样”的系统。

  ### 3. 测试不足以保护全量重写

  现有检查全部通过，包括 go test -race ./...、go vet、前端构建和布局检查。但覆盖率是：

  - internal/httpapi：18.9%
  - internal/runtime：26.3%
  - internal/auth：41.9%
  - internal/store：37.5%

  尤其缺少 WebSocket 端到端、并发关闭、慢客户端、ACP 崩溃恢复、服务重启、进程组后代清理等测试。

  因此重写最大的风险不是“Rust 写不出来”，而是无法确定哪些细节必须等价。Rust 的编译安全不能替代行为兼容测试。

  ### 4. BoltDB 是明显的兼容风险

  当前数据库使用 bbolt，文件位置和格式已经是部署契约：internal/store/store.go:18。

  Rust 有 redb、jammdb 等嵌入式数据库。jammdb 文档称其起源于 BoltDB 的 Rust port，但没有承诺与当前 bbolt
  文件逐字节兼容；因此不能把它视为可靠的原地替换。jammdb 文档 (https://docs.rs/jammdb/latest/jammdb/)

  数据库中的值是 JSON，逻辑数据容易转换，但外层 Bolt 文件、bucket、权限、升级失败后的回滚仍会增加风险。对这个小型项目，存储迁移成本可能比重写 store 实现
  本身还大。

  ### 5. Rust 不会显著提高当前安全上限

  Go 和 Safe Rust 都能避免绝大多数传统内存破坏。Jian 更现实的安全风险是：

  - WebSocket origin 与 Cookie 校验。
  - 文件系统浏览和 workspace 路径。
  - 外部 CLI 输出及协议解析。
  - 命令参数和环境变量。
  - 权限请求默认策略。
  - 是否完整终止子进程树。

  这些主要是认证、验证和生命周期逻辑问题。Rust可以帮助把验证结果封装成类型，但不会自动修复安全策略。

  ## 从模块设计看

  现有 Go 代码已经有几个有价值的深模块：

  - runtime.Adapter 用很小的 interface 隔离 agent 能力：internal/runtime/runtime.go:11
  - Catalog 将昂贵的原生发现隐藏在内存快照之后。
  - Store 将 BoltDB 操作集中在一个较小的模块里。

  主要结构问题是近千行的 HTTP server 对具体 Codex/Hermes adapter 有较多类型断言和特殊分支。换 Rust 不会天然加深这些模块；逐行翻译甚至会保留同样的耦合，
  只是用更复杂的 async 类型表达出来。语言替换和架构改善是两件独立的事。

  ## 综合判断

   维度                  改成 Rust 的净效果
  ━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   用户可感知性能        基本无收益
  ────────────────────  ────────────────────────────────
   内存与尾延迟          小幅潜在收益
  ────────────────────  ────────────────────────────────
   数据竞争防护          中等收益
  ────────────────────  ────────────────────────────────
   进程生命周期正确性    有潜力，但不自动成立
  ────────────────────  ────────────────────────────────
   安全性                小幅收益，逻辑风险仍占主导
  ────────────────────  ────────────────────────────────
   短期可靠性            明显下降
  ────────────────────  ────────────────────────────────
   开发与调试速度        明显下降
  ────────────────────  ────────────────────────────────
   存储兼容性            明显风险
  ────────────────────  ────────────────────────────────
   长期技术战略          只有在持续投入 Rust 时才有收益

  还有一个特殊因素：仓库目前只有 16 个提交，历史不到一周。若最终一定要转 Rust，现在确实比一年后成本低；但需求和行为仍高速变化，此时重写也最容易把尚未稳
  定的设计和 bug 一起复制过去。

  最终建议是：继续使用 Go 更符合 Jian 当前的产品形态和维护能力。若选择 Rust，应明确把它定义为“建立长期 Rust 能力的战略投入”，接受短期功能停滞和更高回归
  风险；不要把理由包装成性能优化或必然的可靠性提升。

