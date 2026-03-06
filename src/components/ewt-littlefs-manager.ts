import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Partition } from "../partition.js";
import "./ewt-button";
import "./ewt-textfield";

// 动态导入 LittleFS WASM 模块
let _wasmBasePath: string | null = null;
let _littleFSModule: any = null;

async function loadLittleFS() {
  // 缓存模块以避免重复加载
  if (_littleFSModule) {
    return _littleFSModule;
  }

  // 从当前脚本位置确定 WASM 基础路径
  if (!_wasmBasePath) {
    const scriptUrl = new URL(import.meta.url);
    // 移除文件名以获取目录
    const scriptDir = scriptUrl.href.substring(
      0,
      scriptUrl.href.lastIndexOf("/") + 1,
    );
    _wasmBasePath = scriptDir + "wasm/littlefs/";
  }

  try {
    // 尝试从计算出的路径导入
    const indexUrl = _wasmBasePath + "index.js";
    console.log("[LittleFS] 正在从以下路径加载模块：", indexUrl);
    _littleFSModule = await import(/* @vite-ignore */ indexUrl);
    return _littleFSModule;
  } catch (err) {
    console.error("[LittleFS] 无法从计算路径加载：", _wasmBasePath, err);
    // 回退到相对导入（用于本地开发）
    try {
      _littleFSModule = await import("../wasm/littlefs/index.js");
      return _littleFSModule;
    } catch (fallbackErr) {
      console.error("[LittleFS] 回退导入也失败：", fallbackErr);
      throw new Error(`加载 LittleFS 模块失败：${err}`);
    }
  }
}

@customElement("ewt-littlefs-manager")
export class EwtLittleFSManager extends LitElement {
  @property({ type: Object }) partition!: Partition;
  @property({ type: Object }) espStub: any;
  @property({ type: Function }) logger: any = console;
  @property({ type: Function }) onClose?: () => void;

  @state() private _currentPath = "/";
  @state() private _files: any[] = [];
  @state() private _fs: any = null;
  @state() private _blockSize = 4096;
  @state() private _usage = { capacityBytes: 0, usedBytes: 0, freeBytes: 0 };
  @state() private _diskVersion = "";
  @state() private _busy = false;
  @state() private _selectedFile: File | null = null;
  @state() private _flashProgress = 0; // 0-100 刷写进度
  @state() private _isFlashing = false;
  @state() private _flashOperation: "reading" | "writing" | null = null; // 跟踪操作类型

