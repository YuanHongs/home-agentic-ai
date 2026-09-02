# home-agentic-ai 使用说明书

把小爱音箱的"大脑"换成自己订阅的大模型：

```
你对音箱说话 → 小爱 ASR 转文字 → 本服务轮询捕获 → 触发词命中
  → 你的 LLM（Function Calling）理解意图 → 小米云 MIoT 控制设备 → 小爱 TTS 播报结果
```

- 设计文档：`docs/superpowers/specs/2026-09-01-xiaomi-speaker-custom-llm-design.md`
- 无需刷机、无需改硬件，全部逻辑跑在你家一台常开设备上

---

## 1. 你需要准备什么

| 项目 | 说明 |
|---|---|
| Node.js **≥ 20.6** | `node -v` 确认；Mac 上建议 `nvm use 24`（`--env-file` 需要 20.6+，Node 18 不支持） |
| 小米账号 | 与米家 App 同一账号，音箱和设备都已绑定 |
| 大模型 API Key | 任意 OpenAI 兼容端点：GLM / DeepSeek / Kimi / Qwen 等 |
| AI 入口音箱 | 默认按**小爱音箱 Art (L09A)** 配置；mini (LX01) 改 `TTS_COMMAND=5,1`、`WAKEUP_COMMAND=5,2` |

常用大模型配置参考：

| 服务商 | LLM_BASE_URL | LLM_MODEL 示例 |
|---|---|---|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

## 2. 获取 MI_USER_ID 和 MI_DID

1. 浏览器登录 <https://iot.mi.com>（与米家同账号）
2. F12 打开控制台 → Network 标签 → 刷新页面
3. 找 `device_list` 请求，响应里找你的音箱条目：`did` 字段即 `MI_DID`
4. `MI_USER_ID` 是**数字小米 ID**（不是手机号！），在 <https://account.xiaomi.com> 个人信息页查看

## 3. 安装与启动

```bash
npm install
cp .env.example .env    # 然后编辑 .env 填入配置
npm run dev             # 开发模式（改代码自动重启）
# 或 npm start          # 常驻运行
```

启动成功的标志：

```
[app] 配置加载完成，正在登录小米云...
[app] 小米云登录成功
[app] 服务已启动：触发词 [请、小智]
```

> 常驻部署建议配进程管理器（`systemd` `Restart=always` 或 Docker `restart: unless-stopped`）。服务遇到无法自愈的故障（如长期断网）会主动退出，靠管理器拉起。

## 4. 日常使用

### 怎么说话

以**触发词开头**才会进入你的大模型（其余指令走小爱原生，不受影响）：

| 你说 | 效果 |
|---|---|
| "小爱同学，**请**讲个笑话" | LLM 生成回答并播报 |
| "小爱同学，**请**打开台灯" | LLM 调用工具真实控制设备 |
| "小爱同学，**请**我要睡了" | LLM 组合关灯/关空调等模糊意图 |
| "小爱同学，打开客厅灯" | 不带触发词 → 走小爱原生，与本项目无关 |

- 默认触发词：`请`、`小智`，可用 `TRIGGER_WORDS` 修改（逗号分隔）
- `TRIGGER_WORDS=`（留空）= 全接管实验模式：所有对话都进 LLM

### 支持的设备控制能力

LLM 能看到你家全部米家设备及其"能力"（开关/亮度/色温/目标温度等），自动组合调用。说"有点冷"它会调空调，说"看电影模式"它会关灯——能理解到什么程度取决于你订阅的模型。

### 体验上的已知特性

- 说完话到开始回答有 1~2 秒延迟（轮询机制固有）
- 小爱原生应答偶尔"漏"出半句才被打断
- 连续下多条指令时，后一条会等前一条播报完再处理

