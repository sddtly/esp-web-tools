# ESP Web Tools 下一代版本

允许通过浏览器烧录 **Tasmota** 或其他基于 **ESP** 的固件。该工具会自动检测开发板类型，并选择对应支持的固件版本进行烧录。
完整文档请查看官方网站：https://jason2866.github.io/esp-web-tools/

```html
<esp-web-install-button
  manifest="firmware/manifest.json"
></esp-web-install-button>
```

示例 manifest：

```json
{
  "name": "Tasmota",
  "new_install_prompt_erase": true,
  "funding_url": "https://paypal.me/tasmota",
  "new_install_improv_wait_time": 10,
  "builds": [
    {
      "chipFamily": "ESP32",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-C2",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32c2.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-C3",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32c3.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-C5",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32c5.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-C6",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32c6.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-C61",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32c61.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-S2",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32s2.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-S3",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota32/tasmota32s3.factory.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP8266",
      "improv": true,
      "parts": [
        { "path": "../firmware/tasmota/tasmota.bin", "offset": 0 }
      ]
    }
  ]
}
```

---

# 芯片变体支持（ESP32-P4）

对于具有多个硬件版本的芯片（例如 **ESP32-P4**），可以为不同的芯片版本指定不同的固件构建。

```json
{
  "name": "My Firmware",
  "builds": [
    {
      "chipFamily": "ESP32-P4",
      "chipVariant": "rev0",
      "parts": [
        { "path": "firmware_p4_old.bin", "offset": 0 }
      ]
    },
    {
      "chipFamily": "ESP32-P4",
      "chipVariant": "rev300",
      "parts": [
        { "path": "firmware_p4_new.bin", "offset": 0 }
      ]
    }
  ]
}
```

`chipVariant` 字段是可选的。如果未指定，该构建将匹配该芯片系列的任意版本。

完整示例请查看：`manifest-example-p4-variants.json`

---

# 性能

ESP Web Tools 支持可配置的烧录波特率。默认情况下使用 **115200** 波特率，以保证最大的兼容性。
如果提高波特率，可以显著加快烧录速度。

---

# 自定义波特率

可以使用 `baud-rate` 属性自定义波特率：

```html
<!-- 默认：115200 波特率（兼容性最高） -->
<esp-web-install-button manifest="manifest.json">
  <button slot="activate">Install</button>
</esp-web-install-button>

<!-- 高速：2 Mbps（约快 17 倍，推荐现代芯片使用） -->
<esp-web-install-button
  manifest="manifest.json"
  baud-rate="2000000">
  <button slot="activate">Install</button>
</esp-web-install-button>

<!-- 安全模式：460800（约快 4 倍，适用于较旧 USB 转串口芯片，如 CH340） -->
<esp-web-install-button
  manifest="manifest.json"
  baud-rate="460800">
  <button slot="activate">Install</button>
</esp-web-install-button>
```

可用波特率：

```
230400
460800
921600
1500000
2000000
```

---

# 开发

运行：

```
script/develop
```

这会启动一个本地服务器。
然后在浏览器中打开：

```
http://localhost:5004
```
