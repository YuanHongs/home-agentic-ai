// 单次登录测试（不进重试循环，直接看小米返回的原始错误）
// 用法：node --env-file=.env test-login.mjs
//
// 说明：mi-service-lite 触发"异地登录安全验证"风控时不抛错，只 console.log
// 文案 + 授权链接然后返回 undefined——脚本通过临时捕获 console.log 识别
// 风控（与 src/mi/client.ts 的 MiRiskControlError 同一套检测逻辑的 JS 版，
// 脚本保持零依赖可独立运行）。脚本故意不做重试：风控下每次登录都会生成
// 新随机 deviceId，反复尝试只会加重风控。
const { getMiIOT, getMiNA } = await import("mi-service-lite");

const RISK_MARKER = "异地登录安全验证";
const AUTH_URL_PREFIX = "https://account.xiaomi.com/";

const cfg = {
  userId: process.env.MI_USER_ID,
  password: process.env.MI_PASSWORD,
  did: process.env.MI_DID,
};

if (!cfg.userId || !cfg.password || !cfg.did) {
  console.error("❌ 缺少环境变量：需要 MI_USER_ID / MI_PASSWORD / MI_DID（用 node --env-file=.env 运行）");
  process.exit(1);
}
console.log("userId:", cfg.userId.slice(0, 3) + "***", " did:", cfg.did.slice(0, 4) + "***");

/** 捕获 console.log 跑一次登录：返回 { ok, risk, authUrl } */
async function probe(label, login) {
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => {
    captured.push(args.map(String).join(" "));
    originalLog(...args); // 授权链接必须透传给用户
  };
  let ok = false;
  try {
    const svc = await login();
    ok = svc !== undefined;
  } catch (e) {
    originalLog("异常:", e.message);
  } finally {
    console.log = originalLog;
  }
  const risk = captured.some((l) => l.includes(RISK_MARKER));
  const urls = captured.join("\n").match(/https?:\/\/[^\s"'）)]+/g) ?? [];
  const authUrl = urls.find((u) => u.startsWith(AUTH_URL_PREFIX)) ?? urls[0];
  console.log(`${label}: ${risk ? "触发安全验证 🔒" : ok ? "登录成功 ✓" : "失败（undefined）——看上方红色原始错误"}`);
  return { ok, risk, authUrl };
}

const iot = await probe("── IoT 域（xiaomiio）──", () => getMiIOT(cfg));
const na = await probe("── 对话域（micoapi）──", () => getMiNA(cfg));

if (iot.risk || na.risk) {
  console.log("\n⚠️  已触发小米账号异地登录安全验证：");
  const urls = [iot.authUrl, na.authUrl].filter((u, i, a) => u && a.indexOf(u) === i);
  for (const url of urls) console.log("授权链接:", url);
  console.log(
    "请用手机浏览器打开上面的链接完成验证" +
      (iot.risk && na.risk ? "（两个域可能需要分别授权）" : "") +
      "，等待约 1 小时账号信息更新后再运行本脚本。\n" +
      "期间请勿反复重试——每次重试都会以新设备身份登录，只会加重风控。",
  );
} else if (!iot.ok || !na.ok) {
  console.log("\n常见原因：① MI_USER_ID 填了手机号（要数字 ID，不是手机号）② MI_DID 与米家中的设备不一致 ③ MI_PASSWORD 有误。");
}
