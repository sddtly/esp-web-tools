/**
 * LittleFS WebAssembly 绑定，用于 ESPConnect
 *
 * 提供 TypeScript 优先的 LittleFS API，支持磁盘版本控制。
 * 支持 DISK_VERSION_2_0 以防止旧文件系统自动迁移。
 *
 * ESP-IDF 兼容配置：
 * - LFS_NAME_MAX=64（文件名长度）
 * - LFS_ATTR_MAX=4（时间戳的元数据）
 * - LFS_MULTIVERSION 启用
 */

// 导入 Emscripten 生成的模块加载器（转换为 ES 模块）
import createLittleFSModule from "./littlefs.js";

const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_BLOCK_COUNT = 256;
const DEFAULT_LOOKAHEAD_SIZE = 32;
const LFS_ERR_NOSPC = -28;

/**
 * 最大文件名长度（ESP-IDF 默认值）
 */
export const LFS_NAME_MAX = 64;

/**
 * LittleFS 磁盘版本 2.0 (0x00020000)
 * 使用此版本以获得与旧实现的最大兼容性。
 */
export const DISK_VERSION_2_0 = 0x00020000;

/**
 * LittleFS 磁盘版本 2.1 (0x00020001)
 * 包含附加功能的最新版本。
 */
export const DISK_VERSION_2_1 = 0x00020001;

/**
 * 将磁盘版本格式化为人类可读字符串（例如 "2.0"、"2.1"）
 */
export function formatDiskVersion(version) {
  const major = (version >> 16) & 0xffff;
  const minor = version & 0xffff;
  return `${major}.${minor}`;
}

export class LittleFSError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "LittleFSError";
  }
}

function createModuleConfig(wasmURL) {
  const wasmURLStr = wasmURL instanceof URL ? wasmURL.href : wasmURL;

  return {
    locateFile: (path) => {
      if (path.endsWith(".wasm")) {
        console.info("[littlefs-wasm] locateFile:", path, "->", wasmURLStr);
        return wasmURLStr;
      }
      return path;
    },
  };
}

/**
 * 创建新的 LittleFS 实例
 * @param {LittleFSOptions} options
 * @returns {Promise<LittleFS>}
 */
export async function createLittleFS(options = {}) {
  console.info("[littlefs-wasm] createLittleFS() 开始", options);

  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const blockCount = options.blockCount ?? DEFAULT_BLOCK_COUNT;
  const lookaheadSize = options.lookaheadSize ?? DEFAULT_LOOKAHEAD_SIZE;
  const diskVersion = options.diskVersion ?? DISK_VERSION_2_0;

  // 配置模块，使用自定义 locateFile 定位 WASM
  // 始终设置 locateFile 以确保正确解析 WASM 路径
  const wasmURL =
    options.wasmURL ?? new URL("./littlefs.wasm", import.meta.url).href;
  const moduleConfig = createModuleConfig(wasmURL);

  // 初始化 Emscripten 模块
  const Module = await createLittleFSModule(moduleConfig);
  console.info("[littlefs-wasm] Emscripten 模块已加载");
  try {
    // 在初始化前设置磁盘版本，以确保新文件系统使用指定版本
    // 并防止从旧版本自动迁移
    if (Module._lfs_wasm_set_disk_version) {
      Module._lfs_wasm_set_disk_version(diskVersion);
      console.info(
        "[littlefs-wasm] 磁盘版本已设置为：",
        formatDiskVersion(diskVersion),
      );
    }

    // 初始化 LittleFS
    const initResult = Module._lfs_wasm_init(
      blockSize,
      blockCount,
      lookaheadSize,
    );
    if (initResult !== 0) {
      throw new LittleFSError(
        `初始化 LittleFS 失败：${initResult}`,
        initResult,
      );
    }

    // 如果请求，则格式化
    if (options.formatOnInit) {
      const formatResult = Module._lfs_wasm_format();
      if (formatResult !== 0) {
        throw new LittleFSError(
          `格式化 LittleFS 失败：${formatResult}`,
          formatResult,
        );
      }
    }

    // 挂载（失败时可选择自动格式化）
    const mountResult = Module._lfs_wasm_mount();
    if (mountResult !== 0) {
      if (options.autoFormatOnMountFailure !== true) {
        throw new LittleFSError(
          `挂载 LittleFS 失败：${mountResult}`,
          mountResult,
        );
      }
      console.warn(
        "[littlefs-wasm] 挂载失败，尝试格式化和重新挂载...",
      );
      const formatResult = Module._lfs_wasm_format();
      if (formatResult !== 0) {
        throw new LittleFSError(
          `格式化 LittleFS 失败：${formatResult}`,
          formatResult,
        );
      }
      const retryMount = Module._lfs_wasm_mount();
      if (retryMount !== 0) {
        throw new LittleFSError(
          `挂载 LittleFS 失败：${retryMount}`,
          retryMount,
        );
      }
    }
  } catch (error) {
    // 重新抛出前清理 Module 资源
    if (Module._lfs_wasm_cleanup) {
      try {
        Module._lfs_wasm_cleanup();
      } catch (cleanupError) {
        console.error(
          "[littlefs-wasm] 错误处理期间清理失败：",
          cleanupError,
        );
      }
    }
    throw error;
  }

  console.info("[littlefs-wasm] LittleFS 成功挂载");
  return createClient(Module, blockSize, blockCount);
}

