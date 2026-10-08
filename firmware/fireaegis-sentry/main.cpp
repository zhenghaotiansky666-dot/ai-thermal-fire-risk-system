// ============================================================================
// FireAegis · 智能前线固件（有线以太网优先 + Wi-Fi 灾备自动无缝切换版）
// ============================================================================
#include <Arduino.h>
#include <SPI.h>         
#include <Ethernet.h>    // 有线 W5500 硬件驱动
#include <WiFi.h>        // 无线 Wi-Fi 备用驱动
#include <Wire.h>
#include <Adafruit_MLX90640.h>
#include "esp_camera.h"
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>
#include <ArduinoJson.h>

// ==================== 1. 硬件引脚与参数配置 ====================
#define I2C_SDA       45       // 红外 SDA 插在右排的 G45
#define I2C_SCL       46       // 红外 SCL 插在右排的 G46
#define BUZZER_PIN    3        // 蜂鸣器信号线插在右排的 G3
#define SMOKE_PIN     2        // MQ 烟雾传感器模拟线插在右排的 G2
#define ETH_CS_PIN    14       // W5500 的 SCS 片选线，插在右排的 G14
// W5500 的 SPI 三根线：**必须和实际接线一致**。
// 为什么不能省：ESP32-S3 的默认 SPI 是 GPIO11(MOSI)/GPIO12(SCK)/GPIO13(MISO)，
// 而本固件的摄像头正好占用了 11/12/13，所以 W5500 必须挪到空闲引脚并显式重映射
// （setup 里的 SPI.begin(SCK, MISO, MOSI, CS)）。
#define ETH_SCK_PIN   39       // W5500 时钟线（不能用 12）
#define ETH_MISO_PIN  40       // W5500 主入从出（不能用 13）
#define ETH_MOSI_PIN  41       // W5500 主出从入（不能用 11）

// 有线网卡物理唯一 MAC 地址
byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED }; 

// 🌐 现场无线 Wi-Fi 配置（灾备通道）
const char* ssid     = "iPhone";
const char* password = "66666666";

// 🌐 目标 Mac 的通信矩阵
// 有线与无线是**两个不同的地址**，别再共用一个（这是之前有线连不上的根因）：
//   · 无线灾备：Mac 在 iPhone 热点里的地址 + 5011 端口
const char* wifiServerIP   = "172.20.10.10";
const int   wifiServerPort = 5011;
//   · 有线优先：板子直连 Mac 的那根网线，两端都必须是静态 IP、同一网段
//     Mac 端先执行一次（要管理员密码）：
//       sudo networksetup -setmanual "USB 10/100/1000 LAN" 192.168.1.20 255.255.255.0
const char* ethServerIP   = "192.168.1.20";
const int   ethServerPort = 8787;

// W5500 有线网卡的静态地址（与 Mac 的 192.168.1.20 同网段）
IPAddress ethIp(192, 168, 1, 50);
IPAddress ethSubnet(255, 255, 255, 0);
// 关键：有线这条**不给默认网关**（0.0.0.0）。
// 否则 W5500 会抢走默认路由，Wi-Fi 灾备那条反而发不出去；
// Mac 就在同一网段，同网段通信靠 ARP 直达，本来也不需要网关。
IPAddress noGateway(0, 0, 0, 0);

const char* imagePath   = "/upload";
const char* thermalPath = "/upload_thermal";

#define SERVICE_UUID "7c2b8e7a-6f4d-4a9a-9b1f-2d3e4f5a6b7c"

// ==================== 2. 全局对象与容灾状态位 ====================
Adafruit_MLX90640 mlx;
float mlxFrame[32 * 24]; 
BLEAdvertising *pAdvertising;
bool isFireConfirmed = false; 
bool eth_connected = false;    // 有线网网线物理状态连通标志

// GOOUUU ESP32-S3-CAM V1.5 专属相机引脚映射
#define PWDN_GPIO_NUM     42     
#define RESET_GPIO_NUM    -1     
#define XCLK_GPIO_NUM     15     
#define SIOD_GPIO_NUM     4      
#define SIOC_GPIO_NUM     5      
#define Y9_GPIO_NUM       16     
#define Y8_GPIO_NUM       17     
#define Y7_GPIO_NUM       18     
#define Y6_GPIO_NUM       12     
#define Y5_GPIO_NUM       10     
#define Y4_GPIO_NUM       8      
#define Y3_GPIO_NUM       9      
#define Y2_GPIO_NUM       11     
#define VSYNC_GPIO_NUM    6      
#define HREF_GPIO_NUM     7      
#define PCLK_GPIO_NUM     13     

