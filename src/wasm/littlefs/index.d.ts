import type { FileSource, BinarySource } from "../shared/types";

/**
 * 最大文件名长度（ESP-IDF 默认值：64）
 */
export declare const LFS_NAME_MAX: number;

/**
 * LittleFS 磁盘版本 2.0 (0x00020000)
 * 使用此版本以获得与旧实现的最大兼容性。
 */
export declare const DISK_VERSION_2_0: number;

/**
 * LittleFS 磁盘版本 2.1 (0x00020001)
 * 包含附加功能的最新版本。
 */
export declare const DISK_VERSION_2_1: number;

/**
 * 将磁盘版本格式化为人类可读字符串（例如 "2.0"、"2.1"）
 */
export declare function formatDiskVersion(version: number): string;

export interface LittleFSEntry {
  path: string;
  size: number;
  type: "file" | "dir";
}

export interface LittleFSOptions {
  blockSize?: number;
  blockCount?: number;
  lookaheadSize?: number;
  /**
   * 可选覆盖 wasm 资产的位置。当打包工具移动文件时很有用。
   */
  wasmURL?: string | URL;
  /**
   * 初始化后立即格式化文件系统。
   */
  formatOnInit?: boolean;
  /**
   * 格式化新文件系统时要使用的磁盘版本。
   * 使用 DISK_VERSION_2_0 以获得与旧 ESP 实现的兼容性。
   * 使用 DISK_VERSION_2_1 以获取最新功能。
   *
   * 重要提示：设置此版本会阻止旧文件系统的自动迁移。
   */
  diskVersion?: number;
}

export interface LittleFS {
  format(): void;
  list(path?: string): LittleFSEntry[];
  addFile(path: string, data: FileSource): void;
  writeFile(path: string, data: FileSource): void;
  deleteFile(path: string): void;
  delete(
    path: string,
    options?: {
      recursive?: boolean;
    },
  ): void;
  mkdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  toImage(): Uint8Array;
  readFile(path: string): Uint8Array;
  /**
   * 获取已挂载文件系统的磁盘版本。
   * @returns 版本作为 32 位数字（例如 v2.0 为 0x00020000，v2.1 为 0x00020001）
   */
  getDiskVersion(): number;
  /**
   * 为新文件系统设置磁盘版本。
   * 必须在格式化前调用。
   * @param version - 作为 32 位数字的版本（使用 DISK_VERSION_2_0 或 DISK_VERSION_2_1）
   */
  setDiskVersion(version: number): void;
  /**
   * 获取文件系统使用统计信息。
   */
  getUsage(): { capacityBytes: number; usedBytes: number; freeBytes: number };
  /**
   * 检查给定大小的文件是否可以放入文件系统。
   * @param path - 文件路径（当前未使用，保留供将来使用）
   * @param size - 字节大小
   * @returns 如果文件可以放入则返回 true，否则返回 false
   */
  canFit(path: string, size: number): boolean;
  /**
   * 清理并卸载文件系统。
   * 当不再使用文件系统时应调用此方法以释放资源。
   */
  cleanup(): void;
}

export declare class LittleFSError extends Error {
  readonly code: number;
  constructor(message: string, code: number);
}

export declare function createLittleFS(
  options?: LittleFSOptions,
): Promise<LittleFS>;
export declare function createLittleFSFromImage(
  image: BinarySource,
  options?: LittleFSOptions,
): Promise<LittleFS>;