## 5. 配置参考（.env）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MI_USER_ID` | ✅ | — | 数字小米 ID（不是手机号） |
| `MI_PASSWORD` | ✅ | — | 小米账号密码 |
| `MI_DID` | ✅ | — | AI 入口音箱的设备 ID |
| `TTS_COMMAND` | | `3,1` | L09A 的播报指令；LX01 改 `5,1` |
| `WAKEUP_COMMAND` | | `3,2` | L09A 的唤醒指令；LX01 改 `5,2` |
| `POLL_INTERVAL_MS` | | `1000` | 轮询间隔，**最低 500**（过快会打爆小米云） |
| `TRIGGER_WORDS` | | `请,小智` | 触发词；留空 = 全接管 |
| `LLM_BASE_URL` | ✅ | — | OpenAI 兼容端点 |
| `LLM_API_KEY` | ✅ | — | API Key |
| `LLM_MODEL` | ✅ | — | 模型名 |
| `LLM_TIMEOUT_MS` | | `30000` | LLM 超时 |
| `DEVICE_REFRESH_MS` | | `30000` | 设备列表刷新间隔 |

## 6. 看日志排障

关键日志行含义：

| 日志 | 含义 |
|---|---|
| `🔥 请开灯` | 触发词命中，正在交给 LLM 处理 |
| `[agent] 回复完成，工具轮数: 1` | LLM 走完（含工具调用） |
| `[speaker] 拉取对话失败（可能登录态失效）` | 小米云异常，服务会自动重登 |
| `[MiClient] TTS 播报指令下发失败` | 播报没发出去（听不到回答先查这个） |
| `[spec] 未找到型号 xxx 的 MIoT spec` | 某设备查不到能力描述，该设备暂不可精细控制 |
| `[cache] 刷新失败（保留旧快照）` | 设备列表刷新失败，沿用上次结果 |

## 7. 故障排查（FAQ）

**Q：启动报 `配置缺失或非法`**
→ 检查 `.env` 是否存在且必填项齐全；确认用了 `npm run dev`/`npm start`（脚本自带 `--env-file=.env`），不要直接 `node src/app.ts`。

**Q：启动报 `--env-file` 不认识 / bad option**
→ Node 版本低于 20.6。`nvm use 24` 后再启动。

**Q：启动报小米云登录失败**
→ 最常见原因是 `MI_USER_ID` 填了手机号（要数字 ID）；其次是异地登录风控——换到家庭常用网络重试。启动会自动重试 5 次（5s→40s 退避）。

**Q：说话没反应**
→ 按顺序查：① 日志有没有 `🔥`（没有 = 没轮询到/触发词没命中——说的话要以"请"或"小智"开头）② 有 `🔥` 但没回复（LLM 超时/Key 无效，看 `[Agent] LLM 调用失败`）③ 有回复但听不到（`TTS 播报指令下发失败`）。

**Q：某台设备控制不了 / 说"没有能力 X"**
→ 该设备型号在 miot-spec.org 查不到 spec（看 `[spec] 未找到型号` 日志），或为蓝牙网关设备不支持云端控制（在米家 App 里试试能否远程控制）。新添的设备最多等 `DEVICE_REFRESH_MS`（默认 30 秒）后生效。

**Q：回答很慢**
→ 轮询 1 秒 + LLM 推理时间。换响应更快的模型、或检查网络。

**Q：服务自己退出了**
→ 连续 10 次重登失败（长期断网/改了密码）会主动退出——这是设计行为（fail-fast），恢复网络/密码后重启，或配进程管理器自动拉起。

**Q：想换触发词/全接管**
→ 改 `TRIGGER_WORDS` 后重启。全接管模式注意：所有对话（包括"开灯"这种原生秒回的指令）都会走 1~2 秒 LLM 链路。

## 8. 测试与开发

```bash
npm test            # 92 个单元测试（全部 mock，不联网）
npm run typecheck   # TS 类型检查
```

代码结构：`src/mi/`（小米接入层）· `src/agent/`（LLM 智能体层）· `src/deviceCache.ts`（设备快照）· `src/app.ts`（装配）。

## 9. 安全与注意事项

- ⚠️ **`.mi.json`**：登录成功后项目根目录会生成此文件（mi-service-lite 写入，**含明文密码 + serviceToken**）。已被 `.gitignore` 忽略——勿手动提交、勿拷贝给他人。
- ⚠️ **`.env`** 含账号密码与 API Key，同样勿提交（已忽略）。
- 依赖小米云非官方接口：登录态可能数周失效一次，服务会自动重登；协议变更时需更新代码（全部隔离在 `src/mi/client.ts`）。
- 免责：仅供个人学习研究；异常高频调用有被小米风控的理论风险（自用低频风险低，请勿把轮询间隔调低于 500ms）。