  async connectedCallback() {
    super.connectedCallback();
    this.logger.log("LittleFS 管理器：connectedCallback 被调用");
    await this._openFilesystem();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  private async _openFilesystem() {
    try {
      this._busy = true;
      this._isFlashing = true;
      this._flashProgress = 0;
      this._flashOperation = "reading";

      this.logger.log(
        `正在读取 LittleFS 分区 "${this.partition.name}" (${this._formatSize(this.partition.size)})...`,
      );

      if (!this.espStub.IS_STUB) {
        throw new Error("ESP 存根加载器未运行。无法读取闪存。");
      }

      // 读取整个分区，带进度回调
      const data = await this.espStub.readFlash(
        this.partition.offset,
        this.partition.size,
        (_packet: Uint8Array, progress: number, totalSize: number) => {
          const progressPercent = Math.floor((progress / totalSize) * 100);
          this._flashProgress = progressPercent;
        },
      );

      if (data.length === 0) {
        throw new Error("从分区读取 0 字节");
      }

      this.logger.log("正在挂载 LittleFS 文件系统...");

      // 动态加载 LittleFS 模块
      const { createLittleFSFromImage, formatDiskVersion } =
        await loadLittleFS();

      // 尝试使用不同的块大小挂载
      const blockSizes = [4096, 2048, 1024, 512];
      let fs = null;
      let blockSize = 0;

      for (const bs of blockSizes) {
        try {
          const blockCount = Math.floor(this.partition.size / bs);

          // 如果可用，传递 WASM URL
          const options: any = {
            blockSize: bs,
            blockCount: blockCount,
          };

          if (_wasmBasePath) {
            options.wasmURL = new URL("littlefs.wasm", _wasmBasePath).href;
          }

          fs = await createLittleFSFromImage(data, options);

          // 尝试列出根目录以验证其工作
          fs.list("/");
          blockSize = bs;
          this.logger.log(`已成功使用块大小 ${bs} 挂载 LittleFS`);
          break;
        } catch (err) {
          // 尝试下一个块大小
          fs = null;
        }
      }

      if (!fs) {
        throw new Error("无法使用任何块大小挂载 LittleFS");
      }

      this._fs = fs;
      this._blockSize = blockSize;

      // 获取磁盘版本
      try {
        const diskVer = fs.getDiskVersion();
        if (diskVer && diskVer !== 0) {
          this._diskVersion = formatDiskVersion(diskVer);
        } else {
          this._diskVersion = "未知";
        }
      } catch (e: any) {
        this._diskVersion = "未知";
      }

      this._refreshFiles();
      this.logger.log("LittleFS 文件系统成功打开");
    } catch (e: any) {
      this.logger.error(`打开 LittleFS 失败：${e.message || e}`);
      if (this.onClose) {
        this.onClose();
      }
    } finally {
      this._busy = false;
      this._isFlashing = false;
      this._flashProgress = 0;
      this._flashOperation = null;
    }
  }

  private _refreshFiles() {
    if (!this._fs) {
      return;
    }

    try {
      // 计算使用量
      const allFiles = this._fs.list("/");
      const usedBytes = this._estimateUsage(allFiles);
      const totalBytes = this.partition.size;

      this._usage = {
        capacityBytes: totalBytes,
        usedBytes: usedBytes,
        freeBytes: totalBytes - usedBytes,
      };

      // 列出当前目录中的文件
      const entries = this._fs.list(this._currentPath);

      // 排序：目录优先，然后文件
      entries.sort((a: any, b: any) => {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.path.localeCompare(b.path);
      });

      this._files = entries;
    } catch (e: any) {
      this.logger.error(`刷新文件列表失败：${e.message || e}`);
      this._files = [];
    }
  }

  private _estimateUsage(entries: any[]): number {
    const block = this._blockSize || 4096;
    let total = block * 2; // 根元数据副本

    for (const entry of entries || []) {
      if (entry.type === "dir") {
        total += block;
      } else {
        const dataBytes =
          Math.max(1, Math.ceil((entry.size || 0) / block)) * block;
        const metadataBytes = block;
        total += dataBytes + metadataBytes;
      }
    }

    return total;
  }

  private _formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    } else {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
  }

  private _navigateUp() {
    if (this._currentPath === "/" || !this._currentPath) return;

    const parts = this._currentPath.split("/").filter(Boolean);
    parts.pop();
    this._currentPath = "/" + parts.join("/");
    if (this._currentPath !== "/" && !this._currentPath.endsWith("/")) {
      this._currentPath += "/";
    }
    this._refreshFiles();
  }

  private _navigateTo(path: string) {
    this._currentPath = path;
    this._refreshFiles();
  }

  private async _uploadFile() {
    if (!this._fs || !this._selectedFile) return;

    try {
      this._busy = true;
      this.logger.log(`正在上传文件 "${this._selectedFile.name}"...`);

      const data = await this._selectedFile.arrayBuffer();
      const uint8Data = new Uint8Array(data);

      // 构造目标路径
      let targetPath = this._currentPath;
      if (!targetPath.endsWith("/")) targetPath += "/";
      targetPath += this._selectedFile.name;

      // 确保父目录存在
      const segments = targetPath.split("/").filter(Boolean);
      if (segments.length > 1) {
        let built = "";
        for (let i = 0; i < segments.length - 1; i++) {
          built += `/${segments[i]}`;
          try {
            this._fs.mkdir(built);
          } catch (e) {
            // 如果目录已存在，忽略
          }
        }
      }

      // 写入文件
      if (typeof this._fs.writeFile === "function") {
        this._fs.writeFile(targetPath, uint8Data);
      } else if (typeof this._fs.addFile === "function") {
        this._fs.addFile(targetPath, uint8Data);
      }

      // 通过读回验证
      const readBack = this._fs.readFile(targetPath);
      this.logger.log(
        `✓ 文件已写入：${readBack.length} 字节，位于 ${targetPath}`,
      );

      // 清空输入
      const uploadedFileName = this._selectedFile.name;
      this._selectedFile = null;
      this._refreshFiles();

      this.logger.log(`文件 "${uploadedFileName}" 上传成功`);
    } catch (e: any) {
      this.logger.error(`上传文件失败：${e.message || e}`);
    } finally {
      this._busy = false;
    }
  }