/**
 * 从现有镜像创建 LittleFS 实例
 * @param {Uint8Array|ArrayBuffer} image
 * @param {LittleFSOptions} options
 * @returns {Promise<LittleFS>}
 */
export async function createLittleFSFromImage(image, options = {}) {
  console.info("[littlefs-wasm] createLittleFSFromImage() 开始");

  const imageData =
    image instanceof ArrayBuffer ? new Uint8Array(image) : image;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const blockCount =
    options.blockCount ?? Math.ceil(imageData.length / blockSize);
  const lookaheadSize = options.lookaheadSize ?? DEFAULT_LOOKAHEAD_SIZE;

  // 配置模块，使用自定义 locateFile 定位 WASM
  // 始终设置 locateFile 以确保正确解析 WASM 路径
  const wasmURL =
    options.wasmURL ?? new URL("./littlefs.wasm", import.meta.url).href;
  const moduleConfig = createModuleConfig(wasmURL);

  // 初始化 Emscripten 模块
  const Module = await createLittleFSModule(moduleConfig);
  console.info("[littlefs-wasm] Emscripten 模块已加载");

  // 从镜像加载时，不设置磁盘版本（保留现有）
  // 这对于不触发迁移很重要

  try {
    // 为镜像分配内存
    const imagePtr = Module._malloc(imageData.length);
    if (!imagePtr) {
      throw new LittleFSError("为镜像分配内存失败", -1);
    }

    try {
      // 将镜像复制到 WASM 内存
      Module.HEAPU8.set(imageData, imagePtr);

      // 从镜像初始化
      const initResult = Module._lfs_wasm_init_from_image(
        imagePtr,
        imageData.length,
        blockSize,
        blockCount,
        lookaheadSize,
      );

      if (initResult !== 0) {
        throw new LittleFSError(
          `从镜像初始化 LittleFS 失败：${initResult}`,
          initResult,
        );
      }
    } finally {
      Module._free(imagePtr);
    }

    // 挂载
    const mountResult = Module._lfs_wasm_mount();
    if (mountResult !== 0) {
      throw new LittleFSError(
        `挂载 LittleFS 失败：${mountResult}`,
        mountResult,
      );
    }
  } catch (error) {
    // 重新抛出前清理 Module 资源
    if (Module._lfs_wasm_cleanup) {
      try {
        Module._lfs_wasm_cleanup();
      } catch (cleanupError) {
        console.error(
          "[littlefs-wasm] 错误处理期间清理失败：",
          cleanupError,
        );
      }
    }
    throw error;
  }

  // 挂载后获取磁盘版本
  const version = Module._lfs_wasm_get_disk_version
    ? Module._lfs_wasm_get_disk_version()
    : 0;
  console.info(
    "[littlefs-wasm] 已从镜像挂载 LittleFS，磁盘版本：",
    formatDiskVersion(version),
  );

  return createClient(Module, blockSize, blockCount);
}

/**
 * 创建客户端 API 包装器
 */