// 🟢 一次 POST：有线和无线共用同一段 HTTP 逻辑，只是目标地址不同。
// 返回 gotYes —— 只有 Mac 回了 "YES" 才算"确诊火灾"，蜂鸣器才准响。
struct PostResult { bool connected; bool gotYes; };

template <typename Client>
PostResult postTo(Client& client, const char* host, int port, const char* path,
                  uint8_t* payload, size_t payload_len, bool is_json) {
    PostResult result = { false, false };
    if (!client.connect(host, port)) return result;
    result.connected = true;

    client.print("POST "); client.print(path); client.println(" HTTP/1.1");
    client.print("Host: "); client.println(host);
    client.println(is_json ? "Content-Type: application/json" : "Content-Type: image/jpeg");
    client.print("Content-Length: "); client.println(payload_len);
    client.println("Connection: close");
    client.println();
    client.write(payload, payload_len);
    client.flush();

    // 实时接收 Mac 的终审答复（/upload 命中火灾时会回恰好 "YES"）
    unsigned long timeout = millis();
    while (client.connected() && millis() - timeout < 4000) {
        if (client.available()) {
            String line = client.readStringUntil('\r');
            if (line.indexOf("YES") != -1) result.gotYes = true;
        }
    }
    client.stop();
    return result;
}

// 🟢 核心智能路由：优先走有线，连不上或网线断开时自动降级到无线
//
// 现场遇到过"网口一会有一会没"（链路抖动）：如果每次上传都先去试那条抖动的网线，
// 每次都要白等一个连接超时。所以有线失败后冷却 15 秒，这段时间直接走无线，
// 冷却结束再试一次有线——既不耽误上报，也不会白等。
unsigned long ethRetryAfter = 0;

bool sendNativePost(const char* path, uint8_t* payload, size_t payload_len, bool is_json) {
    eth_connected = (Ethernet.linkStatus() == LinkON);

    // 🚀 策略一：物理有线（W5500 直连 Mac，走静态 IP）
    const bool ethReady = eth_connected && millis() >= ethRetryAfter;
    if (ethReady) {
        EthernetClient ethClient;
        PostResult wired = postTo(ethClient, ethServerIP, ethServerPort, path, payload, payload_len, is_json);
        if (wired.connected) {
            Serial.print("【通路：W5500 有线网线】数据已送入 Mac");
            Serial.println(wired.gotYes ? "，终审答复 YES" : "（Mac 回了 NO）");
            ethRetryAfter = 0;                 // 有线好用，取消冷却
            return wired.gotYes;
        }
        // 网线在但连不上：冷却 15 秒，期间直接走无线
        ethRetryAfter = millis() + 15000;
        Serial.println("【有线】网线在但连不上 Mac（检查 Mac 是否已设 192.168.1.20）→ 冷却 15 秒后重试，先走无线…");
    }

    // 🌪️ 策略二：无线灾备
    if (WiFi.status() == WL_CONNECTED) {
        WiFiClient wifiClient;
        PostResult wifi = postTo(wifiClient, wifiServerIP, wifiServerPort, path, payload, payload_len, is_json);
        if (wifi.connected) {
            Serial.println("【⚠️通路切换：Wi-Fi 无线灾备】已自动切回无线通道发射！");
            return wifi.gotYes;
        }
    }
    return false;
}

void uploadThermalData(float* frameBuffer, float maxTemp) {
    DynamicJsonDocument doc(16384); 
    doc["max_temp"] = maxTemp;
    JsonArray dataArray = doc.createNestedArray("sensor_data");
    for (int i = 0; i < 768; i++) dataArray.add(frameBuffer[i]);
    
    String jsonString;
    serializeJson(doc, jsonString);
    
    sendNativePost(thermalPath, (uint8_t*)jsonString.c_str(), jsonString.length(), true);
}