  private _createFolder() {
    if (!this._fs) return;

    const dirName = prompt("输入目录名称：");
    if (!dirName || !dirName.trim()) return;

    try {
      let targetPath = this._currentPath;
      if (!targetPath.endsWith("/")) targetPath += "/";
      targetPath += dirName.trim();

      this._fs.mkdir(targetPath);
      this._refreshFiles();

      this.logger.log(`目录 "${dirName}" 创建成功`);
    } catch (e: any) {
      this.logger.error(`创建目录失败：${e.message || e}`);
    }
  }

  private async _downloadFile(path: string) {
    if (!this._fs) return;

    try {
      this.logger.log(`正在下载文件 "${path}"...`);

      const data = this._fs.readFile(path);
      const filename = path.split("/").filter(Boolean).pop() || "file.bin";

      // 创建下载
      const blob = new Blob([data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.logger.log(`文件 "${filename}" 下载成功`);
    } catch (e: any) {
      this.logger.error(`下载文件失败：${e.message || e}`);
    }
  }

  private _deleteFile(path: string, type: string) {
    if (!this._fs) return;

    const name = path.split("/").filter(Boolean).pop() || path;
    const confirmed = confirm(
      `删除 ${type === "dir" ? "目录" : "文件"} "${name}"？`,
    );

    if (!confirmed) return;

    try {
      if (type === "dir") {
        this._fs.delete(path, { recursive: true });
      } else {
        this._fs.deleteFile(path);
      }

      this._refreshFiles();
      this.logger.log(`${type === "dir" ? "目录" : "文件"} "${name}" 删除成功`);
    } catch (e: any) {
      this.logger.error(`删除 ${type} 失败：${e.message || e}`);
    }
  }

  private async _backupImage() {
    if (!this._fs) return;

    try {
      this.logger.log("正在创建 LittleFS 备份镜像...");
      const image = this._fs.toImage();

      const filename = `${this.partition.name}_littlefs_backup.bin`;

      // 创建下载
      const blob = new Blob([image], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.logger.log(`LittleFS 备份已保存为 "${filename}"`);
    } catch (e: any) {
      this.logger.error(`备份 LittleFS 失败：${e.message || e}`);
    }
  }

  private async _writeToFlash() {
    if (!this._fs) return;

    const confirmed = confirm(
      `将修改后的 LittleFS 写入闪存？\n\n` +
        `分区：${this.partition.name}\n` +
        `偏移量：0x${this.partition.offset.toString(16)}\n` +
        `大小：${this._formatSize(this.partition.size)}\n\n` +
        `这将覆盖设备上的当前文件系统！`,
    );

    if (!confirmed) return;

    try {
      this._busy = true;
      this._isFlashing = true;
      this._flashProgress = 0;
      this._flashOperation = "writing"; // 设置操作类型

      this.logger.log("正在创建 LittleFS 镜像...");
      const image = this._fs.toImage();
      this.logger.log(`镜像已创建：${this._formatSize(image.length)}`);

      if (image.length > this.partition.size) {
        this.logger.error(
          `镜像大小 (${this._formatSize(image.length)}) 超过分区大小 (${this._formatSize(this.partition.size)})`,
        );
        return;
      }

      this.logger.log(
        `正在将 ${this._formatSize(image.length)} 写入分区 "${this.partition.name}"，偏移量 0x${this.partition.offset.toString(16)}...`,
      );

      // 将 Uint8Array 转换为 ArrayBuffer
      const imageBuffer = image.buffer.slice(
        image.byteOffset,
        image.byteOffset + image.byteLength,
      );

      // 将镜像写入闪存，带进度回调
      await this.espStub.flashData(
        imageBuffer,
        (bytesWritten: number, totalBytes: number) => {
          const percent = Math.floor((bytesWritten / totalBytes) * 100);
          this._flashProgress = percent;
        },
        this.partition.offset,
      );

      this.logger.log(`✓ LittleFS 成功写入闪存！`);
      this.logger.log(`要使用新的文件系统，请重置您的设备。`);
    } catch (e: any) {
      this.logger.error(`写入 LittleFS 到闪存失败：${e.message || e}`);
    } finally {
      this._busy = false;
      this._isFlashing = false;
      this._flashProgress = 0;
      this._flashOperation = null;
    }
  }

  private _cleanup() {
    if (this._fs) {
      try {
        // 不调用 destroy() - 让垃圾回收处理它
      } catch (e) {
        console.error("清理 LittleFS 时出错：", e);
      }
      this._fs = null;
    }
  }

  private _handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    this._selectedFile = input.files?.[0] || null;
  }

  render() {
    const usedPercent = Math.round(
      (this._usage.usedBytes / this._usage.capacityBytes) * 100,
    );

    return html`
      <div class="littlefs-manager">
        <h3>LittleFS 文件系统管理器</h3>

        <div class="littlefs-info">
          <div class="littlefs-partition-info">
            <strong>分区：</strong> ${this.partition.name}
            <span class="littlefs-size"
              >(${this._formatSize(this.partition.size)})</span
            >
          </div>
          <div class="littlefs-usage">
            <div class="usage-bar">
              <div
                class="usage-fill ${this._isFlashing ? "flashing" : ""}"
                style="width: ${this._isFlashing
                  ? this._flashProgress
                  : usedPercent}%"
              ></div>
            </div>
            <div class="usage-text">
              ${this._isFlashing
                ? html`<span class="flash-status">
                    ⚡
                    ${this._flashOperation === "reading"
                      ? "正在从闪存读取"
                      : "正在写入闪存"}
                    ：${this._flashProgress}%
                  </span>`
                : html`<span
                      >已用：${this._formatSize(this._usage.usedBytes)} /
                      ${this._formatSize(this._usage.capacityBytes)}
                      (${usedPercent}%)</span
                    >
                    ${this._diskVersion
                      ? html`<span class="disk-version"
                          >${this._diskVersion}</span
                        >`
                      : ""}`}
            </div>
          </div>
        </div>

        <div class="littlefs-controls">
          <ewt-button
            label="刷新"
            @click=${this._refreshFiles}
            ?disabled=${this._busy}
          ></ewt-button>
          <ewt-button
            label="备份镜像"
            @click=${this._backupImage}
            ?disabled=${this._busy}
          ></ewt-button>
          <ewt-button
            label="写入闪存"
            @click=${this._writeToFlash}
            ?disabled=${this._busy}
          ></ewt-button>
          <ewt-button
            label="关闭"
            @click=${() => {
              this._cleanup();
              if (this.onClose) this.onClose();
            }}
            ?disabled=${this._busy}
          ></ewt-button>
        </div>

        <div class="littlefs-breadcrumb">
          <ewt-button
            label="↑ 上一级"
            @click=${this._navigateUp}
            ?disabled=${this._currentPath === "/" || this._busy}
          ></ewt-button>
          <span>${this._currentPath || "/"}</span>
        </div>

        <div class="littlefs-file-upload">
          <input
            type="file"
            @change=${this._handleFileSelect}
            ?disabled=${this._busy}
          />
          <ewt-button
            label="上传文件"
            @click=${this._uploadFile}
            ?disabled=${!this._selectedFile || this._busy}
          ></ewt-button>
          <ewt-button
            label="新建文件夹"
            @click=${this._createFolder}
            ?disabled=${this._busy}
          ></ewt-button>
        </div>

        <div class="littlefs-files">
          <table class="file-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>大小</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${this._files.length === 0
                ? html`
                    <tr>
                      <td colspan="4" class="empty-state">此目录中没有文件</td>
                    </tr>
                  `
                : this._files.map(
                    (entry) => html`
                      <tr>
                        <td>
                          <div
                            class="file-name ${entry.type === "dir"
                              ? "clickable"
                              : ""}"
                            @click=${entry.type === "dir"
                              ? () => this._navigateTo(entry.path)
                              : null}
                          >
                            <span class="file-icon"
                              >${entry.type === "dir" ? "📁" : "📄"}</span
                            >
                            <span
                              >${entry.path.split("/").filter(Boolean).pop() ||
                              "/"}</span
                            >
                          </div>
                        </td>
                        <td>${entry.type === "dir" ? "目录" : "文件"}</td>
                        <td>
                          ${entry.type === "file"
                            ? this._formatSize(entry.size)
                            : "-"}
                        </td>
                        <td>
                          <div class="file-actions">
                            ${entry.type === "file"
                              ? html`
                                  <ewt-button
                                    label="下载"
                                    @click=${() =>
                                      this._downloadFile(entry.path)}
                                    ?disabled=${this._busy}
                                  ></ewt-button>
                                `
                              : ""}
                            <ewt-button
                              class="danger"
                              label="删除"
                              @click=${() =>
                                this._deleteFile(entry.path, entry.type)}
                              ?disabled=${this._busy}
                            ></ewt-button>
                          </div>
                        </td>
                      </tr>
                    `,
                  )}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }

    .littlefs-manager {
      width: 100%;
      max-width: 100%;
      margin: 0 auto;
      padding: 15px;
      border: 2px solid var(--mdc-theme-primary, #03a9f4);
      border-radius: 10px;
      background-color: rgba(3, 169, 244, 0.05);
      box-sizing: border-box;
    }

    h3 {
      margin: 0 0 15px 0;
      color: var(--mdc-theme-primary, #03a9f4);
      font-size: 18px;
      font-weight: 600;
    }

    .littlefs-info {
      margin-bottom: 15px;
      padding: 12px;
      background-color: rgba(255, 255, 255, 0.5);
      border-radius: 8px;
    }

    .littlefs-partition-info {
      margin-bottom: 10px;
      font-size: 13px;
    }

    .littlefs-size {
      color: #666;
      margin-left: 8px;
    }

    .littlefs-usage {
      margin-top: 8px;
    }

    .usage-bar {
      width: 100%;
      height: 18px;
      background-color: #e0e0e0;
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 6px;
    }

    .usage-fill {
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--mdc-theme-primary, #03a9f4) 0%,
        var(--mdc-theme-primary, #03a9f4) 100%
      );
      transition: width 0.3s ease;
    }

    .usage-fill.flashing {
      background: linear-gradient(90deg, #ff9800 0%, #ff5722 100%);
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }

    .flash-status {
      font-weight: 600;
      color: #ff5722;
    }

    .usage-text {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #555;
      flex-wrap: wrap;
      gap: 5px;
    }

    .disk-version {
      font-size: 11px;
      padding: 2px 6px;
      background-color: var(--mdc-theme-primary, #03a9f4);
      color: white;
      border-radius: 4px;
    }

    .littlefs-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }

    .littlefs-breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      padding: 8px;
      background-color: rgba(255, 255, 255, 0.5);
      border-radius: 8px;
    }

    .littlefs-breadcrumb span {
      font-family: monospace;
      font-size: 13px;
      color: #333;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .littlefs-file-upload {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .littlefs-file-upload input[type="file"] {
      flex: 1;
      min-width: 150px;
      padding: 4px;
      border: 2px solid #ccc;
      border-radius: 8px;
      font-size: 13px;
    }

    .littlefs-files {
      max-height: 350px;
      overflow-y: auto;
      overflow-x: auto;
      border: 1px solid #ccc;
      border-radius: 8px;
    }

    .file-table {
      width: 100%;
      min-width: 500px;
      border-collapse: collapse;
    }

    .file-table thead {
      position: sticky;
      top: 0;
      background-color: #f5f5f5;
      z-index: 10;
    }

    .file-table th {
      padding: 8px;
      text-align: left;
      font-weight: 600;
      border-bottom: 2px solid #ccc;
    }

    .file-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #e0e0e0;
    }

    .file-table tbody tr:hover {
      background-color: rgba(3, 169, 244, 0.1);
    }

    .file-table .empty-state {
      text-align: center;
      color: #999;
      padding: 30px;
      font-style: italic;
    }

    .file-name {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .file-name.clickable {
      cursor: pointer;
    }

    .file-name.clickable:hover {
      color: var(--mdc-theme-primary, #03a9f4);
      text-decoration: underline;
    }

    .file-icon {
      font-size: 16px;
    }

    .file-actions {
      display: flex;
      gap: 5px;
    }

    .danger {
      --mdc-theme-primary: var(--improv-danger-color, #db4437);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ewt-littlefs-manager": EwtLittleFSManager;
  }
}
