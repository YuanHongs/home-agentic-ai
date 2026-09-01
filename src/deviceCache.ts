import type { DeviceInfo, IRemoteDevice } from "./types.js";

export interface DeviceCacheOptions {
  remote: IRemoteDevice;
  refreshMs: number;
  onRefreshError?: (err: Error) => void;
}

/** 设备快照缓存：定期刷新，失败保留旧快照（供 prompt 注入与工具校验） */
export class DeviceCache {
  private devices: DeviceInfo[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: DeviceCacheOptions) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs);
    this.timer.unref?.(); // 不阻塞进程退出
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      this.devices = await this.opts.remote.listDevices();
    } catch (err) {
      this.opts.onRefreshError?.(err as Error); // 保留旧快照
    }
  }

  snapshot(): DeviceInfo[] {
    return this.devices;
  }
}
