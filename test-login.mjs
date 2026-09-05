// 单次登录测试（不进重试循环，直接看小米返回的原始错误）
// 用法：node --env-file=.env test-login.mjs
const { getMiIOT, getMiNA } = await import("mi-service-lite");
const cfg = {
  userId: process.env.MI_USER_ID,
  password: process.env.MI_PASSWORD,
  did: process.env.MI_DID,
};
console.log("userId:", cfg.userId?.slice(0, 3) + "***", " did:", cfg.did?.slice(0, 4) + "***");

console.log("\n── IoT 域（xiaomiio）──");
try {
  const iot = await getMiIOT(cfg);
  console.log(iot ? "登录成功 ✓" : "失败（undefined）——看上方红色原始错误");
} catch (e) { console.log("异常:", e.message); }

console.log("\n── 对话域（micoapi）──");
try {
  const mina = await getMiNA(cfg);
  console.log(mina ? "登录成功 ✓" : "失败（undefined）——看上方红色原始错误");
} catch (e) { console.log("异常:", e.message); }
