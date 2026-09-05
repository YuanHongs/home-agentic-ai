/**
 * 真实小米风控日志样本（2026-09-05 真机联调触发，来自用户终端截图 OCR 还原）。
 *
 * 价值：这是 mi-service-lite 风控分支的**真实输出格式**——包括授权链接
 * 在终端被折行截断的实际形态、以及混在日志里的正常失败响应
 * （&&&START&&& JSON）。比人造 mock 数据更能锁住识别逻辑的契约。
 *
 * 注意：context 参数是随机一次性令牌，早已失效，无泄漏风险。
 */

/** Mac 端首次触发（IoT 域 xiaomiio；链接被终端折行成多段） */
export const MAC_XIAOMIIO_LOG = [
  "🔥 触发小米账号异地登录安全验证机制，请在浏览器打开以下链接，并按照网页提示授权验证账号：：",
  "👉 https://account.xiaomi.com/fe/service/identity/authStart?sid=xiaomiio&context=oRNeP4Bd6EOKiowBORS3WHqcJ31Kr08et-mUR4FFfkroG_t.Jh2L7HBqaaOuiON31ATiUZ1QP16stRKBye54ybQ80BPvDgEZGEnIGk94WV2eSnpxBJ3UzNnfS6m92r8mxLH4FbPLjHV-s-vtzmxmsIypq-1I06AA",
  "Lz_WFGFT5GdAMvHAHt6jXRMwbnHLWTd4WxhW8aYQOBth-8VQiGnLEQBQEAiFNalUfB5ILGJVCzTwMgbAxCNQRoxNKH-tQ0--YBA4WuRH3vDKNihndst0e10Vv7Pd6sXPmCx8rWiYKRkvNHOoDHma8M_vvmug6P",
  "_GhLbuVRVXLJHr4KZzf2F",
  "uB-pr9-BeN/EsFeAZ4qDw（wPQN2_VuQKV9SrcrU5oBh3QJSGZubZjgKLv4c",
  "tTmgsm8o2-7DZdQmYGo8LYofIfoxyAqI6KUSaBRuKofnbF2J16UpcP2-IOineBzIfZpq36P7xXaJenoj4SwkwCXBT1dLXnqZNqgb_GyMS85PNt-uiRNhdJE7X",
  "Kyhj_Rds4jP160xr1JuvbMgFRKCcgNpD4jRj0d3clE3odwndNx_iSWG7UtQJo-sf1DydrK6R3noQQF056FNbnbdueWfWzlqhtLxsP2wzq_LSQi3939014DNO",
  "vx91BLsKCpGXGhlnON?juHkEj8brAX9nr196azePAMOp9UdcGfIGopQ2LjUiutLjrz_",
  "_-817EsIPU10IkWWyybcA&_locale=zh_CN",
  "🐛 注意：授权成功后，大约需要等1 个小时左右账号信息才会更新，请在更新后再尝试重新登永。。",
  "❌ 小米账号登录失败 &&&START&&& {\"notificationUrl\":\"https://account.xiaomi.com/fe/service/identity/authStart?sid=xiaomiio&context=oRNeP4Bd...\",\"result\":\"ok\",\"description\":\"成功\",\"pwd\":0}",
];

/** Windows 端等 1 小时后仍触发（对话域 micoapi——证明两个域需分别授权） */
export const WIN_MICOAPI_LOG = [
  "🔥 触发小米账号异地登录安全验证机制，请在浏览器打开以下链接，并按照网页提示授权验证账号：：",
  "👉 https://account.xiaomi.com/fe/service/identity/authStart?sid=micoapi&context=91XEBJgqO8FsceIDUHPdLOX_iiNDQN2ArqATDgY-LBOY84C8p8pCFESfoIxu004__5AinAAM_k4HqpnpM1PucrCHibqNDMDF56mXOrvjzFC",
  "QxWHLgleFn30f7aaDDV3ZIX62RSaN8HmTFNRL5e7nF17PIuB7Fvd09j5T1euhXcaYBVpovgOfYmpPno0Sht9yMxC_7VE-CA7IJqAtkFD86AuEpWIGD9okzyEKNjv7ahRWnBJXFP1dsm8b-uP8-UebC4jr4NoECa3vYcCDpu00ehud4M6YN-n2DM6",
  "WGjEPXyrD9aZLmSPxmXdTHVMFLz-R108tZ0Swx-t9A8SusjQzz7t5AAB9pRsYp2jTn38TysGiB3jgSh2SOkOSWTPmPukSmlvoLkpEv8N-gMNdq2HvtHg-qxQjJHPbcblxdSDmHkdOv7-6BaEibzZz6w3ZH-5xZ1JKrM5V3hjuEpR3RqG5s-17pN7sSZbd",
  "n_19-vmzQ00iDm5G1J1tEK8pdgZ-QDOhE9AYILOsKXCoiHFvNbgYVIA-97BERSCpVdJgvOJNWfxNqvh0P-gMm9E4nlif8CFb6MJWaqeJCzQBk37qUGC-bIwR47pGTLYozygIry8FDJBwjFmZ1ZkuhWrrXqkWDn67x_mQNBFUZeA-NTi1NaGa4dOFrp",
  "SP_XzYhJeoRJkbTECwDarRe661oBU1XsQQXXgYOK07pMbhWKYOmgOgkt-33SkgfInJZHSLfUCvX1-ObvBZ7CDmlztWFdYSJF7-Kzjx4qQh5tdcPsTHhdq501ab634w54L2c4&_locale=zh_CN",
  "口口注意：授权成功后，大约需要等待1 个小时左右账号信息才会更新，请在更新后再会试重新登录。。",
];

/** 正常的登录失败（凭证错/did 错）——绝不能误判为风控 */
export const NORMAL_FAIL_LOG = [
  "❌ 小米账号登录失败 &&&START&&& {\"result\":\"ok\",\"description\":\"成功\",\"pwd\":0}",
];
