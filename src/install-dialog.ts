import { LitElement, html, PropertyValues, css, TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import "./components/ewt-button";
import "./components/ewt-checkbox";
import "./components/ewt-console";
import "./components/ewt-dialog";
import "./components/ewt-formfield";
import "./components/ewt-icon-button";
import "./components/ewt-textfield";
import type { EwtTextfield } from "./components/ewt-textfield";
import "./components/ewt-select";
import "./components/ewt-list-item";
import "./components/ewt-littlefs-manager";
import "./pages/ewt-page-progress";
import "./pages/ewt-page-message";
import { chipIcon, closeIcon, firmwareIcon } from "./components/svg";
import { Logger, Manifest, FlashStateType, FlashState } from "./const.js";
import { ImprovSerial, Ssid } from "improv-wifi-serial-sdk/dist/serial";
import {
  ImprovSerialCurrentState,
  ImprovSerialErrorState,
} from "improv-wifi-serial-sdk/dist/const";
import { flash } from "./flash";
import { textDownload } from "./util/file-download";
import { fireEvent } from "./util/fire-event";
import { sleep } from "./util/sleep";
import { downloadManifest } from "./util/manifest";
import { dialogStyles } from "./styles";
import { parsePartitionTable, type Partition } from "./partition.js";
import { detectFilesystemType } from "./util/partition.js";
import { getChipFamilyName } from "./util/chip-family-name";

const ERROR_ICON = "⚠️";
const OK_ICON = "🎉";

export class EwtInstallDialog extends LitElement {
  public esploader!: any; // ESPLoader 实例，来自 tasmota-webserial-esptool

  public manifestPath!: string;

  public firmwareFile?: File;

  public baudRate?: number;

  public logger: Logger = console;

  public overrides?: {
    checkSameFirmware?: (
      manifest: Manifest,
      deviceImprov: ImprovSerial["info"],
    ) => boolean;
  };

  private _manifest!: Manifest;

  private _info?: ImprovSerial["info"];

  // null = NOT_SUPPORTED（不支持）
  @state() private _client?: ImprovSerial | null;

  @state() private _state:
    | "ERROR"
    | "DASHBOARD"
    | "PROVISION"
    | "INSTALL"
    | "ASK_ERASE"
    | "LOGS"
    | "PARTITIONS"
    | "LITTLEFS"
    | "REQUEST_PORT_SELECTION" = "DASHBOARD";

  @state() private _installErase = false;
  @state() private _installConfirmed = false;
  @state() private _installState?: FlashState;

  @state() private _provisionForce = false;
  private _wasProvisioned = false;

  @state() private _error?: string;

  @state() private _busy = true; // 启动时忙碌，直到初始化完成

  // undefined = 未加载
  // null = 不可用
  @state() private _ssids?: Ssid[] | null;

  // SSID名称，null = 其他
  @state() private _selectedSsid: string | null = null;

  // 分区表支持
  @state() private _partitions?: Partition[];
  @state() private _selectedPartition?: Partition;
  @state() private _espStub?: any;

  // 跟踪是否已经检查过Improv（避免重复尝试）
  private _improvChecked = false;

  // 跟踪控制台是否已经打开过一次（避免重复重置）
  private _consoleInitialized = false;

  // 跟踪Improv是否受支持（与活动客户端分开）
  private _improvSupported = false;

  // 跟踪设备是否使用USB-JTAG或USB-OTG（非外部串行芯片）
  @state() private _isUsbJtagOrOtgDevice = false;

  // 跟踪端口重新连接后要执行的操作（用于USB-JTAG/OTG设备）
  private _openConsoleAfterReconnect = false;
  private _visitDeviceAfterReconnect = false;
  private _addToHAAfterReconnect = false;
  private _changeWiFiAfterReconnect = false;

  // 确保存根已初始化（在任何需要它的操作前调用）
  private async _ensureStub(): Promise<any> {
    if (this._espStub && this._espStub.IS_STUB) {
      this.logger.log(
        `现有存根：IS_STUB=${this._espStub.IS_STUB}，芯片系列=${getChipFamilyName(this._espStub)}`,
      );

      // 即使存根已存在，也要确保波特率设置正确
      if (this.baudRate && this.baudRate > 115200) {
        const currentBaud = this._espStub.currentBaudRate || 115200;
        if (currentBaud !== this.baudRate) {
          this.logger.log(`调整波特率从 ${currentBaud} 到 ${this.baudRate}...`);
          try {
            await this._espStub.setBaudrate(this.baudRate);
            this.logger.log(`波特率设置为 ${this.baudRate}`);
            // 更新 currentBaudRate 防止重复设置
            this._espStub.currentBaudRate = this.baudRate;
          } catch (baudErr: any) {
            this.logger.log(
              `设置波特率失败：${baudErr.message}，继续使用当前波特率`,
            );
            // 如果 setBaudrate 失败，假定波特率已正确
            this._espStub.currentBaudRate = this.baudRate;
          }
        } else {
          this.logger.log(`波特率已经是 ${this.baudRate}，跳过设置`);
        }
      }

      return this._espStub;
    }

    // 如果尚未初始化，则初始化
    if (!this.esploader.chipFamily) {
      this.logger.log("初始化 ESP 加载器...");

      // 尝试两次，然后放弃
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt > 1) {
            this.logger.log(`重试第 ${attempt}/2 次...`);
            await sleep(500); // 重试前等待
          }
          await this.esploader.initialize();
          this.logger.log(`发现 ${getChipFamilyName(this.esploader)}`);
          break; // 成功！
        } catch (err: any) {
          this.logger.error(
            `连接到存根失败（尝试 ${attempt}/2）：${err.message}`,
          );
          if (attempt === 2) {
            // 两次尝试都失败 - 向用户显示错误
            this._state = "ERROR";
            this._error = `尝试 2 次后无法连接到 ESP：${err.message}`;
            throw err;
          }
        }
      }
    }

    // 运行存根 - 芯片属性现在自动从父级继承
    this.logger.log("运行存根...");
    const espStub = await this.esploader.runStub();

    this.logger.log(
      `存根已创建：IS_STUB=${espStub.IS_STUB}，芯片系列=${getChipFamilyName(espStub)}`,
    );
    this._espStub = espStub;

    // 在任何操作之前设置波特率（如果用户选择了更高波特率）
    if (this.baudRate && this.baudRate > 115200) {
      this.logger.log(`设置波特率为 ${this.baudRate}...`);
      try {
        // setBaudrate 现在支持 Android 上的 CDC/JTAG（WebUSB）
        await espStub.setBaudrate(this.baudRate);
        this.logger.log(`波特率设置为 ${this.baudRate}`);
        // 更新 currentBaudRate 防止重复设置
        espStub.currentBaudRate = this.baudRate;
      } catch (baudErr: any) {
        this.logger.error(`[DEBUG] setBaudrate() 抛出错误：${baudErr.message}`);
        this.logger.log(`设置波特率失败：${baudErr.message}，继续使用默认值`);
      }
    }

    this.logger.log(
      `返回存根：IS_STUB=${this._espStub.IS_STUB}，芯片系列=${getChipFamilyName(this._espStub)}`,
    );
    return this._espStub;
  }

  // 从 esploader 获取端口的辅助函数
  private get _port(): SerialPort {
    return this.esploader.port;
  }

  // 检查设备是否使用 USB-JTAG 或 USB-OTG（非外部串行芯片）的辅助函数
  private async _isUsbJtagOrOtg(): Promise<boolean> {
    // 使用 tasmota-webserial-esptool 的 detectUsbConnectionType
    const isUsbJtag = await this.esploader.detectUsbConnectionType();
    this.logger.log(`USB-JTAG/OTG 检测：${isUsbJtag ? "是" : "否"}`);
    return isUsbJtag;
  }

  // 检查设备是否为带外部串行芯片的 WebUSB
  private async _isWebUsbWithExternalSerial(): Promise<boolean> {
    const isWebUsb = this.esploader.isWebUSB && this.esploader.isWebUSB();
    if (!isWebUsb) {
      return false;
    }
    const isUsbJtag = await this._isUsbJtagOrOtg();
    const result = !isUsbJtag; // WebUSB 但不是 USB-JTAG = 外部串行
    this.logger.log(`带外部串行的 WebUSB：${result ? "是" : "否"}`);
    return result;
  }

  // 释放 reader/writer 锁的辅助函数（被多个方法使用）
  private async _releaseReaderWriter() {
    // 关键：找到实际拥有 reader 的对象
    // 存根有一个 _parent 指针，reader 在父级上运行！
    let readerOwner = this._espStub || this.esploader;
    if (readerOwner._parent) {
      readerOwner = readerOwner._parent;
      this.logger.log("使用父加载器处理 reader/writer");
    }

    // 在正确的对象上取消 reader
    if (readerOwner._reader) {
      const reader = readerOwner._reader;
      try {
        await reader.cancel();
        this.logger.log("已在正确对象上取消 reader");
      } catch (err) {
        this.logger.log("取消 reader 失败：", err);
      }
      try {
        reader.releaseLock();
        this.logger.log("已释放 reader 锁");
      } catch (err) {
        this.logger.log("reader.releaseLock 失败：", err);
      }
      readerOwner._reader = undefined;
    }

    // 在正确的对象上释放 writer
    if (readerOwner._writer) {
      const writer = readerOwner._writer;
      readerOwner._writer = undefined;

      try {
        writer.releaseLock();
        this.logger.log("已释放 writer 锁");
      } catch (err) {
        this.logger.log("writer.releaseLock 失败：", err);
      }
    }

    // 对于 WebUSB（安卓），总是重新创建流
    // 这对于控制台工作至关重要 - WebUSB 需要全新的流
    // 即使没有持有锁，流也可能被其他操作消耗
    if (this.esploader.isWebUSB && this.esploader.isWebUSB()) {
      try {
        this.logger.log("检测到 WebUSB - 重新创建流");
        await (this._port as any).recreateStreams();
        await sleep(200);
        this.logger.log("WebUSB 流已重新创建并准备就绪");
      } catch (err: any) {
        this.logger.log(`重新创建 WebUSB 流失败：${err.message}`);
      }
    }
  }

  // 将波特率重置为 115200 以供控制台使用的辅助函数
  // ESP 存根可能在较高波特率（如 460800）下用于刷写
  // 固件控制台始终以 115200 运行
  private async _resetBaudrateForConsole() {
    if (this._espStub && this._espStub.currentBaudRate !== 115200) {
      this.logger.log(
        `将波特率从 ${this._espStub.currentBaudRate} 重置为 115200`,
      );
      try {
        // 使用 tasmota-webserial-esptool 的 setBaudrate
        // 现在支持 Android 上 CDC/JTAG 的波特率更改（WebUSB）
        await this._espStub.setBaudrate(115200);
        this.logger.log("已将波特率设置为 115200 供控制台使用");
      } catch (baudErr: any) {
        this.logger.log(`将波特率设置为 115200 失败：${baudErr.message}`);
      }
    }
  }

  // 准备设备进行刷写操作（在 Improv 检查之后）
  // 重置到引导加载器模式并加载存根
  private async _prepareForFlashOperations() {
    // 重置 ESP 到 BOOTLOADER 模式以进行刷写操作
    await this._resetToBootloaderAndReleaseLocks();

    // 等待 ESP 进入引导加载器模式
    await sleep(100);

    // 重置 ESP 状态（如果重置成功，芯片系列保持不变）
    this._espStub = undefined;
    this.esploader.IS_STUB = false;

    // 确保存根已初始化
    await this._ensureStub();

    this.logger.log("ESP 已重置，存根已加载 - 准备进行刷写操作");
  }

  // 处理刷写完成后的清理和 Improv 重新初始化
  // 当刷写操作成功完成时调用
  private async _handleFlashComplete() {
    // 检查这是否是 USB-JTAG 或 USB-OTG 设备（非外部串行芯片）
    const isUsbJtagOrOtg = await this._isUsbJtagOrOtg();
    this._isUsbJtagOrOtgDevice = isUsbJtagOrOtg; // 更新 UI 状态

    if (isUsbJtagOrOtg) {
      // 对于 USB-JTAG/OTG 设备：重置到固件模式（端口将改变！）
      // 然后用户必须选择新端口（用户手势），我们测试 Improv
      this.logger.log("USB-JTAG/OTG 设备 - 重置到固件模式");

      // 关键：在调用 resetToFirmware() 之前释放锁
      await this._releaseReaderWriter();

      // 关键：忘记旧端口，以免浏览器在选择中显示它
      try {
        await this._port.forget();
        this.logger.log("已忘记旧端口");
      } catch (forgetErr: any) {
        this.logger.log(`忘记端口失败：${forgetErr.message}`);
      }

      try {
        // 使用 resetToFirmware() 方法关闭端口，设备将重启到固件
        await this.esploader.resetToFirmware();
        this.logger.log("设备已重置到固件模式 - 端口已关闭");
      } catch (err: any) {
        this.logger.debug(`重置到固件错误（预期内）：${err.message}`);
      }

      // 重置 ESP 状态
      await sleep(100);

      this._espStub = undefined;
      this.esploader.IS_STUB = false;
      this.esploader.chipFamily = null;
      this._improvChecked = false; // 用户重新连接后将检查
      this._client = null; // 设为 null（不是 undefined）以避免显示“收尾”UI 状态
      this._improvSupported = false; // 重新连接前未知
      this.esploader._reader = undefined;

      this.logger.log("刷写完成 - 等待用户选择新端口");

      // 关键：将状态设置为 REQUEST_PORT_SELECTION 以显示“选择端口”按钮
      this._state = "REQUEST_PORT_SELECTION";
      this._error = "";
      this.requestUpdate();
      return;
    }

    // 非 USB-JTAG/OTG 设备的正常流程
    // 释放锁并重置 ESP 状态以进行 Improv 测试
    await this._releaseReaderWriter();

    // 重置 ESP 状态以进行 Improv 测试
    this._espStub = undefined;
    this.esploader.IS_STUB = false;
    this.esploader.chipFamily = null;
    this._improvChecked = false;
    this.esploader._reader = undefined;
    this.logger.log("ESP 状态已重置，准备进行 Improv 测试");

    // 以 115200 波特重新连接，并重置 ESP 以启动新固件
    try {
      // 关键：在较高波特率下刷写后，以 115200 重新连接
      // reconnectToBootloader() 会关闭端口并以 115200 波特重新打开
      // 它现在会自动检测 WebUSB 与 WebSerial，并使用适当的方法
      this.logger.log("以 115200 波特重新连接以进行固件重置...");
      try {
        await this.esploader.reconnectToBootloader();
        this.logger.log("端口已以 115200 波特重新连接");
      } catch (reconnectErr: any) {
        this.logger.log(`重新连接失败：${reconnectErr.message}`);
      }

      // 重置设备并释放锁以确保新固件的干净状态
      // 使用芯片特定的重置方法（S2/S3/C3 带 USB-JTAG 使用看门狗）
      this.logger.log("执行硬件重置以启动新固件...");
      await this._resetDeviceAndReleaseLocks();
    } catch (resetErr: any) {
      this.logger.log(`硬件重置失败：${resetErr.message}`);
    }

    // 测试新固件的 Improv
    await this._initialize(true);

    this.requestUpdate();
  }

  // 重置设备并释放锁 - 用于返回仪表板或从错误中恢复
  // 将设备重置为 FIRMWARE 模式（正常执行）
  private async _resetDeviceAndReleaseLocks() {
    // 找到实际拥有 reader/writer 的对象
    let readerOwner = this._espStub || this.esploader;
    if (readerOwner._parent) {
      readerOwner = readerOwner._parent;
      this.logger.log("使用父加载器处理 reader/writer");
    }

    // 在释放锁之前调用 hardReset（以便它能通信）
    try {
      await this.esploader.hardReset(false);
      this.logger.log("已发送设备重置");
    } catch (err) {
      this.logger.log("重置错误（预期内）：", err);
    }

    // 等待重置完成
    await sleep(500);

    // 现在在重置后释放锁
    await this._releaseReaderWriter();
    this.logger.log("设备已重置到固件模式");

    // 重置 ESP 状态
    this._espStub = undefined;
    this.esploader.IS_STUB = false;
    this.esploader.chipFamily = null;
  }

  // 将设备重置为 BOOTLOADER 模式（用于刷写）
  // 使用 ESPLoader 的 reconnectToBootloader() 来正确关闭/重新打开端口
  private async _resetToBootloaderAndReleaseLocks() {
    // 使用 ESPLoader 的 reconnectToBootloader() - 它处理：
    // - 完全关闭端口（释放所有锁）
    // - 以 115200 波特重新打开端口
    // - 重启 readLoop()
    // - 进入引导加载器的重置策略（connectWithResetStrategies）
    // - 芯片检测
    // - WebUSB 与 WebSerial 检测及适当的重置方法
    try {
      this.logger.log("将 ESP 重置到引导加载器模式...");
      await this.esploader.reconnectToBootloader();
      this.logger.log(
        `ESP 处于引导加载器模式：${getChipFamilyName(this.esploader)}`,
      );
    } catch (err: any) {
      this.logger.error(`将 ESP 重置到引导加载器失败：${err.message}`);
      throw err;
    }

    // 重置存根状态（reconnectToBootloader 会保留芯片系列）
    this._espStub = undefined;
    this.esploader.IS_STUB = false;
  }

  protected render() {
    if (!this.esploader) {
      return html``;
    }

    // 安全检查：在 Improv 检查完成之前不渲染 DASHBOARD 状态
    if (this._state === "DASHBOARD" && !this._improvChecked) {
      return html`
        <ewt-dialog open .heading=${"连接中"} scrimClickAction>
          ${this._renderProgress("初始化")}
        </ewt-dialog>
      `;
    }

    let heading: string | undefined;
    let content: TemplateResult;
    let hideActions = false;
    let allowClosing = false;

    // 在安装阶段，我们暂时移除客户端
    if (
      this._client === undefined &&
      !this._improvChecked && // 只有尚未检查时才显示“连接中”
      this._state !== "INSTALL" &&
      this._state !== "LOGS" &&
      this._state !== "PARTITIONS" &&
      this._state !== "LITTLEFS" &&
      this._state !== "REQUEST_PORT_SELECTION" &&
      this._state !== "DASHBOARD" // 在 DASHBOARD 状态时不显示“连接中”
    ) {
      if (this._error) {
        [heading, content, hideActions] = this._renderError(this._error);
      } else {
        content = this._renderProgress("连接中");
        hideActions = true;
      }
    } else if (this._state === "INSTALL") {
      [heading, content, hideActions, allowClosing] = this._renderInstall();
    } else if (this._state === "REQUEST_PORT_SELECTION") {
      [heading, content, hideActions] = this._renderRequestPortSelection();
    } else if (this._state === "ASK_ERASE") {
      [heading, content] = this._renderAskErase();
    } else if (this._state === "ERROR") {
      [heading, content, hideActions] = this._renderError(this._error!);
    } else if (this._state === "DASHBOARD") {
      try {
        [heading, content, hideActions, allowClosing] =
          this._improvSupported && this._info
            ? this._renderDashboard()
            : this._renderDashboardNoImprov();
      } catch (err: any) {
        this.logger.error(`渲染仪表板时出错：${err.message}`, err);
        [heading, content, hideActions] = this._renderError(
          `仪表板渲染错误：${err.message}`,
        );
      }
    } else if (this._state === "PROVISION") {
      [heading, content, hideActions] = this._renderProvision();
    } else if (this._state === "LOGS") {
      [heading, content, hideActions] = this._renderLogs();
    } else if (this._state === "PARTITIONS") {
      [heading, content, hideActions] = this._renderPartitions();
    } else if (this._state === "LITTLEFS") {
      [heading, content, hideActions, allowClosing] = this._renderLittleFS();
    } else {
      // 未知状态的回退
      this.logger.error(`未知状态：${this._state}`);
      [heading, content, hideActions] = this._renderError(
        `未知状态：${this._state}`,
      );
    }

    return html`
      <ewt-dialog
        open
        .heading=${heading!}
        scrimClickAction
        @closed=${this._handleClose}
        .hideActions=${hideActions}
      >
        ${heading && allowClosing
          ? html`
              <ewt-icon-button dialogAction="close">
                ${closeIcon}
              </ewt-icon-button>
            `
          : ""}
        ${content!}
      </ewt-dialog>
    `;
  }

  _renderProgress(label: string | TemplateResult, progress?: number) {
    return html`
      <ewt-page-progress
        .label=${label}
        .progress=${progress}
      ></ewt-page-progress>
    `;
  }

  _renderError(label: string): [string, TemplateResult, boolean] {
    const heading = "错误";
    const content = html`
      <ewt-page-message .icon=${ERROR_ICON} .label=${label}></ewt-page-message>
      <ewt-button
        slot="primaryAction"
        dialogAction="ok"
        label="关闭"
      ></ewt-button>
    `;
    const hideActions = false;
    return [heading, content, hideActions];
  }

  _renderRequestPortSelection(): [string, TemplateResult, boolean] {
    const heading = "选择端口";
    const content = html`
      <ewt-page-message
        .label=${"设备已重置为固件模式。USB 端口已更改。请点击下方按钮选择新端口。"}
      ></ewt-page-message>
      <ewt-button
        slot="primaryAction"
        label="选择端口"
        ?disabled=${this._busy}
        @click=${this._handleSelectNewPort}
      ></ewt-button>
    `;
    const hideActions = false;
    return [heading, content, hideActions];
  }

  _renderDashboard(): [string, TemplateResult, boolean, boolean] {
    const heading = this._info!.name;
    let content: TemplateResult;
    let hideActions = true;
    let allowClosing = true;

    content = html`
      <div class="table-row">
        ${firmwareIcon}
        <div>${this._info!.firmware}&nbsp;${this._info!.version}</div>
      </div>
      <div class="table-row last">
        ${chipIcon}
        <div>${this._info!.chipFamily}</div>
      </div>
      <div class="dashboard-buttons">
        ${!this._isSameVersion
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  text-left
                  .label=${!this._isSameFirmware
                    ? `安装 ${this._manifest.name}`
                    : `更新 ${this._manifest.name}`}
                  @click=${() => {
                    if (this._isSameFirmware) {
                      this._startInstall(false);
                    } else if (this._manifest.new_install_prompt_erase) {
                      this._state = "ASK_ERASE";
                    } else {
                      this._startInstall(true);
                    }
                  }}
                ></ewt-button>
              </div>
            `
          : ""}
        ${!this._client || this._client.nextUrl === undefined
          ? ""
          : html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  label="访问设备"
                  @click=${async () => {
                    this._busy = true;

                    // 如果需要，切换到固件模式
                    const needsReconnect =
                      await this._switchToFirmwareMode("visit");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    // 设备处于固件模式 - 打开 URL
                    if (this._client && this._client.nextUrl) {
                      window.open(this._client.nextUrl, "_blank");
                    }
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `}
        ${!this._client ||
        !this._manifest.home_assistant_domain ||
        this._client.state !== ImprovSerialCurrentState.PROVISIONED
          ? ""
          : html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  label="添加到 Home Assistant"
                  @click=${async () => {
                    this._busy = true;

                    // 如果需要，切换到固件模式
                    const needsReconnect =
                      await this._switchToFirmwareMode("homeassistant");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    // 设备处于固件模式 - 打开 HA URL
                    if (this._manifest.home_assistant_domain) {
                      window.open(
                        `https://my.home-assistant.io/redirect/config_flow_start/?domain=${this._manifest.home_assistant_domain}`,
                        "_blank",
                      );
                    }
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `}
        ${this._client
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  .label=${this._client.state === ImprovSerialCurrentState.READY
                    ? "连接到 Wi-Fi"
                    : "更改 Wi-Fi"}
                  @click=${async () => {
                    this._busy = true;

                    // 如果需要，切换到固件模式
                    const needsReconnect =
                      await this._switchToFirmwareMode("wifi");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    // 设备处于固件模式
                    this.logger.log("设备正在运行固件，用于 Wi-Fi 设置");

                    // 关闭 Improv 客户端并重新初始化以进行 Wi-Fi 设置
                    if (this._client) {
                      try {
                        await this._closeClientWithoutEvents(this._client);
                        this.logger.log("Improv 客户端已关闭");
                      } catch (e) {
                        this.logger.log("关闭 Improv 客户端失败：", e);
                      }
                      this._client = undefined;

                      // 等待端口完全释放
                      await sleep(500);
                    }

                    // 不同类型设备的处理：
                    // - WebSerial：只释放锁
                    // - WebUSB CDC：释放锁，hardReset，再次释放锁
                    // - WebUSB 外部串行：只释放锁
                    const isWebUsbExternal =
                      await this._isWebUsbWithExternalSerial();
                    const isWebUsbCdc =
                      this.esploader.isWebUSB &&
                      this.esploader.isWebUSB() &&
                      !isWebUsbExternal;

                    if (isWebUsbCdc) {
                      // WebUSB CDC 需要 hardReset 以确保固件正在运行
                      this.logger.log(
                        "WebUSB CDC：重置设备以进行 Wi-Fi 设置...",
                      );

                      try {
                        // 在重置前释放锁
                        await this._releaseReaderWriter();

                        // 重置设备
                        await this.esploader.hardReset(false);
                        this.logger.log("设备重置完成");

                        // 关键：hardReset 消耗流，重新创建它们
                        await this._releaseReaderWriter();
                        this.logger.log("重置后已重新创建流");

                        // 等待设备启动
                        await sleep(500);
                      } catch (err: any) {
                        this.logger.log(`重置错误：${err.message}`);
                      }
                    } else {
                      // WebSerial 或 WebUSB 外部串行：只释放锁
                      if (isWebUsbExternal) {
                        this.logger.log(
                          "WebUSB 外部串行：准备端口以进行 Wi-Fi 设置...",
                        );
                      } else {
                        this.logger.log(
                          "WebSerial：准备端口以进行 Wi-Fi 设置...",
                        );
                      }

                      await this._releaseReaderWriter();
                      await sleep(500);
                    }

                    this.logger.log("端口已准备好用于新的 Improv 客户端");

                    // 关键：再次重新创建流以刷新任何缓冲的固件输出
                    // 固件调试消息可能会干扰 Improv 协议
                    this.logger.log("在 Improv 初始化前刷新串行缓冲区...");
                    await this._releaseReaderWriter();
                    await sleep(100);

                    // 重新创建 Improv 客户端（固件以 115200 波特运行）
                    const client = new ImprovSerial(this._port, this.logger);
                    client.addEventListener("state-changed", () => {
                      this.requestUpdate();
                    });
                    client.addEventListener("error-changed", () =>
                      this.requestUpdate(),
                    );
                    try {
                      // 使用 10 秒超时，允许设备获取 IP 地址
                      this._info = await client.initialize(10000);
                      this._client = client;
                      client.addEventListener(
                        "disconnect",
                        this._handleDisconnect,
                      );
                      this.logger.log("Improv 客户端已准备好进行 Wi-Fi 配置");
                    } catch (improvErr: any) {
                      try {
                        await this._closeClientWithoutEvents(client);
                      } catch (closeErr) {
                        this.logger.log(
                          "初始化错误后关闭 Improv 客户端失败：",
                          closeErr,
                        );
                      }

                      // 关键：在 Improv 初始化失败后重新创建流
                      try {
                        await this._releaseReaderWriter();
                        this.logger.log("Improv 失败后已重新创建流");
                      } catch (releaseErr: any) {
                        this.logger.log(
                          `重新创建流失败：${releaseErr.message}`,
                        );
                      }

                      this.logger.log(
                        `Improv 初始化失败：${improvErr.message}`,
                      );
                      this._error = `Improv 初始化失败：${improvErr.message}`;
                      this._state = "ERROR";
                      this._busy = false;
                      return;
                    }

                    this._state = "PROVISION";
                    this._provisionForce = true;
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `
          : ""}
        ${this._isUsbJtagOrOtgDevice
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  label="打开控制台"
                  @click=${async () => {
                    this._busy = true;

                    // 如果活动，关闭 Improv 客户端
                    if (this._client) {
                      try {
                        await this._closeClientWithoutEvents(this._client);
                      } catch (e) {
                        this.logger.log("关闭 Improv 客户端失败：", e);
                      }
                    }

                    // 如果需要，切换到固件模式
                    const needsReconnect =
                      await this._switchToFirmwareMode("console");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    // 设备已处于固件模式
                    this.logger.log(
                      "为 USB-JTAG/OTG 设备打开控制台（固件模式）",
                    );

                    this._state = "LOGS";
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `
          : ""}
        ${!this._isUsbJtagOrOtgDevice
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  label="日志和控制台"
                  @click=${async () => {
                    const client = this._client;
                    if (client) {
                      await this._closeClientWithoutEvents(client);
                    }

                    // 切换到固件模式以使用控制台
                    await this._switchToFirmwareMode("console");

                    this._state = "LOGS";
                  }}
                ></ewt-button>
              </div>
            `
          : ""}
        <div>
          <ewt-button
            ?disabled=${this._busy}
            label="管理文件系统"
            @click=${async () => {
              // 文件系统管理需要引导加载器模式
              // 如果活动，关闭 Improv 客户端（它会锁定 reader）
              if (this._client) {
                try {
                  await this._closeClientWithoutEvents(this._client);
                } catch (e) {
                  this.logger.log("关闭 Improv 客户端失败：", e);
                }
              }

              // 切换到引导加载器模式以进行文件系统操作
              this.logger.log(
                "准备设备进行文件系统操作（切换到引导加载器模式）...",
              );

              try {
                await this._prepareForFlashOperations();
                await this._ensureStub();
              } catch (err: any) {
                this.logger.log(`准备文件系统失败：${err.message}`);
                this._state = "ERROR";
                this._error = `进入引导加载器模式失败：${err.message}`;
                return;
              }

              this._state = "PARTITIONS";
              this._readPartitionTable();
            }}
          ></ewt-button>
        </div>
        ${this._isSameFirmware && this._manifest.funding_url
          ? html`
              <div>
                <a
                  class="button"
                  href=${this._manifest.funding_url}
                  target="_blank"
                >
                  <ewt-button label="资助开发"></ewt-button>
                </a>
              </div>
            `
          : ""}
        ${this._isSameVersion
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  class="danger"
                  label="擦除用户数据"
                  @click=${() => this._startInstall(true)}
                ></ewt-button>
              </div>
            `
          : ""}
      </div>
    `;

    return [heading, content, hideActions, allowClosing];
  }
  _renderDashboardNoImprov(): [string, TemplateResult, boolean, boolean] {
    const heading = "设备仪表板";
    let content: TemplateResult;
    let hideActions = true;
    let allowClosing = true;

    content = html`
      <div class="dashboard-buttons">
        <div>
          <ewt-button
            ?disabled=${this._busy}
            text-left
            .label=${`安装 ${this._manifest.name}`}
            @click=${() => {
              if (this._manifest.new_install_prompt_erase) {
                this._state = "ASK_ERASE";
              } else {
                // 默认擦除不支持 Improv 串行的设备
                this._startInstall(true);
              }
            }}
          ></ewt-button>
        </div>

        ${!this._isUsbJtagOrOtgDevice
          ? html`
              <div>
                <ewt-button
                  label="日志和控制台"
                  ?disabled=${this._busy}
                  @click=${async () => {
                    this._busy = true;
                    const client = this._client;
                    if (client) {
                      await this._closeClientWithoutEvents(client);
                    }

                    // 切换到固件模式以使用控制台
                    const needsReconnect =
                      await this._switchToFirmwareMode("console");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    this._state = "LOGS";
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `
          : ""}
        ${this._isUsbJtagOrOtgDevice
          ? html`
              <div>
                <ewt-button
                  ?disabled=${this._busy}
                  label="打开控制台"
                  @click=${async () => {
                    this._busy = true;

                    // 如果活动，关闭 Improv 客户端
                    if (this._client) {
                      try {
                        await this._closeClientWithoutEvents(this._client);
                      } catch (e) {
                        this.logger.log("关闭 Improv 客户端失败：", e);
                      }
                    }

                    // 如果需要，切换到固件模式
                    const needsReconnect =
                      await this._switchToFirmwareMode("console");
                    if (needsReconnect) {
                      return; // 端口重新连接后继续
                    }

                    // 设备已处于固件模式
                    this.logger.log(
                      "为 USB-JTAG/OTG 设备打开控制台（固件模式）",
                    );

                    this._state = "LOGS";
                    this._busy = false;
                  }}
                ></ewt-button>
              </div>
            `
          : ""}

        <div>
          <ewt-button
            label="管理文件系统"
            ?disabled=${this._busy}
            @click=${async () => {
              // 文件系统管理需要引导加载器模式
              // 如果活动，关闭 Improv 客户端（它会锁定 reader）
              if (this._client) {
                try {
                  await this._closeClientWithoutEvents(this._client);
                } catch (e) {
                  this.logger.log("关闭 Improv 客户端失败：", e);
                }
                // 保留客户端对象用于仪表板渲染；连接已在上方关闭。
              }

              // 切换到引导加载器模式以进行文件系统操作
              this.logger.log(
                "准备设备进行文件系统操作（切换到引导加载器模式）...",
              );

              try {
                await this._prepareForFlashOperations();
                await this._ensureStub();
              } catch (err: any) {
                this.logger.log(`准备文件系统失败：${err.message}`);
                this._state = "ERROR";
                this._error = `进入引导加载器模式失败：${err.message}`;
                return;
              }

              this._state = "PARTITIONS";
              this._readPartitionTable();
            }}
          ></ewt-button>
        </div>
      </div>
    `;

    return [heading, content, hideActions, allowClosing];
  }

  _renderProvision(): [string | undefined, TemplateResult, boolean] {
    let heading: string | undefined = "配置 Wi-Fi";
    let content: TemplateResult;
    let hideActions = false;

    if (this._busy) {
      return [
        heading,
        this._renderProgress(
          this._ssids === undefined ? "扫描网络" : "尝试连接",
        ),
        true,
      ];
    }

    if (
      !this._provisionForce &&
      this._client!.state === ImprovSerialCurrentState.PROVISIONED
    ) {
      heading = undefined;
      const showSetupLinks =
        !this._wasProvisioned &&
        (this._client!.nextUrl !== undefined ||
          "home_assistant_domain" in this._manifest);
      hideActions = showSetupLinks;
      content = html`
        <ewt-page-message
          .icon=${OK_ICON}
          label="设备已连接到网络！"
        ></ewt-page-message>
        ${showSetupLinks
          ? html`
              <div class="dashboard-buttons">
                ${this._client!.nextUrl === undefined
                  ? ""
                  : html`
                      <div>
                        <a
                          href=${this._client!.nextUrl}
                          class="has-button"
                          target="_blank"
                          @click=${async (ev: Event) => {
                            ev.preventDefault();
                            const url = this._client!.nextUrl!;
                            // 为弹窗拦截器保留用户手势
                            const popup = window.open("about:blank", "_blank");
                            // 访问设备打开外部页面 - 固件必须正在运行
                            // 检查设备是否处于引导加载器模式
                            // 如果需要，切换到固件模式
                            const needsReconnect =
                              await this._switchToFirmwareMode("visit");
                            if (needsReconnect) {
                              popup?.close();
                              return; // 端口重新连接后继续
                            }

                            // 设备已处于固件模式
                            this.logger.log("跟随链接（固件模式）");

                            if (popup) {
                              popup.location.href = url;
                            } else {
                              window.open(url, "_blank");
                            }
                            this._state = "DASHBOARD";
                          }}
                        >
                          <ewt-button label="访问设备"></ewt-button>
                        </a>
                      </div>
                    `}
                ${!this._manifest.home_assistant_domain
                  ? ""
                  : html`
                      <div>
                        <a
                          href=${`https://my.home-assistant.io/redirect/config_flow_start/?domain=${this._manifest.home_assistant_domain}`}
                          class="has-button"
                          target="_blank"
                          @click=${async (ev: Event) => {
                            ev.preventDefault();
                            const url = `https://my.home-assistant.io/redirect/config_flow_start/?domain=${this._manifest.home_assistant_domain}`;
                            const popup = window.open("about:blank", "_blank");
                            // 添加到 HA 打开外部页面 - 固件必须正在运行
                            // 检查设备是否处于引导加载器模式
                            // 如果需要，切换到固件模式
                            const needsReconnect =
                              await this._switchToFirmwareMode("homeassistant");
                            if (needsReconnect) {
                              popup?.close();
                              return; // 端口重新连接后继续
                            }

                            // 设备已处于固件模式
                            this.logger.log("跟随链接（固件模式）");

                            if (popup) {
                              popup.location.href = url;
                            } else {
                              window.open(url, "_blank");
                            }
                            this._state = "DASHBOARD";
                          }}
                        >
                          <ewt-button
                            label="添加到 Home Assistant"
                          ></ewt-button>
                        </a>
                      </div>
                    `}
                <div>
                  <ewt-button
                    label="跳过"
                    @click=${async () => {
                      // Wi-Fi 配置后：设备保持在固件模式
                      // 先关闭 Improv 客户端
                      if (this._client) {
                        try {
                          await this._closeClientWithoutEvents(this._client);
                          this.logger.log("配置后已关闭 Improv 客户端");
                        } catch (e) {
                          this.logger.log("关闭 Improv 客户端失败：", e);
                        }
                      }

                      // 释放锁并保持在固件模式
                      await this._releaseReaderWriter();
                      this.logger.log("返回仪表板（设备保持在固件模式）");

                      this._state = "DASHBOARD";
                    }}
                  ></ewt-button>
                </div>
              </div>
            `
          : html`
              <ewt-button
                slot="primaryAction"
                label="继续"
                @click=${async () => {
                  // Wi-Fi 配置后：设备保持在固件模式
                  // 先关闭 Improv 客户端
                  if (this._client) {
                    try {
                      await this._closeClientWithoutEvents(this._client);
                      this.logger.log("配置后已关闭 Improv 客户端");
                    } catch (e) {
                      this.logger.log("关闭 Improv 客户端失败：", e);
                    }
                  }

                  // 释放锁并保持在固件模式
                  await this._releaseReaderWriter();
                  this.logger.log("返回仪表板（设备保持在固件模式）");

                  this._state = "DASHBOARD";
                }}
              ></ewt-button>
            `}
      `;
    } else {
      let error: string | undefined;

      switch (this._client!.error) {
        case ImprovSerialErrorState.UNABLE_TO_CONNECT:
          error = "无法连接";
          break;

        case ImprovSerialErrorState.NO_ERROR:
        // 当列出 SSID 不受支持时会发生。
        case ImprovSerialErrorState.UNKNOWN_RPC_COMMAND:
          break;

        default:
          error = `未知错误 (${this._client!.error})`;
      }
      content = html`
        <div>输入您希望设备连接的 Wi-Fi 网络的凭据。</div>
        ${error ? html`<p class="error">${error}</p>` : ""}
        ${this._ssids !== null
          ? html`
              <ewt-select
                fixedMenuPosition
                label="网络"
                @selected=${(ev: { detail: { index: number } }) => {
                  const index = ev.detail.index;
                  // “其他网络”项始终是最后一项。
                  this._selectedSsid =
                    index === this._ssids!.length
                      ? null
                      : this._ssids![index].name;
                }}
                @closed=${(ev: Event) => ev.stopPropagation()}
              >
                ${this._ssids!.map(
                  (info, idx) => html`
                    <ewt-list-item
                      .selected=${this._selectedSsid === info.name}
                      value=${idx}
                    >
                      ${info.name}
                    </ewt-list-item>
                  `,
                )}
                <ewt-list-item
                  .selected=${this._selectedSsid === null}
                  value="-1"
                >
                  其他网络…
                </ewt-list-item>
              </ewt-select>
            `
          : ""}
        ${
          // 如果命令不受支持或选择了“其他网络”，则显示输入框
          this._selectedSsid === null
            ? html`
                <ewt-textfield label="网络名称" name="ssid"></ewt-textfield>
              `
            : ""
        }
        <ewt-textfield
          label="密码"
          name="password"
          type="password"
        ></ewt-textfield>
        <ewt-button
          slot="primaryAction"
          label="连接"
          @click=${this._doProvision}
        ></ewt-button>
        <ewt-button
          slot="secondaryAction"
          .label=${this._installState && this._installErase ? "跳过" : "返回"}
          @click=${async () => {
            // 从配置页面返回时：设备保持在固件模式
            // 先关闭 Improv 客户端
            if (this._client) {
              try {
                await this._closeClientWithoutEvents(this._client);
                this.logger.log("Improv 客户端已关闭");
              } catch (e) {
                this.logger.log("关闭 Improv 客户端失败：", e);
              }
            }

            // 释放锁并保持在固件模式
            await this._releaseReaderWriter();
            this.logger.log("返回仪表板（设备保持在固件模式）");

            this._state = "DASHBOARD";
          }}
        ></ewt-button>
      `;
    }
    return [heading, content, hideActions];
  }

  _renderAskErase(): [string | undefined, TemplateResult] {
    const heading = "擦除设备";
    const content = html`
      <div>
        您想在安装 ${this._manifest.name}
        之前擦除设备吗？设备上的所有数据都将丢失。
      </div>
      <ewt-formfield label="擦除设备" class="danger">
        <ewt-checkbox></ewt-checkbox>
      </ewt-formfield>
      <ewt-button
        slot="primaryAction"
        label="下一步"
        @click=${() => {
          const checkbox = this.shadowRoot!.querySelector("ewt-checkbox")!;
          this._startInstall(checkbox.checked);
        }}
      ></ewt-button>
      <ewt-button
        slot="secondaryAction"
        label="返回"
        @click=${() => {
          this._state = "DASHBOARD";
        }}
      ></ewt-button>
    `;

    return [heading, content];
  }

  _renderInstall(): [string | undefined, TemplateResult, boolean, boolean] {
    let heading: string | undefined;
    let content: TemplateResult;
    let hideActions = false;
    const allowClosing = false;

    const isUpdate = !this._installErase && this._isSameFirmware;

    if (!this._installConfirmed && this._isSameVersion) {
      heading = "擦除用户数据";
      content = html`
        您要重置设备并擦除设备上的所有用户数据吗？
        <ewt-button
          class="danger"
          slot="primaryAction"
          label="擦除用户数据"
          @click=${this._confirmInstall}
        ></ewt-button>
      `;
    } else if (!this._installConfirmed) {
      heading = "确认安装";
      const action = isUpdate ? "更新到" : "安装";
      content = html`
        ${isUpdate
          ? html`您的设备正在运行
              ${this._info!.firmware}&nbsp;${this._info!.version}.<br /><br />`
          : ""}
        您要 ${action} ${this._manifest.name}&nbsp;${this._manifest.version}
        吗？
        ${this._installErase
          ? html`<br /><br />设备上的所有数据将被擦除。`
          : ""}
        <ewt-button
          slot="primaryAction"
          label="安装"
          @click=${this._confirmInstall}
        ></ewt-button>
        <ewt-button
          slot="secondaryAction"
          label="返回"
          @click=${() => {
            this._state = "DASHBOARD";
          }}
        ></ewt-button>
      `;
    } else if (
      !this._installState ||
      this._installState.state === FlashStateType.INITIALIZING ||
      this._installState.state === FlashStateType.MANIFEST ||
      this._installState.state === FlashStateType.PREPARING
    ) {
      heading = "正在安装";
      content = this._renderProgress("准备安装");
      hideActions = true;
    } else if (this._installState.state === FlashStateType.ERASING) {
      heading = "正在安装";
      content = this._renderProgress("正在擦除");
      hideActions = true;
    } else if (
      this._installState.state === FlashStateType.WRITING ||
      // 完成后，保持此屏幕显示 100% 写入进度
      // 直到 Improv 初始化完成或未检测到。
      // 例外：USB-JTAG/OTG 设备跳过此项（它们显示重新连接消息）
      (this._installState.state === FlashStateType.FINISHED &&
        this._client === undefined &&
        !this._isUsbJtagOrOtgDevice)
    ) {
      heading = "正在安装";
      let percentage: number | undefined;
      let undeterminateLabel: string | undefined;
      if (this._installState.state === FlashStateType.FINISHED) {
        // 写入完成并检测 improv，显示旋转器
        undeterminateLabel = "收尾";
      } else if (this._installState.details.percentage < 4) {
        // 固件写入低于 4%，显示旋转器，否则我们不显示任何像素
        undeterminateLabel = "正在安装";
      } else {
        // 固件写入超过 4%，显示进度条
        percentage = this._installState.details.percentage;
      }
      content = this._renderProgress(
        html`
          ${undeterminateLabel ? html`${undeterminateLabel}<br />` : ""}
          <br />
          ‌这需要一分钟。<br />
          在安装完成前保持此页面可见。
        `,
        percentage,
      );
      hideActions = true;
    } else if (
      this._installState.state === FlashStateType.FINISHED &&
      !this._isUsbJtagOrOtgDevice
    ) {
      // 注意：USB-JTAG/OTG 设备直接进入 REQUEST_PORT_SELECTION
      // 这仅适用于外部串行芯片
      heading = undefined;
      const supportsImprov = this._client !== null;

      content = html`
        <ewt-page-message
          .icon=${OK_ICON}
          label="安装完成！"
        ></ewt-page-message>
        <ewt-button
          slot="primaryAction"
          label="下一步"
          @click=${() => {
            this._state =
              supportsImprov && this._installErase ? "PROVISION" : "DASHBOARD";
          }}
        ></ewt-button>
      `;
    } else if (this._installState.state === FlashStateType.ERROR) {
      heading = "安装失败";
      content = html`
        <ewt-page-message
          .icon=${ERROR_ICON}
          .label=${this._installState.message}
        ></ewt-page-message>
        <ewt-button
          slot="primaryAction"
          label="返回"
          @click=${async () => {
            this._improvChecked = false; // 强制重新测试 Improv
            await this._initialize(); // 刷写失败后重新测试 Improv
            this._state = "DASHBOARD";
          }}
        ></ewt-button>
      `;
    }
    return [heading, content!, hideActions, allowClosing];
  }

  _renderLogs(): [string | undefined, TemplateResult, boolean] {
    let heading: string | undefined = `日志`;
    let content: TemplateResult;
    let hideActions = false;

    content = html`
      <ewt-console
        .port=${this._port}
        .logger=${this.logger}
        .onReset=${async () => await this.esploader.hardReset(false)}
      ></ewt-console>
      <ewt-button
        slot="primaryAction"
        label="返回"
        @click=${async () => {
          await this.shadowRoot!.querySelector("ewt-console")!.disconnect();

          // 控制台后：ESP 保持在固件模式
          // 仅当点击“安装”或“管理文件系统”时，设备才会切换到引导加载器模式
          await this._releaseReaderWriter();
          this.logger.log("返回仪表板（设备保持在固件模式）");

          this._state = "DASHBOARD";
          // 不重置 _improvChecked - 控制台只读取，不更改固件
          await this._initialize();
        }}
      ></ewt-button>
      <ewt-button
        slot="secondaryAction"
        label="下载日志"
        @click=${() => {
          textDownload(
            this.shadowRoot!.querySelector("ewt-console")!.logs(),
            `esp-web-tools-logs.txt`,
          );

          this.shadowRoot!.querySelector("ewt-console")!.reset();
        }}
      ></ewt-button>
      <ewt-button
        slot="secondaryAction"
        label="重置设备"
        @click=${async () => {
          await this.shadowRoot!.querySelector("ewt-console")!.reset();
        }}
      ></ewt-button>
    `;

    return [heading, content!, hideActions];
  }

  _renderPartitions(): [string | undefined, TemplateResult, boolean] {
    const heading = "分区表";
    let content: TemplateResult;
    const hideActions = false;

    if (this._busy) {
      content = this._renderProgress("读取分区表...");
    } else if (!this._partitions || this._partitions.length === 0) {
      content = html`
        <ewt-page-message
          .icon=${ERROR_ICON}
          label="未找到分区"
        ></ewt-page-message>
        <ewt-button
          slot="primaryAction"
          label="返回"
          @click=${async () => {
            // 仅释放锁并返回仪表板
            // 设备保持在固件模式（无需切换）
            await this._releaseReaderWriter();
            this._state = "DASHBOARD";
            // 不重置 _improvChecked - 控制台操作后状态仍然有效
          }}
        ></ewt-button>
      `;
    } else {
      content = html`
        <div class="partition-list">
          <table class="partition-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>子类型</th>
                <th>偏移量</th>
                <th>大小</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${this._partitions.map(
                (partition) => html`
                  <tr>
                    <td>${partition.name}</td>
                    <td>${partition.typeName}</td>
                    <td>${partition.subtypeName}</td>
                    <td>0x${partition.offset.toString(16)}</td>
                    <td>${this._formatSize(partition.size)}</td>
                    <td>
                      ${partition.type === 0x01 && partition.subtype === 0x82
                        ? html`
                            <ewt-button
                              label="打开文件系统"
                              @click=${() => this._openFilesystem(partition)}
                            ></ewt-button>
                          `
                        : ""}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
        <ewt-button
          slot="primaryAction"
          label="返回"
          @click=${async () => {
            try {
              // 对于 USB-JTAG/OTG：端口更改后需要重新初始化
              // 对于外部串行：仅返回仪表板
              if (this._isUsbJtagOrOtgDevice) {
                this._state = "DASHBOARD";
                await this._initialize();
              } else {
                // 外部串行 - 仅返回，设备保持在引导加载器模式
                this._state = "DASHBOARD";
                // 确保 _busy 为 false 以便按钮启用
                this._busy = false;
              }
            } catch (err: any) {
              this.logger.error(`分区返回错误：${err.message}`);
              this._state = "ERROR";
              this._error = `返回仪表板失败：${err.message}`;
              this._busy = false;
            }
          }}
        ></ewt-button>
      `;
    }

    return [heading, content, hideActions];
  }

  _renderLittleFS(): [string | undefined, TemplateResult, boolean, boolean] {
    const heading = undefined;
    const hideActions = true;
    const allowClosing = true;

    const content = html`
      <ewt-littlefs-manager
        .partition=${this._selectedPartition}
        .espStub=${this._espStub}
        .logger=${this.logger}
        .onClose=${() => {
          this._state = "PARTITIONS";
        }}
      ></ewt-littlefs-manager>
    `;

    return [heading, content, hideActions, allowClosing];
  }

  private async _readPartitionTable() {
    const PARTITION_TABLE_OFFSET = 0x8000;
    const PARTITION_TABLE_SIZE = 0x1000;

    this._busy = true;
    this._partitions = undefined;

    try {
      this.logger.log("从 0x8000 读取分区表...");

      // 确保存根已初始化
      const espStub = await this._ensureStub();

      // 存根运行后添加一个小延迟
      await sleep(100);

      this.logger.log("读取闪存数据...");
      const data = await espStub.readFlash(
        PARTITION_TABLE_OFFSET,
        PARTITION_TABLE_SIZE,
      );

      const partitions = parsePartitionTable(data);

      if (partitions.length === 0) {
        this.logger.log("未找到有效的分区表");
        this._partitions = [];
      } else {
        this.logger.log(`找到 ${partitions.length} 个分区`);
        this._partitions = partitions;
      }
    } catch (e: any) {
      this.logger.error(`读取分区表失败：${e.message || e}`);

      if (e.message === "Port selection cancelled") {
        await this._releaseReaderWriter();
        this._error = "端口选择已取消";
        this._state = "ERROR";
      } else if (e.message && e.message.includes("Failed to connect")) {
        // 连接错误 - 显示错误状态以便用户重试
        await this._releaseReaderWriter();
        this._error = e.message;
        this._state = "ERROR";
      } else {
        // 其他错误（如解析错误）- 仅显示空分区列表
        this.logger.log("返回分区视图，无分区");
        this._partitions = [];
      }
    } finally {
      // 不要在此处释放 reader/writer 锁！
      // 保持它们以便存根可用于：
      // - 多次分区读取
      // - 打开文件系统
      // 锁将在以下情况释放：
      // - 用户点击“返回”到仪表板（调用 _initialize）
      // - 用户点击“安装固件”（flash.ts 释放它们）
      // - 对话框关闭（调用 _handleClose）

      this._busy = false;
    }
  }

  private async _openFilesystem(partition: Partition) {
    try {
      this._busy = true;
      this.logger.log(`检测分区 "${partition.name}" 的文件系统类型...`);

      // 检查 ESP 存根是否仍然可用
      if (!this._espStub) {
        throw new Error("ESP 存根不可用。请重新连接。");
      }

      const fsType = await detectFilesystemType(
        this._espStub,
        partition.offset,
        partition.size,
        this.logger,
      );
      this.logger.log(`检测到的文件系统：${fsType}`);

      if (fsType === "littlefs") {
        this._selectedPartition = partition;
        this._state = "LITTLEFS";
      } else if (fsType === "spiffs") {
        this.logger.error("SPIFFS 支持尚未实现。请使用 LittleFS 分区。");
        this._error = "SPIFFS 支持尚未实现";
        this._state = "ERROR";
      } else {
        this.logger.error("未知的文件系统类型。无法打开分区。");
        this._error = "未知的文件系统类型";
        this._state = "ERROR";
      }
    } catch (e: any) {
      this.logger.error(`打开文件系统失败：${e.message || e}`);
      this._error = `打开文件系统失败：${e.message || e}`;
      this._state = "ERROR";
    } finally {
      this._busy = false;
    }
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

  public override willUpdate(changedProps: PropertyValues) {
    if (!changedProps.has("_state")) {
      return;
    }
    // 在页面之间切换时清除错误，除非切换到错误页面
    if (this._state !== "ERROR") {
      this._error = undefined;
    }
    // 在配置页面扫描 SSID
    if (this._state === "PROVISION") {
      this._updateSsids();
    } else {
      // 如果离开配置页面，重置此值
      this._provisionForce = false;
    }

    if (this._state === "INSTALL") {
      this._installConfirmed = false;
      this._installState = undefined;
    }
  }

  private async _updateSsids(tries = 0) {
    this._ssids = undefined;
    this._busy = true;

    let ssids: Ssid[];
    try {
      ssids = await this._client!.scan();
    } catch (err) {
      // 加载失败时，选择“其他网络”
      if (this._ssids === undefined) {
        this._ssids = null;
        this._selectedSsid = null;
      }
      this._busy = false;
      return;
    }

    // 如果没有结果，我们将重试几次
    if (ssids.length === 0 && tries < 3) {
      this.logger.log(`SSID 扫描返回空，安排重试 ${tries + 1}/3`);
      setTimeout(() => {
        if (this._state === "PROVISION") {
          this._updateSsids(tries + 1);
        }
      }, 2000);
      return;
    }

    this._ssids = ssids;
    this._selectedSsid = ssids.length ? ssids[0].name : null;
    this._busy = false;
  }

  protected override firstUpdated(changedProps: PropertyValues) {
    super.firstUpdated(changedProps);

    // 包装记录器以同时记录到调试组件
    const originalLogger = this.logger;
    this.logger = {
      log: (msg: string, ...args: any[]) => {
        originalLogger.log(msg, ...args);
      },
      error: (msg: string, ...args: any[]) => {
        originalLogger.error(msg, ...args);
      },
      debug: (msg: string, ...args: any[]) => {
        if (originalLogger.debug) {
          originalLogger.debug(msg, ...args);
        }
      },
    };

    // 关键：在 esploader 上设置记录器，以便我们可以看到来自 enterConsoleMode() 等的日志
    this.esploader.logger = this.logger;

    this._initialize(); // 初始连接 - 测试 Improv
  }

  protected override updated(changedProps: PropertyValues) {
    super.updated(changedProps);

    if (changedProps.has("_state")) {
      this.setAttribute("state", this._state);
    }

    if (this._state !== "PROVISION") {
      return;
    }

    if (changedProps.has("_selectedSsid") && this._selectedSsid === null) {
      // 如果选择“其他网络”，聚焦 SSID 输入框
      this._focusFormElement("ewt-textfield[name=ssid]");
    } else if (changedProps.has("_ssids")) {
      // 当 SSID 加载完毕/标记为不支持时显示表单
      this._focusFormElement();
    }
  }

  private _focusFormElement(selector = "ewt-textfield, ewt-select") {
    const formEl = this.shadowRoot!.querySelector(
      selector,
    ) as LitElement | null;
    if (formEl) {
      formEl.updateComplete.then(() => setTimeout(() => formEl.focus(), 100));
    }
  }

  private async _initialize(justInstalled = false, skipImprov = false) {
    if (this._port.readable === null || this._port.writable === null) {
      this._state = "ERROR";
      this._error =
        "串行端口不可读/写。请关闭任何其他使用它的应用程序，然后重试。";
      return;
    }

    // 初始化期间设置忙碌标志
    this._busy = true;
    this.requestUpdate(); // 强制 UI 更新以立即禁用按钮

    try {
      // 如果通过浏览器使用本地文件上传，我们提供一个清单作为 JSON 字符串，而不是 URL
      this._manifest = JSON.parse(this.manifestPath);
    } catch {
      // 标准流程 - 使用提供的 URL 下载 manifest.json
      try {
        this._manifest = await downloadManifest(this.manifestPath);
      } catch (err: any) {
        this._state = "ERROR";
        this._error = "下载清单失败";
        this._busy = false;
        return;
      }
    }

    // 如果请求，跳过 Improv（例如，从控制台或文件系统管理器返回时）
    if (skipImprov) {
      this.logger.log("跳过 Improv 测试（此操作不需要）");
      this._client = null;
      this._improvChecked = true;
      this._busy = false;
      return;
    }

    if (this._manifest.new_install_improv_wait_time === 0) {
      this._client = null;
      this._improvSupported = false;
      this._improvChecked = true;
      this._busy = false;
      return;
    }

    // 如果已经检查过，跳过 Improv（避免重复尝试）
    if (this._improvChecked) {
      this.logger.log(
        `Improv 已检查 - ${this._improvSupported ? "支持" : "不支持"}，跳过重新测试`,
      );
      // 确保 _client 状态对 UI 渲染有效
      if (!this._improvSupported) {
        // 不支持 - 确保显式为 null 供 UI 使用
        this._client = null;
      }
      this._busy = false;
      this.requestUpdate(); // 强制 UI 更新
      return;
    }

    // 如果已经有工作客户端，跳过 Improv
    if (this._client) {
      this.logger.log("Improv 客户端已活动，跳过初始化");
      this._improvSupported = true; // 如果有客户端，Improv 受支持
      this._improvChecked = true;
      this._busy = false;
      return;
    }

    // 检查设备是否使用 USB-JTAG 或 USB-OTG（非外部串行芯片）
    const isUsbJtagOrOtg = await this._isUsbJtagOrOtg();
    this._isUsbJtagOrOtgDevice = isUsbJtagOrOtg; // 更新 UI 状态

    // 检查设备是否处于引导加载器模式
    // 如果是，首先切换到固件模式（Improv 需要）
    const inBootloaderMode = this.esploader.chipFamily !== null;

    if (inBootloaderMode) {
      this.logger.log(
        "设备处于 BOOTLOADER 模式 - 切换到 FIRMWARE 模式以进行 Improv 测试",
      );

      if (isUsbJtagOrOtg) {
        // USB-JTAG/OTG：需要 WDT 重置 → 端口关闭 → 用户必须选择新端口
        this.logger.log("USB-JTAG/OTG 设备 - 需要切换到固件模式");

        try {
          // 关键：在调用 resetToFirmware() 前确保 chipFamily 已设置
          if (!this.esploader.chipFamily) {
            this.logger.log("检测芯片类型...");
            await this.esploader.initialize();
            this.logger.log(`芯片已检测：${this.esploader.chipFamily}`);
          }

          // 关键：在重置前创建存根
          if (!this._espStub) {
            this.logger.log("为固件模式切换创建存根...");
            this._espStub = await this.esploader.runStub();
            this.logger.log(`存根已创建：IS_STUB=${this._espStub.IS_STUB}`);
          }

          // 关键：保存父加载器
          const loaderToSave = this._espStub._parent || this._espStub;
          (this as any)._savedLoaderBeforeConsole = loaderToSave;

          // 关键：在调用 resetToFirmware() 前释放锁
          await this._releaseReaderWriter();

          // 关键：忘记旧端口，以免浏览器在选择中显示它
          try {
            await this._port.forget();
            this.logger.log("旧端口已忘记");
          } catch (forgetErr: any) {
            this.logger.log(`忘记端口失败：${forgetErr.message}`);
          }

          // 使用 resetToFirmware() 处理 WDT 重置和端口关闭
          await this.esploader.resetToFirmware();
          this.logger.log("设备已重置到固件模式 - 端口已关闭");
        } catch (err: any) {
          this.logger.debug(`重置到固件错误（预期内）：${err.message}`);
        }

        // 重置 ESP 状态（端口已由 resetToFirmware 关闭）
        await sleep(100);

        this._espStub = undefined;
        this.esploader.IS_STUB = false;
        this.esploader.chipFamily = null;
        this._improvChecked = false; // 用户重新连接后将检查
        this._client = undefined;
        this._improvSupported = false;
        this.esploader._reader = undefined;

        this.logger.log("等待用户选择新端口");

        // 显示端口选择 UI
        this._state = "REQUEST_PORT_SELECTION";
        this._error = "";
        this._busy = false;
        return;
      } else {
        // 外部串行芯片：可以重置到固件模式而无需端口更改
        this.logger.log("外部串行芯片 - 重置到固件模式");

        try {
          await this._resetDeviceAndReleaseLocks();
          await sleep(500); // 等待固件启动
        } catch (err: any) {
          this.logger.log(`重置到固件失败：${err.message}`);
        }
      }
    } else {
      this.logger.log("设备已处于 FIRMWARE 模式 - 准备进行 Improv 测试");
    }

    // 在 Improv 测试前确保流已就绪（如控制台所做）
    // 这是我们在 Improv 测试前调用 _releaseReaderWriter 的唯一地方
    try {
      await this._releaseReaderWriter();
      await sleep(200);
      this.logger.log("流已准备好进行 Improv 测试");
    } catch (err: any) {
      this.logger.log(`准备流失败：${err.message}`);
    }

    // 初始连接时不要切换到引导加载器！
    // 直接测试 Improv - 设备现在应处于固件模式
    this.logger.log("测试 Improv（设备处于固件模式）");

    // 计算 Improv 测试的超时时间
    // 对于初始连接使用较长的超时时间，以允许设备获取 IP 地址（可能需要 8 秒以上）
    const timeout = !justInstalled
      ? 10000
      : this._manifest.new_install_improv_wait_time !== undefined
        ? this._manifest.new_install_improv_wait_time * 1000
        : 10000;

    // 调用 Improv 测试，skipReset=true（已在 _resetDeviceAndReleaseLocks 中重置）
    await this._testImprov(timeout, true);
  }

  /**
   * 将设备从引导加载器模式切换到固件模式。
   * 对于 USB-JTAG/OTG 设备：需要端口重新连接（设置 REQUEST_PORT_SELECTION 状态）。
   * 对于外部串行：重置设备而不更改端口。
   *
   * @param actionAfterReconnect - 重新连接后要执行的操作：'console', 'visit', 'homeassistant', 'wifi' 或 null
   */
  private async _switchToFirmwareMode(
    actionAfterReconnect:
      | "console"
      | "visit"
      | "homeassistant"
      | "wifi"
      | null = null,
  ): Promise<boolean> {
    const inBootloaderMode = this.esploader.chipFamily !== null;

    if (!inBootloaderMode) {
      this.logger.log("设备已处于固件模式");

      // 如果是第一次打开控制台，进行重置以确保设备就绪
      if (actionAfterReconnect === "console" && !this._consoleInitialized) {
        this.logger.log("首次打开控制台 - 重置设备...");
        this._consoleInitialized = true;
        try {
          await this.esploader.hardReset(false);
          this.logger.log("设备重置完成");
        } catch (err: any) {
          this.logger.log(`重置错误（预期内）：${err.message}`);
        }
      }

      // 即使已处于固件模式，也要确保流就绪
      // 这对于关闭 Improv 客户端后的 WebUSB 是必需的
      await this._releaseReaderWriter();

      return false; // 无需切换
    }

    this.logger.log(
      `设备处于引导加载器模式 - 切换到固件以进行 ${actionAfterReconnect || "操作"}`,
    );

    // 关键：确保 chipFamily 已设置
    if (!this.esploader.chipFamily) {
      this.logger.log("检测芯片类型...");
      await this.esploader.initialize();
      this.logger.log(`芯片已检测：${this.esploader.chipFamily}`);
    }

    // 关键：在重置前创建存根
    if (!this._espStub) {
      this.logger.log("为固件模式切换创建存根...");
      this._espStub = await this.esploader.runStub();
      this.logger.log(`存根已创建：IS_STUB=${this._espStub.IS_STUB}`);
    }

    // 关键：在切换前将波特率设置为 115200
    await this._resetBaudrateForConsole();

    // 关键：保存父加载器
    const loaderToSave = this._espStub._parent || this._espStub;
    (this as any)._savedLoaderBeforeSwitch = loaderToSave;

    // 检查是否为 USB-JTAG/OTG 设备
    const isUsbJtagOrOtg = await this._isUsbJtagOrOtg();

    if (isUsbJtagOrOtg) {
      // USB-JTAG/OTG：需要 WDT 重置和端口重新连接

      // 关键：在调用 resetToFirmware() 前释放锁
      this.logger.log("释放 reader/writer...");
      await this._releaseReaderWriter();

      try {
        // 关键：忘记旧端口
        try {
          await this._port.forget();
          this.logger.log("旧端口已忘记");
        } catch (forgetErr: any) {
          this.logger.log(`忘记端口失败：${forgetErr.message}`);
        }

        // 对 CDC 使用 resetToFirmware()，这是执行 WDT 重置
        await this.esploader.resetToFirmware();
        this.logger.log("设备已重置到固件模式 - 端口已关闭");
      } catch (err: any) {
        this.logger.debug(`重置到固件错误（预期内）：${err.message}`);
      }

      // 重置 ESP 状态
      await sleep(100);

      this._espStub = undefined;
      this.esploader.IS_STUB = false;
      this.esploader.chipFamily = null;
      this._improvChecked = false;
      this._client = null;
      this._improvSupported = false;
      this.esploader._reader = undefined;

      // 设置重新连接后的操作标志
      if (actionAfterReconnect === "console") {
        this._openConsoleAfterReconnect = true;
      } else if (actionAfterReconnect === "visit") {
        this._visitDeviceAfterReconnect = true;
      } else if (actionAfterReconnect === "homeassistant") {
        this._addToHAAfterReconnect = true;
      } else if (actionAfterReconnect === "wifi") {
        this._changeWiFiAfterReconnect = true;
      }

      this.logger.log("等待用户选择新端口");

      // 显示端口选择 UI
      this._state = "REQUEST_PORT_SELECTION";
      this._error = "";
      this._busy = false;
      return true; // 需要端口重新连接
    } else {
      // 外部串行芯片：可以重置到固件模式而无需端口更改
      this.logger.log("外部串行芯片 - 重置到固件模式");

      try {
        // 关键：在释放锁前调用 hardReset（以便它能通信）
        await this.esploader.hardReset(false); // false = 固件模式
        this.logger.log("设备已重置到固件模式");
      } catch (err: any) {
        this.logger.log(`重置成功。预期的超时读取错误：${err.message}`);
      }

      // 等待重置完成
      await sleep(500);

      // 现在在重置后释放锁
      this.logger.log("重置后释放 reader/writer...");
      await this._releaseReaderWriter();

      // 重置 ESP 状态
      this._espStub = undefined;
      this.esploader.IS_STUB = false;
      this.esploader.chipFamily = null;

      try {
        // 执行 hardReset 以启动固件
        await this.esploader.hardReset(false); // false = 固件模式
        this.logger.log("设备处于固件模式，通过重置启动固件");
      } catch (err: any) {
        this.logger.log(`重置错误：${err.message}`);
      }

      return false; // 无需端口重新连接
    }
  }

  private _startInstall(erase: boolean) {
    this._state = "INSTALL";
    this._installErase = erase;
    this._installConfirmed = false;
  }

  private async _confirmInstall() {
    this._installConfirmed = true;
    this._installState = undefined;

    if (this._client) {
      await this._closeClientWithoutEvents(this._client);
    }
    this._client = undefined;

    // 对于刷写操作，我们必须处于引导加载器模式
    // 这是唯一切换到引导加载器的地方（不是初始连接）
    this.logger.log("准备设备进行刷写操作（切换到引导加载器模式）...");

    try {
      await this._prepareForFlashOperations();
    } catch (err: any) {
      this.logger.log(`准备刷写失败：${err.message}`);
      this._state = "ERROR";
      this._error = `进入引导加载器模式失败：${err.message}`;
      return;
    }

    // 在刷写前确保存根已初始化
    try {
      await this._ensureStub();
    } catch (err: any) {
      // 连接失败 - 向用户显示错误
      this._state = "ERROR";
      this._error = err.message;
      return;
    }

    // 使用存根进行刷写
    const loaderToUse = this._espStub!;

    if (this.firmwareFile != undefined) {
      // 如果提供了上传的文件 -> 创建内容的 Uint8Array
      new Blob([this.firmwareFile])
        .arrayBuffer()
        .then((b) => this._flashFilebuffer(new Uint8Array(b)));
    } else {
      // 使用“标准方式”使用 URL 到清单和固件二进制文件
      flash(
        async (state) => {
          this._installState = state;

          if (state.state === FlashStateType.FINISHED) {
            // 对于 USB-JTAG/OTG，在显示端口选择前等待清理完成
            const isUsbJtagOrOtg = await this._isUsbJtagOrOtg();
            if (isUsbJtagOrOtg) {
              this._isUsbJtagOrOtgDevice = true;
              // 在显示端口选择前等待重置完成
              await this._handleFlashComplete().catch((err: any) => {
                this.logger.error(`刷写后清理失败：${err?.message || err}`);
                this._state = "ERROR";
                this._error = `刷写后清理失败：${err?.message || err}`;
              });
            } else {
              // 对于非 USB-JTAG/OTG，异步运行（无需等待）
              void this._handleFlashComplete().catch((err: any) => {
                this.logger.error(`刷写后清理失败：${err?.message || err}`);
                this._state = "ERROR";
                this._error = `刷写后清理失败：${err?.message || err}`;
              });
            }
          }
        },
        loaderToUse,
        this.logger,
        this.manifestPath,
        this._installErase,
        new Uint8Array(0),
        this.baudRate,
      ).catch((flashErr: any) => {
        this.logger.error(`刷写错误：${flashErr.message || flashErr}`);
        this._state = "ERROR";
        this._error = `刷写失败：${flashErr.message || flashErr}`;
        this._busy = false;
      });
    }
  }

  async _flashFilebuffer(fileBuffer: Uint8Array) {
    // 存根已在 _confirmInstall 中确保
    const loaderToUse = this._espStub!;

    flash(
      (state) => {
        this._installState = state;

        if (state.state === FlashStateType.FINISHED) {
          void this._handleFlashComplete().catch((err: any) => {
            this.logger.error(`刷写后清理失败：${err?.message || err}`);
            this._state = "ERROR";
            this._error = `刷写后清理失败：${err?.message || err}`;
          });
        }
      },
      loaderToUse,
      this.logger,
      this.manifestPath,
      this._installErase,
      fileBuffer,
      this.baudRate,
    ).catch((flashErr: any) => {
      this.logger.error(`刷写错误：${flashErr.message || flashErr}`);
      this._state = "ERROR";
      this._error = `刷写失败：${flashErr.message || flashErr}`;
      this._busy = false;
    });
  }

  private async _doProvision() {
    this._busy = true;
    this._wasProvisioned =
      this._client!.state === ImprovSerialCurrentState.PROVISIONED;
    const ssid =
      this._selectedSsid === null
        ? (
            this.shadowRoot!.querySelector(
              "ewt-textfield[name=ssid]",
            ) as EwtTextfield
          ).value
        : this._selectedSsid;
    const password = (
      this.shadowRoot!.querySelector(
        "ewt-textfield[name=password]",
      ) as EwtTextfield
    ).value;
    try {
      await this._client!.provision(ssid, password);
    } catch (err: any) {
      return;
    } finally {
      this._busy = false;
      this._provisionForce = false;
    }
  }

  private _handleDisconnect = () => {
    this._state = "ERROR";
    this._error = "已断开连接";
  };

  private async _handleSelectNewPort() {
    // 防止多次点击
    if (this._busy) {
      this.logger.log("已在处理端口选择，忽略重复点击");
      return;
    }

    this._busy = true;
    this.logger.log("用户点击了“选择端口”按钮 - 请求新端口...");
    this.logger.log(`开始时对话框在 DOM 中：${this.parentNode ? "是" : "否"}`);

    // 立即隐藏“选择端口”按钮并显示进度
    // 这避免了端口选择对话框出现时的混淆
    this._state = "DASHBOARD"; // 更改状态以隐藏按钮
    this._improvChecked = false; // 显示“连接中”消息
    this.requestUpdate();

    // 确保对话框保持在 DOM 中
    if (!this.parentNode) {
      document.body.appendChild(this);
      this.logger.log("端口选择前已将对话框重新添加到 DOM");
    }

    let newPort;
    try {
      // 检查是使用 WebUSB（安卓）还是 Web Serial（桌面）
      if ((globalThis as any).requestSerialPort) {
        // 安卓 WebUSB
        this.logger.log("使用 WebUSB 端口选择（安卓）");
        newPort = await (globalThis as any).requestSerialPort((msg: string) =>
          this.logger.log("[WebUSB]", msg),
        );
      } else {
        // 桌面 Web Serial
        this.logger.log("使用 Web Serial 端口选择（桌面）");
        newPort = await navigator.serial.requestPort();
      }

      // requestPort 完成后可以进行 UI 更新
      await new Promise((resolve) => setTimeout(resolve, 50));

      this.logger.log("用户已选择端口");

      // 确保端口选择后对话框仍在 DOM 中
      if (!this.parentNode) {
        document.body.appendChild(this);
        this.logger.log("端口选择后已将对话框重新添加到 DOM");
      }
    } catch (err: any) {
      this.logger.error("端口选择错误：", err);
      if ((err as DOMException).name === "NotFoundError") {
        // 用户取消了端口选择
        this.logger.log("用户取消了端口选择");
        this._busy = false;
        this._state = "ERROR";
        this._error = "端口选择已取消";
        return;
      }
      this._busy = false;
      this._state = "ERROR";
      this._error = `端口选择失败：${err.message}`;
      return;
    }

    if (!newPort) {
      this.logger.error("newPort 为 null/undefined");
      this._busy = false;
      this._state = "ERROR";
      this._error = "选择端口失败";
      return;
    }

    // 以 115200 波特打开端口（固件模式默认值）
    // 端口应由 resetToFirmware() 关闭，但先检查
    this.logger.log("以 115200 波特打开端口以进入固件模式...");
    this.logger.log(
      `打开端口前对话框在 DOM 中：${this.parentNode ? "是" : "否"}`,
    );

    // 检查端口是否已打开（不应，但以防万一）
    if (newPort.readable !== null || newPort.writable !== null) {
      this.logger.log("警告：端口似乎已打开，正在先关闭它...");
      try {
        await newPort.close();
        await sleep(200); // 等待端口完全关闭
        this.logger.log("端口已成功关闭");
      } catch (closeErr: any) {
        this.logger.log(`关闭端口失败：${closeErr.message}`);
        // 继续 - 也许它实际上并未打开
      }
    }

    try {
      await newPort.open({ baudRate: 115200 });
      this.logger.log("端口已成功以 115200 波特打开");
      this.logger.log(
        `打开端口后对话框在 DOM 中：${this.parentNode ? "是" : "否"}`,
      );
    } catch (err: any) {
      this.logger.error("打开端口错误：", err);
      this._busy = false;
      this._state = "ERROR";
      this._error = `打开端口失败：${err.message}`;
      return;
    }

    // 不要创建新的 ESPLoader - 重用现有的，只更新端口！ -> espStub.port = newPort
    this.logger.log("使用新端口更新现有 ESPLoader 以进入固件模式...");

    // 关键：更新所有端口引用！！
    // 更新：espStub.port, espStub._parent.port, espLoaderBeforeConsole.port

    // 1. 更新基础加载器端口（关键 - _port getter 使用它！）
    this.logger.log("更新基础加载器端口");
    this.esploader.port = newPort;
    this.esploader.connected = true;

    // 2. 如果存在存根，更新存根端口
    if (this._espStub) {
      this.logger.log("更新 STUB 端口");
      this._espStub.port = newPort;
      this._espStub.connected = true;

      // 3. 如果存在父级，更新它
      if (this._espStub._parent) {
        this.logger.log("更新父加载器端口");
        this._espStub._parent.port = newPort;
      }
    }

    // 4. 如果存在保存的加载器，更新它
    if ((this as any)._savedLoaderBeforeConsole) {
      this.logger.log("更新保存的加载器端口");
      (this as any)._savedLoaderBeforeConsole.port = newPort;
    }
    this.logger.log("ESPLoader 端口已更新以进入固件模式（无引导加载器同步）");

    // 等待设备在 WDT 重置后完全启动到固件
    // 并等待端口准备好通信
    this.logger.log("等待 700ms 让设备完全启动且端口就绪...");
    await sleep(700);

    // 关键：验证端口是否实际打开并准备就绪
    this.logger.log(
      `端口状态检查：readable=${this._port.readable !== null}，writable=${this._port.writable !== null}`,
    );

    // 关键：检查是否有任何可能干扰 Improv 的 reader/writer 锁
    this.logger.log(
      `检查锁：reader=${this.esploader._reader ? "已锁定" : "空闲"}，writer=${this.esploader._writer ? "已锁定" : "空闲"}`,
    );
    if (this.esploader._reader || this.esploader._writer) {
      this.logger.log("警告：端口有活动锁！在 Improv 测试前释放它们...");
      await this._releaseReaderWriter();
      this.logger.log("锁已释放");
    }

    this.logger.log("设备现在应该已就绪");

    // 现在以 115200 波特测试 Improv
    this.logger.log("以 115200 波特测试 Improv...");

    // 测试 Improv 时显示进度
    this._state = "DASHBOARD";
    this.requestUpdate(); // 强制 UI 更新以显示进度

    // 继续 Improv 测试
    // 对于 USB-JTAG/OTG：设备处于固件模式但固件未启动 - 需要重置
    // 对于外部串行：重置确保设备处于干净状态
    await this._testImprov(1000, false);
  }

  private async _testImprov(timeout = 1000, skipReset = false) {
    // 关键：在测试前标记 Improv 为已检查，以防止重复测试
    this._improvChecked = true;

    // 关键：尽早设置 _busy = false 以确保即使发生意外错误，菜单也能启用
    // 这可以防止菜单在发生意外错误时保持灰色
    //    this._busy = false;

    // 在 try 块外声明 improvSerial，以便在 catch 中可用
    let improvSerial: ImprovSerial | undefined;

    // 测试 Improv 支持
    try {
      // 使用 _port getter，它返回 esploader.port（现在已用新端口更新）
      this.logger.log(
        `Improv 的端口：readable=${this._port.readable !== null}，writable=${this._port.writable !== null}`,
      );
      const portInfo = this._port.getInfo();
      this.logger.log(
        `端口信息：VID=0x${portInfo.usbVendorId?.toString(16).padStart(4, "0")}，PID=0x${portInfo.usbProductId?.toString(16).padStart(4, "0")}`,
      );

      // 关键：在测试 Improv 前重置设备以确保固件正在运行（除非 skipReset 为 true）
      if (!skipReset) {
        this.logger.log("重置设备以进行 Improv 检测...");

        try {
          // 重置前释放锁
          await this._releaseReaderWriter();

          await this.esploader.hardReset(false);
          this.logger.log("已发送设备重置，设备正在重启...");

          // 关键：hardReset 消耗流
          // 需要在 Improv 可以使用端口前重新创建它们
          await this._releaseReaderWriter();
          this.logger.log("重置后已重新创建流");

          // 等待设备启动
          this.logger.log("等待固件运行以准备好进行 Improv 测试...");
          await sleep(500);
        } catch (resetErr: any) {
          this.logger.log(`重置设备失败：${resetErr.message}`);
          // 继续
        }
      }

      // 关键：再次重新创建流以刷新任何缓冲的固件输出
      // 固件调试消息可能会干扰 Improv 协议
      this.logger.log("在 Improv 初始化前刷新串行缓冲区...");
      await this._releaseReaderWriter();
      await sleep(100);

      improvSerial = new ImprovSerial(this._port, this.logger);
      improvSerial.addEventListener("state-changed", () => {
        this.requestUpdate();
      });
      improvSerial.addEventListener("error-changed", () =>
        this.requestUpdate(),
      );

      // 在成功初始化前不要设置 _client
      this.logger.log("调用 improvSerial.initialize()...");
      const info = await improvSerial.initialize(timeout);

      // 等待固件完成 Wi-Fi 扫描和连接
      // 通过请求当前状态并超时轮询有效 IP 地址（非 0.0.0.0）
      this.logger.log(
        "等待固件获取有效 IP 地址（每 500ms 检查一次，最长 10 秒）...",
      );
      const startTime = Date.now();
      const maxWaitTime = 10000; // 最长 10 秒
      let hasValidIp = false;

      while (Date.now() - startTime < maxWaitTime) {
        // 主动请求当前状态以获取更新的 URL
        try {
          await improvSerial.requestCurrentState();
          const currentUrl = improvSerial.nextUrl;
          if (currentUrl && !currentUrl.includes("0.0.0.0")) {
            this.logger.log(`找到有效 IP：${currentUrl}`);
            hasValidIp = true;
            break;
          }
        } catch (err: any) {
          this.logger.log(`请求当前状态失败：${err.message}`);
        }
        await sleep(500); // 每 500ms 检查一次
      }

      if (!hasValidIp) {
        this.logger.log(
          `${maxWaitTime / 1000} 秒超时 - 使用当前 URL 继续：${improvSerial.nextUrl || "未定义"}`,
        );
      }

      // 成功 - 设置所有值
      this._client = improvSerial;
      this._info = info;
      this._improvSupported = true;
      improvSerial.addEventListener("disconnect", this._handleDisconnect);
      this.logger.log("检测到 Improv Wi-Fi 串行");
      this.logger.log(
        `Improv 状态：${improvSerial.state}，nextUrl：${improvSerial.nextUrl || "未定义"}`,
      );
    } catch (err: any) {
      this.logger.log(`未检测到 Improv Wi-Fi 串行：${err.message}`);
      this._client = null;
      this._info = undefined; // 显式清除信息
      this._improvSupported = false;
      // _improvChecked 已在此方法开始时设置为 true
      this.logger.log(
        `Improv 失败后状态：_client=${this._client}，_info=${this._info}，_improvSupported=${this._improvSupported}，_improvChecked=${this._improvChecked}`,
      );

      // 关键：如果创建了 improvSerial 客户端，请关闭它
      // 即使 initialize() 失败，客户端也可能已打开流
      if (improvSerial) {
        try {
          this.logger.log("关闭失败的 Improv 客户端...");
          await improvSerial.close();
          this.logger.log("失败的 Improv 客户端已关闭");

          // 关键：等待流完全释放
          await sleep(200);
        } catch (closeErr: any) {
          this.logger.log(`关闭 Improv 客户端失败：${closeErr.message}`);
        }
      }

      // 关键：即使失败，Improv 测试也会消耗流
      // 需要重新创建它们，以便控制台/其他功能可以工作
      try {
        await this._releaseReaderWriter();
        this.logger.log("Improv 失败后已重新创建流");
      } catch (releaseErr: any) {
        this.logger.log(`重新创建流失败：${releaseErr.message}`);
      }
    }

    // Improv 检查完成后禁用菜单
    this._busy = false;

    // 检查用户是否在重新连接后请求了特定操作
    if (this._openConsoleAfterReconnect) {
      this.logger.log("按用户请求打开控制台");
      this._openConsoleAfterReconnect = false; // 重置标志

      // 关键：在打开控制台前关闭 Improv 客户端
      if (this._client) {
        try {
          await this._closeClientWithoutEvents(this._client);
          this.logger.log("打开控制台前已关闭 Improv 客户端");
        } catch (e) {
          this.logger.log("关闭 Improv 客户端失败：", e);
        }
        this._client = undefined;

        // 关闭客户端后等待端口准备就绪
        await sleep(200);
      }

      // 确保所有锁已释放
      await this._releaseReaderWriter();

      this._state = "LOGS";
    } else if (this._visitDeviceAfterReconnect) {
      this.logger.log("按用户请求打开访问设备 URL");
      this._visitDeviceAfterReconnect = false; // 重置标志
      if (this._client && this._client.nextUrl) {
        window.open(this._client.nextUrl, "_blank");
      }
      this._state = "DASHBOARD";
    } else if (this._addToHAAfterReconnect) {
      this.logger.log("按用户请求打开 Home Assistant URL");
      this._addToHAAfterReconnect = false; // 重置标志
      if (this._manifest.home_assistant_domain) {
        window.open(
          `https://my.home-assistant.io/redirect/config_flow_start/?domain=${this._manifest.home_assistant_domain}`,
          "_blank",
        );
      }
      this._state = "DASHBOARD";
    } else if (this._changeWiFiAfterReconnect) {
      this.logger.log("按用户请求打开 Wi-Fi 配置");
      this._changeWiFiAfterReconnect = false; // 重置标志

      // 关闭 Improv 客户端并重新初始化以进行 Wi-Fi 设置
      if (this._client) {
        try {
          await this._closeClientWithoutEvents(this._client);
        } catch (e) {
          this.logger.log("关闭 Improv 客户端失败：", e);
        }
        this._client = undefined;

        // 关闭客户端后等待端口准备就绪
        await sleep(200);
      }

      // 不同类型设备的处理：
      // - WebSerial：只释放锁
      // - WebUSB CDC：执行 hardReset + 释放锁
      // - WebUSB 外部串行：只释放锁
      const isWebUsbExternal = await this._isWebUsbWithExternalSerial();
      const isWebUsbCdc =
        this.esploader.isWebUSB &&
        this.esploader.isWebUSB() &&
        !isWebUsbExternal;

      if (isWebUsbCdc) {
        // WebUSB CDC 需要 hardReset
        this.logger.log("WebUSB CDC：重置设备以进行 Wi-Fi 设置...");

        try {
          await this.esploader.hardReset(false);
          this.logger.log("设备重置完成");
        } catch (err: any) {
          this.logger.log(`重置错误：${err.message}`);
        }

        await this._releaseReaderWriter();
        await sleep(200);
      } else {
        // WebSerial 或 WebUSB 外部串行：只释放锁
        if (isWebUsbExternal) {
          this.logger.log("WebUSB 外部串行：准备端口以进行 Wi-Fi 设置...");
        } else {
          this.logger.log("WebSerial：准备端口以进行 Wi-Fi 设置...");
        }

        await this._releaseReaderWriter();
        await sleep(200);
      }

      this.logger.log("端口已准备好进行 Wi-Fi 设置");

      // 关键：再次重新创建流以刷新任何缓冲的固件输出
      // 固件调试消息可能会干扰 Improv 协议
      this.logger.log("在 Improv 初始化前刷新串行缓冲区...");
      await this._releaseReaderWriter();
      await sleep(100);

      // 重新创建 Improv 客户端以进行 Wi-Fi 配置
      this.logger.log("重新初始化 Improv 串行以进行 Wi-Fi 设置");
      const client = new ImprovSerial(this._port, this.logger);
      client.addEventListener("state-changed", () => {
        this.requestUpdate();
      });
      client.addEventListener("error-changed", () => this.requestUpdate());
      try {
        // 使用 10 秒超时，允许设备获取 IP 地址
        this._info = await client.initialize(10000);
        this._client = client;
        client.addEventListener("disconnect", this._handleDisconnect);
        this.logger.log("Improv 客户端已准备好进行 Wi-Fi 配置");
        this._state = "PROVISION";
        this._provisionForce = true;
      } catch (improvErr: any) {
        try {
          await this._closeClientWithoutEvents(client);
        } catch (closeErr) {
          this.logger.log("初始化错误后关闭 Improv 客户端失败：", closeErr);
        }
        this.logger.log(`Improv 初始化失败：${improvErr.message}`);
        this._error = `Improv 初始化失败：${improvErr.message}`;
        this._state = "ERROR";
      }
    } else {
      this._state = "DASHBOARD";
    }

    // 如果对话框从 DOM 中移除，重新添加它
    if (!this.parentNode) {
      document.body.appendChild(this);
      this.logger.log("对话框已重新添加到 DOM");
    }

    this.requestUpdate(); // 状态更改后强制 UI 更新

    // 额外检查以确保对话框可见
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  private async _handleClose() {
    if (this._client) {
      await this._closeClientWithoutEvents(this._client);
    }
    fireEvent(this, "closed" as any);
    this.parentNode!.removeChild(this);
  }

  /**
   * 返回设备是否运行与清单相同的固件。
   */
  private get _isSameFirmware() {
    return !this._info
      ? false
      : this.overrides?.checkSameFirmware
        ? this.overrides.checkSameFirmware(this._manifest, this._info)
        : this._info.firmware === this._manifest.name;
  }

  /**
   * 返回设备是否运行与清单相同的固件和版本。
   */
  private get _isSameVersion() {
    return (
      this._isSameFirmware && this._info!.version === this._manifest.version
    );
  }

  private async _closeClientWithoutEvents(client: ImprovSerial) {
    // 关键：在关闭前始终移除事件监听器
    // 这可以防止触发断开连接事件并显示错误对话框
    client.removeEventListener("disconnect", this._handleDisconnect);

    // 然后关闭客户端
    await client.close();
  }

  static styles = [
    dialogStyles,
    css`
      :host {
        --mdc-dialog-max-width: 390px;
      }
      ewt-icon-button {
        position: absolute;
        right: 4px;
        top: 10px;
      }
      .table-row {
        display: flex;
      }
      .table-row.last {
        margin-bottom: 16px;
      }
      .table-row svg {
        width: 20px;
        margin-right: 8px;
      }
      ewt-textfield,
      ewt-select {
        display: block;
        margin-top: 16px;
      }
      .dashboard-buttons {
        margin: 0 0 -16px -8px;
      }
      .dashboard-buttons div {
        display: block;
        margin: 4px 0;
      }
      a.has-button {
        text-decoration: none;
      }
      .error {
        color: var(--improv-danger-color);
      }
      .danger {
        --mdc-theme-primary: var(--improv-danger-color);
        --mdc-theme-secondary: var(--improv-danger-color);
      }
      button.link {
        background: none;
        color: inherit;
        border: none;
        padding: 0;
        font: inherit;
        text-align: left;
        text-decoration: underline;
        cursor: pointer;
      }
      :host([state="LOGS"]) ewt-dialog {
        --mdc-dialog-max-width: 90vw;
      }
      ewt-console {
        width: calc(80vw - 48px);
        height: 80vh;
      }
      :host([state="PARTITIONS"]) ewt-dialog {
        --mdc-dialog-max-width: 800px;
      }
      :host([state="LITTLEFS"]) ewt-dialog {
        --mdc-dialog-max-width: 95vw;
        --mdc-dialog-max-height: 90vh;
      }
      :host([state="LITTLEFS"]) .mdc-dialog__content {
        padding: 10px 20px;
      }
      :host([state="LITTLEFS"]) ewt-littlefs-manager {
        display: block;
        max-width: 100%;
      }
      .partition-list {
        max-height: 60vh;
        overflow-y: auto;
      }
      .partition-table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
      }
      .partition-table th,
      .partition-table td {
        padding: 8px 12px;
        text-align: left;
        border: 1px solid #ccc;
      }
      .partition-table th {
        font-weight: 600;
        background-color: #f0f0f0;
        position: sticky;
        top: 0;
      }
      .partition-table tbody tr:hover {
        background-color: rgba(3, 169, 244, 0.1);
      }
    `,
  ];
}

customElements.define("ewt-install-dialog", EwtInstallDialog);

declare global {
  interface HTMLElementTagNameMap {
    "ewt-install-dialog": EwtInstallDialog;
  }
}
