import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCache } from "../src/deviceCache.js";
import type { DeviceInfo, IRemoteDevice } from "../src/types.js";

const fakeRemote = (devices: DeviceInfo[]): IRemoteDevice => ({
  listDevices: vi.fn(async () => devices),
  getDeviceState: vi.fn(async (did) => ({ did, properties: {} })),
  executeAction: vi.fn(async () => ({ ok: true, message: "ok" })),
});

afterEach(() => vi.useRealTimers());

describe("DeviceCache", () => {
  it("refresh 后 snapshot 返回设备列表", async () => {
    const cache = new DeviceCache({
      remote: fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]),
      refreshMs: 30_000,
    });
    expect(cache.snapshot()).toEqual([]);
    await cache.refresh();
    expect(cache.snapshot()).toHaveLength(1);
  });

  it("refresh 失败时保留旧快照并回调 onRefreshError", async () => {
    const onError = vi.fn();
    let fail = false;
    const remote = fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]);
    remote.listDevices = vi.fn(async () => {
      if (fail) throw new Error("cloud down");
      return [{ did: "1", name: "灯", model: "m", capabilities: [] }];
    });
    const cache = new DeviceCache({ remote, refreshMs: 30_000, onRefreshError: onError });
    await cache.refresh();
    expect(cache.snapshot()).toHaveLength(1);
    fail = true;
    await cache.refresh();
    expect(onError).toHaveBeenCalled();
    expect(cache.snapshot()).toHaveLength(1); // 旧快照仍在
  });

  it("start 定期刷新，stop 停止", async () => {
    vi.useFakeTimers();
    const remote = fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]);
    const cache = new DeviceCache({ remote, refreshMs: 1000 });
    cache.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(remote.listDevices).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(remote.listDevices).toHaveBeenCalledTimes(2);
    cache.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote.listDevices).toHaveBeenCalledTimes(2);
  });
});
