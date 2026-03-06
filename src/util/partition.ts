/**
 * 通过读取分区头部检测文件系统类型
 */
export async function detectFilesystemType(
  espStub: any,
  offset: number,
  size: number,
  logger: any = console,
): Promise<string> {
  try {
    // 读取前 8KB 或整个分区（如果更小）
    const readSize = Math.min(8192, size);
    const data = await espStub.readFlash(offset, readSize);

    if (data.length < 32) {
      logger.log("分区太小，假定为 SPIFFS");
      return "spiffs";
    }

    // 方法 1：检查元数据中是否包含 "littlefs" 字符串
    const decoder = new TextDecoder("ascii", { fatal: false });
    const dataStr = decoder.decode(data);

    if (dataStr.includes("littlefs")) {
      logger.log('✓ 检测到 LittleFS：找到 "littlefs" 签名');
      return "littlefs";
    }

    // 方法 2：检查 LittleFS 块结构
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const blockSizes = [4096, 2048, 1024, 512];
    for (const blockSize of blockSizes) {
      if (data.length >= blockSize * 2) {
        try {
          for (let i = 0; i < Math.min(blockSize, data.length - 4); i += 4) {
            const tag = view.getUint32(i, true);
            const type = (tag >> 20) & 0xfff;
            const length = tag & 0x3ff;

            if (type <= 0x7ff && length > 0 && length <= 1022) {
              if (i + length + 4 <= data.length) {
                logger.log("✓ 检测到 LittleFS：找到有效的元数据结构");
                return "littlefs";
              }
            }
          }
        } catch (e) {
          // 继续检查其他方法
        }
      }
    }

    // 方法 3：检查 SPIFFS 签名
    for (let i = 0; i < Math.min(4096, data.length - 4); i += 4) {
      const magic = view.getUint32(i, true);
      if (magic === 0x20140529 || magic === 0x20160529) {
        logger.log("✓ 检测到 SPIFFS：找到 SPIFFS 魔数");
        return "spiffs";
      }
    }

    // 默认：假定为 SPIFFS
    logger.log("⚠ 未找到清晰的文件系统签名，假定为 SPIFFS");
    return "spiffs";
  } catch (err: any) {
    logger.error(`检测文件系统类型失败：${err.message || err}`);
    return "spiffs"; // 安全的回退
  }
}