void startBlinkingBlerBroadcast(int smokeValue, float maxTemp) {
    pAdvertising->stop(); 
    uint8_t payload[4];
    payload[0] = (smokeValue >> 8) & 0xFF; 
    payload[1] = smokeValue & 0xFF;        
    payload[2] = (uint8_t)maxTemp;         
    payload[3] = 0xAA;                     

    BLEAdvertisementData advData;
    std::string strData((char*)payload, 4);
    advData.setManufacturerData(strData);
    pAdvertising->setAdvertisementData(advData);
    pAdvertising->start(); 
    Serial.println("【无线广播防线】已向楼道内手机散播无网自救自引导信标包！");
}

void initCamera() {
    camera_config_t config;
    config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000; config.frame_size = FRAMESIZE_VGA;
    config.pixel_format = PIXFORMAT_YUV422; config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    config.fb_location = CAMERA_FB_IN_PSRAM; config.jpeg_quality = 12; config.fb_count = 1;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) Serial.printf("OV2640 摄像头初始化失败: 0x%x\n", err);
    else Serial.println("OV2640 摄像头初始化成功！");
}

void initMLX90640() {
    Wire.begin(I2C_SDA, I2C_SCL, 400000); 
    if (!mlx.begin(MLX90640_I2CADDR_DEFAULT, &Wire)) Serial.println("未找到 MLX90640 热成像模块！");
    else {
        mlx.setMode(MLX90640_CHESS); mlx.setResolution(MLX90640_ADC_18BIT); mlx.setRefreshRate(MLX90640_2_HZ); 
        Serial.println("MLX90640 热成像初始化成功！");
    }
}

bool uploadImageAndGetAIResult() {
    camera_fb_t * fb = esp_camera_fb_get();
    if (!fb) return false;

    uint8_t * jpeg_buf = NULL; size_t jpeg_len = 0; bool is_converted = false;
    if (fb->format == PIXFORMAT_YUV422) is_converted = frame2jpg(fb, 80, &jpeg_buf, &jpeg_len); 

    size_t final_len = is_converted ? jpeg_len : fb->len;
    uint8_t* final_buf = is_converted ? jpeg_buf : fb->buf;

    bool ai_verdict = false;
    if (final_buf && final_len > 0) {
        ai_verdict = sendNativePost(imagePath, final_buf, final_len, false);
    }

    if (is_converted && jpeg_buf) free(jpeg_buf); 
    esp_camera_fb_return(fb);
    return ai_verdict;
}

