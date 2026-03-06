/**
 * ESP32 分区表解析器
 * 基于 ESP-IDF 分区表格式
 */

export interface Partition {
  name: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  flags: number;
  typeName: string;
  subtypeName: string;
}

// 分区类型
const PARTITION_TYPES: { [key: number]: string } = {
  0x00: "应用",
  0x01: "数据",
};

// 应用子类型
const APP_SUBTYPES: { [key: number]: string } = {
  0x00: "工厂",
  0x10: "OTA_0",
  0x11: "OTA_1",
  0x12: "OTA_2",
  0x13: "OTA_3",
  0x14: "OTA_4",
  0x15: "OTA_5",
  0x16: "OTA_6",
  0x17: "OTA_7",
  0x18: "OTA_8",
  0x19: "OTA_9",
  0x1a: "OTA_10",
  0x1b: "OTA_11",
  0x1c: "OTA_12",
  0x1d: "OTA_13",
  0x1e: "OTA_14",
  0x1f: "OTA_15",
  0x20: "测试",
};

// 数据子类型
const DATA_SUBTYPES: { [key: number]: string } = {
  0x00: "OTA",
  0x01: "PHY",
  0x02: "NVS",
  0x03: "核心转储",
  0x04: "NVS 密钥",
  0x05: "EFUSE",
  0x80: "ESPHTTPD",
  0x81: "FAT",
  0x82: "SPIFFS",
};

const PARTITION_TABLE_OFFSET = 0x8000; // 默认分区表偏移
const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC = 0x50aa;

/**
 * 从二进制数据中解析单个分区条目
 */
function parsePartitionEntry(data: Uint8Array): Partition | null {
  if (data.length < PARTITION_ENTRY_SIZE) {
    return null;
  }

  // 检查魔数
  const magic = (data[0] | (data[1] << 8)) & 0xffff;
  if (magic !== PARTITION_MAGIC) {
    return null;
  }

  const type = data[2];
  const subtype = data[3];
  const offset = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  const size = data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24);

  // 名称从偏移 12 开始，最多 16 字节，以空字符结尾
  let name = "";
  for (let i = 12; i < 28; i++) {
    if (data[i] === 0) break;
    name += String.fromCharCode(data[i]);
  }

  const flags =
    data[28] | (data[29] << 8) | (data[30] << 16) | (data[31] << 24);

  // 获取类型和子类型名称
  const typeName = PARTITION_TYPES[type] || `未知(0x${type.toString(16)})`;
  let subtypeName = "";

  if (type === 0x00) {
    subtypeName = APP_SUBTYPES[subtype] || `未知(0x${subtype.toString(16)})`;
  } else if (type === 0x01) {
    subtypeName = DATA_SUBTYPES[subtype] || `未知(0x${subtype.toString(16)})`;
  } else {
    subtypeName = `0x${subtype.toString(16)}`;
  }

  return {
    name,
    type,
    subtype,
    offset,
    size,
    flags,
    typeName,
    subtypeName,
  };
}

/**
 * 解析整个分区表
 */
export function parsePartitionTable(data: Uint8Array): Partition[] {
  const partitions: Partition[] = [];

  for (let i = 0; i < data.length; i += PARTITION_ENTRY_SIZE) {
    const entryData = data.slice(i, i + PARTITION_ENTRY_SIZE);
    const partition = parsePartitionEntry(entryData);

    if (partition === null) {
      // 分区表结束或无效条目
      break;
    }

    partitions.push(partition);
  }

  return partitions;
}

/**
 * 获取默认分区表偏移量
 */
export function getPartitionTableOffset(): number {
  return PARTITION_TABLE_OFFSET;
}

/**
 * 格式化大小为人类可读格式
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
