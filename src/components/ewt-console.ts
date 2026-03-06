import { ColoredConsole, coloredConsoleStyles } from "../util/console-color";
import { sleep } from "../util/sleep";
import { LineBreakTransformer } from "../util/line-break-transformer";
import { Logger } from "../const";

export class EwtConsole extends HTMLElement {
  public port!: SerialPort;
  public logger!: Logger;
  public allowInput = true;
  public onReset?: () => Promise<void>;

  private _console?: ColoredConsole;
  private _cancelConnection?: () => Promise<void>;

  public logs(): string {
    return this._console?.logs() || "";
  }

  public connectedCallback() {
    if (this._console) {
      return;
    }
    const shadowRoot = this.attachShadow({ mode: "open" });

    shadowRoot.innerHTML = `
      <style>
        :host, input {
          background-color: #1c1c1c;
          color: #ddd;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier,
            monospace;
          line-height: 1.45;
          display: flex;
          flex-direction: column;
        }
        form {
          display: flex;
          align-items: center;
          padding: 0 8px 0 16px;
        }
        input {
          flex: 1;
          padding: 4px;
          margin: 0 8px;
          border: 0;
          outline: none;
        }
        ${coloredConsoleStyles}
      </style>
      <div class="log"></div>
      ${
        this.allowInput
          ? `<form>
                >
                <input autofocus>
              </form>
            `
          : ""
      }
    `;

    this._console = new ColoredConsole(this.shadowRoot!.querySelector("div")!);

    if (this.allowInput) {
      const input = this.shadowRoot!.querySelector("input")!;

      this.addEventListener("click", () => {
        // 仅在用户未选中文本时聚焦输入框
        if (getSelection()?.toString() === "") {
          input.focus();
        }
      });

      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          this._sendCommand();
        }
      });
    }

    const abortController = new AbortController();
    const connection = this._connect(abortController.signal);
    this._cancelConnection = () => {
      abortController.abort();
      return connection;
    };
  }

  private async _connect(abortSignal: AbortSignal) {
    this.logger.debug("开始控制台读取循环");

    // 检查 port.readable 是否可用
    if (!this.port.readable) {
      this._console!.addLine("");
      this._console!.addLine("");
      this._console!.addLine(`终端断开连接：端口可读流不可用`);
      this.logger.error("端口可读流不可用 - 可能需要以正确波特率重新打开端口");
      return;
    }

    try {
      await this.port
        .readable!.pipeThrough(
          new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
          {
            signal: abortSignal,
          },
        )
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              this._console!.addLine(chunk.replace("\r", ""));
            },
          }),
        );
      if (!abortSignal.aborted) {
        this._console!.addLine("");
        this._console!.addLine("");
        this._console!.addLine("终端断开连接");
      }
    } catch (e) {
      this._console!.addLine("");
      this._console!.addLine("");
      this._console!.addLine(`终端断开连接：${e}`);
    } finally {
      await sleep(100);
      this.logger.debug("控制台读取循环结束");
    }
  }

  private async _sendCommand() {
    const input = this.shadowRoot!.querySelector("input")!;
    const command = input.value;
    const encoder = new TextEncoder();
    const writer = this.port.writable!.getWriter();
    await writer.write(encoder.encode(command + "\r\n"));
    this._console!.addLine(`> ${command}\r\n`);
    input.value = "";
    input.focus();
    try {
      writer.releaseLock();
    } catch (err) {
      console.error("忽略释放锁错误", err);
    }
  }

  public async disconnect() {
    if (this._cancelConnection) {
      await this._cancelConnection();
      this._cancelConnection = undefined;
    }
  }

  public async reset() {
    this.logger.debug("触发重置。");
    if (this.onReset) {
      try {
        await this.onReset();
      } catch (err) {
        this.logger.error("重置回调失败：", err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

customElements.define("ewt-console", EwtConsole);

declare global {
  interface HTMLElementTagNameMap {
    "ewt-console": EwtConsole;
  }
}
