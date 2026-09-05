import { loadConfig } from "./config.js";
import { MiClient, MiRiskControlError } from "./mi/client.js";
import { MiDeviceService } from "./mi/devices.js";
import { ConversationPoller } from "./mi/poller.js";
import { SpeakerLoop } from "./mi/speaker.js";
import { Agent } from "./agent/agent.js";
import { OpenAICompatLLM } from "./agent/llm.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { DeviceCache } from "./deviceCache.js";

/** 启动登录重试：网络未就绪时指数退避重试，避免崩溃循环砸小米云登录接口 */
const INIT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000]; // 最多 5 次尝试

async function initWithRetry(client: MiClient): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.init();
      return;
    } catch (err) {
      // 小米账号风控：重试会以新随机 deviceId 反复登录加重风控——立即放弃，
      // exit code 2 区别于其他启动失败（配合 README 排障）
      if (err instanceof MiRiskControlError) {
        console.error(`[app] ${err.message}`);
        if (err.authUrl) console.error(`[app] 授权链接: ${err.authUrl}`);
        process.exit(2);
      }
      if (attempt > INIT_RETRY_DELAYS_MS.length) throw err; // 全部失败：真凭证错误
      const waitMs = INIT_RETRY_DELAYS_MS[attempt - 1];
      console.error(
        `[app] 小米云登录失败（第 ${attempt}/${INIT_RETRY_DELAYS_MS.length + 1} 次），` +
          `${waitMs / 1000}s 后重试:`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  const config = loadConfig(process.env);
  console.log("[app] 配置加载完成，正在登录小米云...");

  const client = new MiClient(config);
  await initWithRetry(client);
  console.log("[app] 小米云登录成功");

  const devices = new MiDeviceService({
    client,
    refreshMs: config.deviceRefreshMs,
    denylist: config.deviceDenylist,
    typeAllowlist: config.deviceTypeAllowlist,
  });
  const cache = new DeviceCache({
    remote: devices,
    refreshMs: config.deviceRefreshMs,
    onRefreshError: (e) => console.error("[cache] 刷新失败（保留旧快照）:", e.message),
  });
  await cache.refresh(); // 启动前先建快照
  cache.start();

  const agent = new Agent({
    llm: new OpenAICompatLLM({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      timeoutMs: config.llmTimeoutMs,
    }),
    devices,
    systemPrompt: () => buildSystemPrompt(cache.snapshot()),
  });

  const poller = new ConversationPoller((limit) => client.getLatestRecords(limit));
  const loop = new SpeakerLoop({
    poller,
    agent,
    client,
    triggerWords: config.triggerWords,
    pollIntervalMs: config.pollIntervalMs,
    onError: (e) => console.error("[speaker]", e.message),
  });

  console.log(`[app] 服务已启动：触发词 [${config.triggerWords.join("、") || "全接管"}]`);
  const shutdown = () => {
    loop.stop();
    cache.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown); // Docker 停止容器的默认信号
  await loop.start();
}

main().catch((err) => {
  console.error("[app] 启动失败:", err.message);
  process.exit(1);
});
