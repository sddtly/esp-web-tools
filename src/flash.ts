import { Logger } from "tasmota-webserial-esptool";
import {
  Build,
  FlashError,
  FlashState,
  Manifest,
  FlashStateType,
} from "./const";
import { getChipFamilyName } from "./util/chip-family-name";
import { sleep } from "./util/sleep";
import { corsProxyFetch } from "./util/cors-proxy";

export const flash = async (
  onEvent: (state: FlashState) => void,
  esploader: any, // ESPLoader 实例，来自 tasmota-webserial-esptool
  logger: Logger,
  manifestPath: string,
  eraseFirst: boolean,
  firmwareBuffer: Uint8Array,
  baudRate?: number,
) => {
  let manifest: Manifest;
  let build: Build | undefined;
  let chipFamily: ReturnType<typeof getChipFamilyName>;
  let chipVariant: string | null = null;

  const fireStateEvent = (stateUpdate: FlashState) =>
    onEvent({
      ...stateUpdate,
      manifest,
      build,
      chipFamily,
      chipVariant,
    });

  let manifestProm = null;
  let manifestURL: string = "";

  try {
    manifestProm = JSON.parse(manifestPath);
  } catch {
    manifestURL = new URL(manifestPath, location.toString()).toString();
    manifestProm = corsProxyFetch(manifestURL).then(
      (resp): Promise<Manifest> => resp.json(),
    );
  }

  // 使用传入的 ESPLoader 实例 - 此处不处理端口逻辑！
  // 用于调试
  (window as any).esploader = esploader;

  fireStateEvent({
    state: FlashStateType.INITIALIZING,
    message: "正在初始化...",
    details: { done: false },
  });

  // 仅当尚未初始化时才进行初始化
  if (!esploader.chipFamily) {
    try {
      await esploader.initialize();
    } catch (err: any) {
      logger.error(err);

      fireStateEvent({
        state: FlashStateType.ERROR,
        message:
          "初始化失败。请尝试重置设备，或在点击 INSTALL 时按住 BOOT 按钮。",
        details: { error: FlashError.FAILED_INITIALIZING, details: err },
      });
      if (esploader.connected) {
        await esploader.disconnect();
      }
      return;
    }
  }

  chipFamily = getChipFamilyName(esploader);
  chipVariant = esploader.chipVariant;

  fireStateEvent({
    state: FlashStateType.INITIALIZING,
    message: `初始化完成。发现 ${chipFamily}${chipVariant ? ` (${chipVariant})` : ""}`,
    details: { done: true },
  });
  fireStateEvent({
    state: FlashStateType.MANIFEST,
    message: "正在获取清单...",
    details: { done: false },
  });

  try {
    manifest = await manifestProm;
  } catch (err: any) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: `无法获取清单：${err}`,
      details: { error: FlashError.FAILED_MANIFEST_FETCH, details: err },
    });
    await esploader.disconnect();
    return;
  }

  build = manifest.builds.find((b) => {
    // 匹配 chipFamily 并可选的 chipVariant
    if (b.chipFamily !== chipFamily) {
      return false;
    }

    // 如果构建指定了 chipVariant，则必须匹配
    if (b.chipVariant && b.chipVariant !== chipVariant) {
      return false;
    }

    return true;
  });

  if (!build) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: `您的 ${chipFamily}${chipVariant ? ` (${chipVariant})` : ""} 不受此固件支持。`,
      details: { error: FlashError.NOT_SUPPORTED, details: chipFamily },
    });
    await esploader.disconnect();
    return;
  }

  fireStateEvent({
    state: FlashStateType.MANIFEST,
    message: "清单获取成功",
    details: { done: true },
  });

  fireStateEvent({
    state: FlashStateType.PREPARING,
    message: "正在准备安装...",
    details: { done: false },
  });

  // 传入的 esploader 始终是存根（来自 _ensureStub()）
  // 波特率已在 _ensureStub() 中设置
  const espStub = esploader;

  // 验证存根是否具有 chipFamily（应该在 _ensureStub 中复制）
  if (!espStub.chipFamily) {
    logger.error("存根缺少 chipFamily - 这不应该发生！");
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: "内部错误：存根未正确初始化",
      details: {
        error: FlashError.FAILED_INITIALIZING,
        details: "缺少 chipFamily",
      },
    });
    return;
  }

  // 获取固件文件
  const filePromises = build.parts.map(async (part) => {
    const url = new URL(
      part.path,
      manifestURL || location.toString(),
    ).toString();
    const resp = await corsProxyFetch(url);
    if (!resp.ok) {
      throw new Error(`下载固件 ${part.path} 失败：${resp.status}`);
    }
    return resp.arrayBuffer();
  });

  // 如果提供了 firmwareBuffer，则使用它而不是获取
  if (firmwareBuffer) {
    filePromises.push(Promise.resolve(firmwareBuffer.buffer as ArrayBuffer));
  }

  const files: (ArrayBuffer | Uint8Array)[] = [];
  let totalSize = 0;

  for (const prom of filePromises) {
    try {
      const data = await prom;
      files.push(data);
      totalSize += data.byteLength;
    } catch (err: any) {
      fireStateEvent({
        state: FlashStateType.ERROR,
        message: err.message,
        details: { error: FlashError.FAILED_FIRMWARE_DOWNLOAD, details: err },
      });
      await esploader.disconnect();
      return;
    }
  }

  fireStateEvent({
    state: FlashStateType.PREPARING,
    message: "安装准备就绪",
    details: { done: true },
  });

  // 关键：如果请求擦除，则必须在写入之前进行擦除
  if (eraseFirst) {
    fireStateEvent({
      state: FlashStateType.ERASING,
      message: "正在擦除 flash...",
      details: { done: false },
    });

    try {
      logger.log("正在擦除 flash。请稍候...");
      await espStub.eraseFlash();
      logger.log("flash 擦除成功");

      fireStateEvent({
        state: FlashStateType.ERASING,
        message: "flash 已擦除",
        details: { done: true },
      });
    } catch (err: any) {
      logger.error(`flash 擦除失败：${err.message}`);
      fireStateEvent({
        state: FlashStateType.ERROR,
        message: `擦除 flash 失败：${err.message}`,
        details: { error: FlashError.WRITE_FAILED, details: err },
      });
      await esploader.disconnect();
      return;
    }
  }

  fireStateEvent({
    state: FlashStateType.WRITING,
    message: `写入进度：0 %`,
    details: {
      bytesTotal: totalSize,
      bytesWritten: 0,
      percentage: 0,
    },
  });

  let lastPct = 0;
  let totalBytesWritten = 0;

  try {
    for (let i = 0; i < build.parts.length; i++) {
      const part = build.parts[i];
      const data = files[i];

      await espStub.flashData(
        data,
        (bytesWritten: number, bytesTotal: number) => {
          const newPct = Math.floor(
            ((totalBytesWritten + bytesWritten) / totalSize) * 100,
          );
          if (newPct === lastPct) {
            return;
          }
          lastPct = newPct;
          fireStateEvent({
            state: FlashStateType.WRITING,
            message: `写入进度：${newPct} %`,
            details: {
              bytesTotal: totalSize,
              bytesWritten: totalBytesWritten + bytesWritten,
              percentage: newPct,
            },
          });
        },
        part.offset,
      );

      totalBytesWritten += data.byteLength;
    }
  } catch (err: any) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: err.message,
      details: { error: FlashError.WRITE_FAILED, details: err },
    });
    await esploader.disconnect();
    return;
  }

  fireStateEvent({
    state: FlashStateType.WRITING,
    message: "写入完成",
    details: {
      bytesTotal: totalSize,
      bytesWritten: totalSize,
      percentage: 100,
    },
  });

  await sleep(100);

  // 刷写后不要释放锁！
  // 保留存根和锁，以便端口可以再次使用
  // （例如用于 Improv、管理文件系统或再次刷写）

  fireStateEvent({
    state: FlashStateType.FINISHED,
    message: "全部完成！",
  });
};
