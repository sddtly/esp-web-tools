import type { InstallButton } from "./install-button.js";
import { connect as esptoolConnect } from "tasmota-webserial-esptool";

/**
 * 检测是否在 Android 上运行
 */
const isAndroid = (): boolean => {
  const userAgent = navigator.userAgent || "";
  return /Android/i.test(userAgent);
};

/**
 * 为 Android 加载 WebUSB 串行包装器
 */
const loadWebUSBSerial = async (): Promise<void> => {
  // 检查是否已加载
  if ((globalThis as any).requestSerialPort) {
    return;
  }

  // 从 npm 包动态加载 WebUSB 串行脚本
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src =
      "https://unpkg.com/tasmota-webserial-esptool/js/webusb-serial.js";
    script.onload = () => {
      if ((globalThis as any).requestSerialPort) {
        resolve();
      } else {
        reject(new Error("WebUSB 串行脚本已加载但未找到 requestSerialPort"));
      }
    };
    script.onerror = () => reject(new Error("加载 WebUSB 串行脚本失败"));
    document.head.appendChild(script);
  });
};

export const connect = async (button: InstallButton) => {
  import("./install-dialog.js");
  // Android：首先加载 WebUSB 支持
  if (isAndroid() && "usb" in navigator) {
    try {
      await loadWebUSBSerial();
    } catch (err: any) {
      alert(`加载 WebUSB 支持失败：${err.message}`);
      return;
    }
  }

  // 使用 tasmota-webserial-esptool 的 connect() - 处理所有端口逻辑
  let esploader;
  try {
    esploader = await esptoolConnect({
      log: () => {}, // 连接时静默记录
      debug: () => {},
      error: (msg: string) => console.error(msg),
    });
  } catch (err: any) {
    if ((err as DOMException).name === "NotFoundError") {
      import("./no-port-picked/index").then((mod) =>
        mod.openNoPortPickedDialog(() => connect(button)),
      );
      return;
    }
    alert(`连接失败：${err.message}`);
    return;
  }

  if (!esploader) {
    alert("无法连接到设备");
    return;
  }

  const el = document.createElement("ewt-install-dialog");
  el.esploader = esploader; // 传递 ESPLoader 而不是端口
  el.manifestPath = button.manifest || button.getAttribute("manifest")!;
  el.overrides = button.overrides;
  el.firmwareFile = button.firmwareFile;

  // 从属性获取波特率或使用默认值
  const baudRateAttr = button.getAttribute("baud-rate");
  if (baudRateAttr) {
    const baudRate = parseInt(baudRateAttr, 10);
    if (!isNaN(baudRate)) {
      el.baudRate = baudRate;
    }
  } else if (button.baudRate !== undefined) {
    el.baudRate = button.baudRate;
  }

  el.addEventListener(
    "closed",
    async () => {
      try {
        await esploader.disconnect();
      } catch (err) {
        // 忽略断开连接错误
      }
    },
    { once: true },
  );
  document.body.appendChild(el);
};