void setup() {
    Serial.begin(115200);
    
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, HIGH); // 👈 核心修改：开机先给高电平，强行让低电平触发的蜂鸣器闭嘴、保持静音！
    
    // ... 其他初始化保持不动 ...

    initCamera();
    initMLX90640();

    // 🌐 通道 A：唤醒 W5500 硬件有线网口总线
    // 直连 Mac 这条线上没有 DHCP，必须用静态 IP（原来 Ethernet.begin(mac) 走 DHCP 必然失败，
    // 这也正是"网线插着但一直显示不通"的原因）。
    Serial.println("正在拉通物理有线网口（W5500 静态 IP 初始化）...");
    // W5500 走 SPI：显式重映射到实际接线的那几根，避开摄像头的 11/12/13
    SPI.begin(ETH_SCK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
    Ethernet.init(ETH_CS_PIN);
    Serial.printf("【有线自检】SPI 引脚: SCK=%d MISO=%d MOSI=%d CS=%d\n", ETH_SCK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);

    // ── W5500 直达检测：直接读它的版本寄存器（地址 0x0039，正常应返回 0x04）──
    // 这一步绕开所有库逻辑：读到 0x04 就说明"SPI 接线 + 供电"没问题；
    // 读到 0x00/0xFF 就说明芯片根本没被访问到（接线/供电/引脚）。
    pinMode(ETH_CS_PIN, OUTPUT);
    digitalWrite(ETH_CS_PIN, HIGH);
    delay(2);
    digitalWrite(ETH_CS_PIN, LOW);
    delayMicroseconds(5);
    SPI.transfer(0x00);   // 读操作 + 通用寄存器块
    SPI.transfer(0x00);   // 地址高字节
    SPI.transfer(0x39);   // 地址低字节 = 0x0039 (VERSIONR)
    const uint8_t w5500Version = SPI.transfer(0x00);
    digitalWrite(ETH_CS_PIN, HIGH);
    Serial.printf("【W5500 直读】版本寄存器 = 0x%02X（正常应为 0x04）\n", w5500Version);
    if (w5500Version != 0x04) {
        Serial.println("→ SPI 底座不通：查 W5500 的 VCC=3.3V、GND 共地、SCK/MISO/MOSI/CS 四根线是否插实");
    }

    Ethernet.begin(mac, ethIp, noGateway, noGateway, ethSubnet);
    delay(200);
    // 有线自检：把原始状态码打出来，一眼分清是"找不到芯片"还是"网线没通"
    //   hardwareStatus: 0=没找到芯片(SPI通信失败/没供电) 3=W5500 正常
    //   linkStatus    : 1=链路接通(LinkON)             2=链路断开(LinkOFF)
    const uint8_t ethHw = static_cast<uint8_t>(Ethernet.hardwareStatus());
    const uint8_t ethLk = static_cast<uint8_t>(Ethernet.linkStatus());
    Serial.printf("【有线自检】hardwareStatus=%u（0=找不到W5500芯片 / 3=W5500正常）", ethHw);
    Serial.printf("  linkStatus=%u（1=网线接通 / 2=网线断开）\n", ethLk);
    if (ethHw == 0) {
        Serial.println("→ 现象：ESP32 通过 SPI 读不到 W5500。查：①W5500 的 3.3V/GND ②CS=GPIO14 ③SPI 引脚");
        Serial.println("   重点：ESP32-S3 默认 SPI 是 GPIO11(MOSI)/GPIO12(SCK)/GPIO13(MISO)，");
        Serial.println("         而本固件摄像头正好用了 GPIO11/12/13 —— 若 W5500 也接在这三根上就是冲突。");
    }
    if (ethHw == 0 || ethLk == 2) {
        Serial.println("【有线】本次先自动降级走无线。");
        eth_connected = false;
    } else {
        Serial.print("【有线】W5500 就绪，本机 IP: "); Serial.print(Ethernet.localIP());
        Serial.print("  目标 Mac: "); Serial.print(ethServerIP); Serial.print(":"); Serial.println(ethServerPort);
        eth_connected = true;
    }

    // 🌐 通道 B：并发连通备用无线 Wi-Fi
    Serial.print("正在并发连通备用无线 Wi-Fi: "); Serial.println(ssid);
    WiFi.begin(ssid, password);

    BLEDevice::init("FireAegis_Sentry");
    pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);

    Serial.println("FireAegis 边缘双轨冗余防御线全面就绪！");
}

void loop() {
    int smokeVal = analogRead(SMOKE_PIN);
    float maxTemp = 0.0;
    if (mlx.getFrame(mlxFrame) == 0) {
        for (int i = 0; i < 768; i++) { if (mlxFrame[i] > maxTemp) maxTemp = mlxFrame[i]; }
    }

    Serial.printf("常态数据 -> 烟雾值: %d | 红外最高温: %.2f°C | 有线链路: %s\n", 
                  smokeVal, maxTemp, (Ethernet.linkStatus() == LinkON) ? "ON (优先)" : "OFF (断开)");

    // 边缘端双指标容灾判定
    if ((smokeVal > 200 || maxTemp > 32.0) && !isFireConfirmed) {
        uploadThermalData(mlxFrame, maxTemp);
        if (uploadImageAndGetAIResult()) {
            isFireConfirmed = true; 
        }
    }

        // 4. 执行 AI 终审后的联动控制（严格听从大模型指挥防线）
    if (isFireConfirmed) { // 👈 只有大模型回传 YES，isFireConfirmed 变为 true 时才准进来！
        digitalWrite(BUZZER_PIN, LOW); // 👈 拉低电平，触发你的蜂鸣器破空狂鸣！
        Serial.println("🚨🚨🚨【FireAegis 最终大警报】多模态大模型终审确诊火灾！授权物理蜂鸣器轰鸣！");
        startBlinkingBlerBroadcast(smokeVal, maxTemp); 
    } else {
        // 🟢 只要大模型没有判定为真火灾，或者判定为误报（NO），全盘强制静音！
        digitalWrite(BUZZER_PIN, HIGH); // 👈 保持高电平，锁死蜂鸣器让它绝对闭嘴！
        pAdvertising->stop();           
    }


    delay(2000); 
}
