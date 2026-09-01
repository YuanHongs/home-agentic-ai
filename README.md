# home-agentic-ai

把小爱音箱的"大脑"换成自己订阅的大模型：轮询小爱对话 → LLM 意图理解（Function Calling）→ 米家设备控制 → 小爱原生 TTS 播报。

设计文档：`docs/superpowers/specs/2026-09-01-xiaomi-speaker-custom-llm-design.md`

## 前置条件

- Node.js >= 20
- 小米账号（与米家 App 同一账号，音箱和设备都已绑定）
- 任意 OpenAI 兼容大模型 API Key（GLM / DeepSeek / Kimi / Qwen 等）
- AI 入口音箱默认按 **小爱音箱 Art (L09A)** 配置；其他型号改 `.env` 里的 `TTS_COMMAND` / `WAKEUP_COMMAND`（查 https://home.miot-spec.com）

## 获取 MI_DID

1. 浏览器登录 https://iot.mi.com（与米家同账号）
2. F12 打开控制台 → Network 标签 → 刷新页面
3. 找 `device_list` 请求，响应里找你的音箱条目，`did` 字段即 `MI_DID`
4. `MI_USER_ID` 用小米 ID（数字），在 https://account.xiaomi.com 个人信息页查看

## 运行

```bash
npm install
cp .env.example .env   # 填入配置
npm run dev            # 开发（改动自动重启）
# 或 npm start
```

## 验证（M1→M2→M3 联调清单）

1. **M1 接入层**：启动后对 Art 说"请你好"——日志应出现 `🔥 请你好`，音箱播报 LLM 的回复
2. **M2 设备控制**：对 Art 说"请打开台灯"——台灯应真实打开并播报结果（先拿不重要的灯试！）
3. **M3 意图理解**：说"请我要睡了"——应组合关闭灯/空调；说"请有点冷"——应调高空调温度
4. **兜底**：断开 LLM Key 再说话——应播报"我脑子转不动了"

## 注意

- 依赖小米云非官方接口，登录态可能数周失效一次：报错后重启服务重新登录即可
- 触发词默认"请 / 小智"开头；`TRIGGER_WORDS=` 留空进入全接管实验模式
- 免责：仅供个人学习研究，异常调用有被小米风控的理论风险（自用低频风险低）