function createClient(Module, blockSize, blockCount) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function allocString(str) {
    const bytes = encoder.encode(str + "\0");
    const ptr = Module._malloc(bytes.length);
    if (!ptr) throw new LittleFSError("分配字符串失败", -1);
    Module.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  function readString(ptr, maxLength = 4096) {
    if (!ptr) return "";
    let end = ptr;
    const limit = ptr + maxLength;
    while (end < limit && Module.HEAPU8[end] !== 0) end++;
    if (end >= limit) {
      console.warn("[littlefs-wasm] 字符串读取在 maxLength 处截断");
    }
    return decoder.decode(Module.HEAPU8.subarray(ptr, end));
  }

  const client = {
    format() {
      const result = Module._lfs_wasm_format();
      if (result !== 0) {
        throw new LittleFSError(`格式化失败：${result}`, result);
      }
      // 格式化后重新挂载
      const mountResult = Module._lfs_wasm_mount();
      if (mountResult !== 0) {
        throw new LittleFSError(
          `格式化后挂载失败：${mountResult}`,
          mountResult,
        );
      }
    },

    list(path = "/") {
      const entries = [];
      const pathPtr = allocString(path);
      let dirHandle = -1;

      try {
        // dir_open 成功返回句柄 >= 0，失败返回负数
        dirHandle = Module._lfs_wasm_dir_open(pathPtr);
        if (dirHandle < 0) {
          throw new LittleFSError(
            `打开目录失败：${dirHandle}`,
            dirHandle,
          );
        }

        const nameBuffer = Module._malloc(LFS_NAME_MAX + 1);
        const typePtr = Module._malloc(4);
        const sizePtr = Module._malloc(4);

        try {
          while (true) {
            // dir_read 第一个参数为句柄
            const readResult = Module._lfs_wasm_dir_read(
              dirHandle,
              nameBuffer,
              LFS_NAME_MAX,
              typePtr,
              sizePtr,
            );
            if (readResult === 0) break; // 没有更多条目
            if (readResult < 0) {
              throw new LittleFSError(
                `读取目录失败：${readResult}`,
                readResult,
              );
            }

            const name = readString(nameBuffer);
            // C 代码中已过滤 . 和 ..，但再检查一次以防万一
            if (name === "." || name === "..") continue;

            const type = Module.HEAP32[typePtr >> 2];
            const size = Module.HEAPU32[sizePtr >> 2];

            const entryPath = path === "/" ? `/${name}` : `${path}/${name}`;
            // type: 1 = 文件 (LFS_TYPE_REG), 2 = 目录 (LFS_TYPE_DIR)
            const isDir = type === 2;
            entries.push({
              path: entryPath,
              name,
              size: isDir ? 0 : size, // 文件有大小，目录没有
              type: isDir ? "dir" : "file",
            });
          }
        } finally {
          Module._free(nameBuffer);
          Module._free(typePtr);
          Module._free(sizePtr);
        }

        // dir_close 接受句柄参数
        Module._lfs_wasm_dir_close(dirHandle);
        dirHandle = -1; // 标记已关闭
      } finally {
        Module._free(pathPtr);
        // 如果句柄仍打开（异常情况），关闭它
        if (dirHandle >= 0) {
          Module._lfs_wasm_dir_close(dirHandle);
        }
      }

      return entries;
    },

    readFile(path) {
      const pathPtr = allocString(path);
      try {
        // 先获取文件大小
        const size = Module._lfs_wasm_file_size(pathPtr);
        if (size < 0) {
          throw new LittleFSError(`获取文件大小失败：${size}`, size);
        }

        const dataPtr = Module._malloc(size);
        if (!dataPtr && size > 0) {
          throw new LittleFSError("分配读取缓冲区失败", -1);
        }

        try {
          const readResult = Module._lfs_wasm_read_file(pathPtr, dataPtr, size);
          if (readResult < 0) {
            throw new LittleFSError(
              `读取文件失败：${readResult}`,
              readResult,
            );
          }
          return new Uint8Array(
            Module.HEAPU8.buffer,
            dataPtr,
            readResult,
          ).slice();
        } finally {
          Module._free(dataPtr);
        }
      } finally {
        Module._free(pathPtr);
      }
    },

    writeFile(path, data) {
      const pathPtr = allocString(path);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const dataPtr = Module._malloc(bytes.length);

      if (!dataPtr && bytes.length > 0) {
        Module._free(pathPtr);
        throw new LittleFSError("分配写入缓冲区失败", -1);
      }

      try {
        Module.HEAPU8.set(bytes, dataPtr);
        const result = Module._lfs_wasm_write_file(
          pathPtr,
          dataPtr,
          bytes.length,
        );
        if (result < 0) {
          if (result === LFS_ERR_NOSPC) {
            throw new LittleFSError("设备上没有剩余空间", result);
          }
          throw new LittleFSError(`写入文件失败：${result}`, result);
        }
      } finally {
        Module._free(pathPtr);
        Module._free(dataPtr);
      }
    },

    addFile(path, data) {
      return this.writeFile(path, data);
    },

    deleteFile(path) {
      const pathPtr = allocString(path);
      try {
        const result = Module._lfs_wasm_remove(pathPtr);
        if (result !== 0) {
          throw new LittleFSError(`删除失败：${result}`, result);
        }
      } finally {
        Module._free(pathPtr);
      }
    },

    delete(path, options = {}) {
      if (options.recursive) {
        // 列出内容并递归删除
        try {
          const entries = this.list(path);
          for (const entry of entries) {
            if (entry.type === "dir") {
              this.delete(entry.path, { recursive: true });
            } else {
              this.deleteFile(entry.path);
            }
          }
        } catch (e) {
          // 目录可能为空或不存在，记录其他错误
          if (e.code !== -2) { // -2 是 ENOENT
            console.warn("[littlefs-wasm] 递归删除期间出错：", e);
          }
        }
      }
      this.deleteFile(path);
    },

    mkdir(path) {
      const pathPtr = allocString(path);
      try {
        const result = Module._lfs_wasm_mkdir(pathPtr);
        // 忽略“已存在”错误
        if (result !== 0 && result !== -17) {
          throw new LittleFSError(
            `创建目录失败：${result}`,
            result,
          );
        }
      } finally {
        Module._free(pathPtr);
      }
    },

    rename(oldPath, newPath) {
      const oldPtr = allocString(oldPath);
      const newPtr = allocString(newPath);
      try {
        const result = Module._lfs_wasm_rename(oldPtr, newPtr);
        if (result !== 0) {
          throw new LittleFSError(`重命名失败：${result}`, result);
        }
      } finally {
        Module._free(oldPtr);
        Module._free(newPtr);
      }
    },

    toImage() {
      const size = Module._lfs_wasm_get_image_size();
      if (size <= 0) {
        throw new LittleFSError(`无效的镜像大小：${size}`, size);
      }

      const ptr = Module._lfs_wasm_get_image();
      if (!ptr) {
        throw new LittleFSError("获取镜像指针失败", -1);
      }

      // 注意：ptr 指向内部的 ram_storage 缓冲区，不是分配的内存
      // slice() 已经复制数据，因此我们绝对不能释放此指针
      return new Uint8Array(Module.HEAPU8.buffer, ptr, size).slice();
    },

    getDiskVersion() {
      if (Module._lfs_wasm_get_fs_info) {
        const versionPtr = Module._malloc(4);
        try {
          const result = Module._lfs_wasm_get_fs_info(versionPtr);
          if (result === 0) {
            return Module.HEAPU32[versionPtr >> 2];
          }
        } finally {
          Module._free(versionPtr);
        }
      }
      console.warn(
        "[littlefs-wasm] getDiskVersion 不可用或文件系统未挂载",
      );
      return 0;
    },

    setDiskVersion(version) {
      if (Module._lfs_wasm_set_disk_version) {
        Module._lfs_wasm_set_disk_version(version);
      } else {
        console.warn("[littlefs-wasm] setDiskVersion 不可用");
      }
    },

    getUsage() {
      const blockUsedPtr = Module._malloc(4);
      const blockTotalPtr = Module._malloc(4);

      try {
        const result = Module._lfs_wasm_fs_stat(blockUsedPtr, blockTotalPtr);
        if (result !== 0) {
          // 回退估算
          return {
            capacityBytes: blockSize * blockCount,
            usedBytes: 0,
            freeBytes: blockSize * blockCount,
          };
        }

        const blocksUsed = Module.HEAPU32[blockUsedPtr >> 2];
        const blocksTotal = Module.HEAPU32[blockTotalPtr >> 2];

        const capacityBytes = blocksTotal * blockSize;
        const usedBytes = blocksUsed * blockSize;

        return {
          capacityBytes,
          usedBytes,
          freeBytes: Math.max(0, capacityBytes - usedBytes),
        };
      } finally {
        Module._free(blockUsedPtr);
        Module._free(blockTotalPtr);
      }
    },

    canFit(path, size) {
      const usage = this.getUsage();
      return usage.freeBytes >= size;
    },

    cleanup() {
      Module._lfs_wasm_unmount();
      Module._lfs_wasm_cleanup();
    },
  };

  return client;
}