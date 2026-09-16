// ============================================================================
// 热感哨兵 · 硬件固件（Web/系统端同事已代为修正 3 处，请核对后烧录）
//
// 改动 1（必须）：thermalServerUrl 原来是 "http://10.240.250"，少了端口与路径，
//                 热像数据发不出去 —— 已补全为 http://<电脑IP>:8787/upload_thermal
// 改动 2（必须）：serverUrl 的端口与路径已统一为 /upload（请把 IP 换成演示电脑的局域网 IP）
// 改动 3（提示）：两处引脚冲突（GPIO 2 / GPIO 4 被相机数据脚与 I2C/烟雾共用），
//                 已在对应位置标 TODO，请按实际接线确认（我无法验证你们的板子）
//
// 提示：在电脑上运行 `node tools/hardware-receiver.mjs --port 8787 --print-firmware`
//       会自动打印出"带当前电脑局域网 IP"的这两行，直接粘贴替换最省事。
// ============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_MLX90640.h>
#include "esp_camera.h"
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>
#include <ArduinoJson.h>
// ==================== 1. 硬件引脚与参数配置 ====================
#define I2C_SDA       1         // MLX90640 数据引脚
#define I2C_SCL       2         // TODO(引脚冲突)：GPIO 2 同时被相机数据脚 Y4_GPIO_NUM 使用，请确认实际接线
#define BUZZER_PIN    3         // DZQJ 有源蜂鸣器控制引脚
#define SMOKE_PIN     4         // TODO(引脚冲突)：GPIO 4 同时被相机数据脚 Y5_GPIO_NUM 使用，请确认实际接线

// Wi-Fi 账号密码（请修改为你现场的 Wi-Fi）
const char* ssid     = "你的WiFi名称";   // 必须填现场 Wi-Fi（ESP32 仅支持 2.4G，手机热点也可）
const char* password = "你的WiFi密码";

// Windows 电脑本地 AI 接收端地址（请修改为你电脑的实际 IP）
// TODO(部署时替换 IP)：用 node tools/hardware-receiver.mjs --print-firmware 打印这一行
const char* serverUrl        = "http://192.168.1.100:8787/upload";         // 可见光照片接收地址
const char* thermalServerUrl = "http://192.168.1.100:8787/upload_thermal"; // 原值少了端口与路径，已补全

// 蓝牙广播专属 UUID（保持默认，方便 AI 端扫描过滤）
#define SERVICE_UUID "7c2b8e7a-6f4d-4a9a-9b1f-2d3e4f5a6b7c"

// ==================== 2. 全局对象声明 ====================
Adafruit_MLX90640 mlx;
float mlxFrame[32 * 24]; // 存储热成像温度矩阵
BLEAdvertising *pAdvertising;
bool isFireConfirmed = false; // AI 终审火灾状态位

// CAMERA_MODEL_AI_THINKER 引脚映射（市面绝大多数 S3-CAM 的标准引脚）
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     21
#define SIOC_GPIO_NUM     14
#define Y9_GPIO_NUM       11
#define Y8_GPIO_NUM       9
#define Y7_GPIO_NUM       8
#define Y6_GPIO_NUM       6
#define Y5_GPIO_NUM       4
#define Y4_GPIO_NUM       2
#define Y3_GPIO_NUM       15
#define Y2_GPIO_NUM       13
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     12
// 👈 功能一：将 768 个原始温度数字打包成 JSON 字符串发送给队友的软件
void uploadThermalData(float* frameBuffer, float maxTemp) {
    if (WiFi.status() == WL_CONNECTED) {
        HTTPClient http;
        http.begin(thermalServerUrl); 
        http.addHeader("Content-Type", "application/json");

        // 创建硬件动态内存缓冲区存放 JSON
        DynamicJsonDocument doc(16384); 
        doc["max_temp"] = maxTemp;
        
        // 将 768 个浮点数填入 JSON 数组
        JsonArray dataArray = doc.createNestedArray("sensor_data");
        for (int i = 0; i < 768; i++) {
            dataArray.add(frameBuffer[i]);
        }

        String jsonString;
        serializeJson(doc, jsonString);
        
        int httpResponseCode = http.POST(jsonString);
        if (httpResponseCode > 0) {
            Serial.printf("红外数据发送成功，响应码: %d\n", httpResponseCode);
        } else {
            Serial.printf("红外发送失败: %s\n", http.errorToString(httpResponseCode).c_str());
        }
        http.end();
    }
}

// 👈 功能二：组装带着火标志位（0xAA）的硬件级蓝牙广播包
void startBlinkingBlerBroadcast(int smokeValue, float maxTemp) {
    pAdvertising->stop(); // 停止上一次广播

    // 组装 4 个字节的数据包 payload
    uint8_t payload[4];
    payload[0] = (smokeValue >> 8) & 0xFF; // 烟雾高8位
    payload[1] = smokeValue & 0xFF;        // 烟雾低8位
    payload[2] = (uint8_t)maxTemp;         // 热成像最高温整型
    payload[3] = 0xAA;                     // 已着火硬件标志位

    BLEAdvertisementData advData;
    std::string strData((char*)payload, 4);
    advData.setManufacturerData(strData);
    
    pAdvertising->setAdvertisementData(advData);
    pAdvertising->start(); // 全功率发射广播
    Serial.println("【硬件警报】已成功向周围楼道手机发送‘已着火蓝牙广播包’！");
}


// ==================== 3. 硬件初始化函数 ====================
void initCamera() {
    camera_config_t config;
    //config.led_gpio_num = -1;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.frame_size = FRAMESIZE_VGA; // 拍照分辨率 640x480
    config.pixel_format = PIXFORMAT_JPEG; // AI 识别需要 JPEG 格式
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.jpeg_quality = 12;
    config.fb_count = 1;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("OV2640 摄像头初始化失败，错误码: 0x%x\n", err);
    } else {
        Serial.println("OV2640 摄像头初始化成功！");
    }
}

void initMLX90640() {
    Wire.begin(I2C_SDA, I2C_SCL, 400000); 
    if (!mlx.begin(MLX90640_I2CADDR_DEFAULT, &Wire)) {
        Serial.println("未找到 MLX90640 热成像模块！");
    } else {
        mlx.setMode(MLX90640_CHESS);
        mlx.setResolution(MLX90640_ADC_18BIT);
        mlx.setRefreshRate(MLX90640_2_HZ); // 每秒刷新2次
        Serial.println("MLX90640 热成像初始化成功！");
    }
}

// ==================== 4. 核心业务逻辑函数 ====================
// 抓拍并上传到 Windows 本地 AI 端，获取终审结果
bool uploadImageAndGetAIResult() {
    camera_fb_t * fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("摄像头抓拍失败！");
        return false;
    }

    if (WiFi.status() == WL_CONNECTED) {
        HTTPClient http;
        http.begin(serverUrl);
        http.addHeader("Content-Type", "image/jpeg");

        // 发送图片二进制流给 Windows 电脑
        int httpResponseCode = http.POST(fb->buf, fb->len);
        String response = "";

        if (httpResponseCode > 0) {
            response = http.getString();
            Serial.println("Windows AI 终审答复: " + response);
        } else {
            Serial.printf("发送失败，错误码: %s\n", http.errorToString(httpResponseCode).c_str());
        }
        
        esp_camera_fb_return(fb); // 释放相机缓冲区
        http.end();

        if (response == "YES") return true;   // AI 确诊火灾危险
    }
    return false; // 默认为误报或连接失败
}

// ==================== 5. 主程序入口 ====================
void setup() {
    Serial.begin(115200);
    
    // 初始化外设引脚
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW); // 默认蜂鸣器坚决不响
    pinMode(SMOKE_PIN, INPUT);

    // 启动各个模块
    initCamera();
    initMLX90640();

    // 连接 Wi-Fi
    WiFi.begin(ssid, password);
    Serial.print("正在连接 Wi-Fi...");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWi-Fi 已连接！");

    // 初始化蓝牙广播，但先不开广播
    BLEDevice::init("S3_Fire_Detector");
    BLEServer *pServer = BLEDevice::createServer();
    pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);

    Serial.println("系统全部初始化完毕，进入常规监测状态...");
}

void loop() {
    // 1. 读取烟雾传感器模拟量
    int smokeVal = analogRead(SMOKE_PIN);

    // 2. 读取热成像最高温度
    float maxTemp = 0.0;
    if (mlx.getFrame(mlxFrame) == 0) {
        for (int i = 0; i < 768; i++) {
            if (mlxFrame[i] > maxTemp) maxTemp = mlxFrame[i];
        }
    }

    Serial.printf("常态数据 -> 烟雾值: %d | 热成像最高温: %.2f°C\n", smokeVal, maxTemp);

    // 3. 边缘端初步计算判定：如果烟雾超标 且 热成像检测到异常高温
    if ((smokeVal > 2000 || maxTemp > 70.0) && !isFireConfirmed) {
        Serial.println("【异常触发】正在并行发送可见光照片与红外温度矩阵进行送检...");
        
        // 👈 【这里成功加入调用一】发送 768 个原始温度数字给队友的软件
        uploadThermalData(mlxFrame, maxTemp);
        
        // 触发可见光拍照送大模型终审
        if (uploadImageAndGetAIResult()) {
            isFireConfirmed = true; // AI 终审确认为真实火灾！
        } else {
            Serial.println("【安全】AI 判定为误报，警报解除。");
        }
    }

    // 4. 执行 AI 终审后的联动控制（蜂鸣器与蓝牙广播同步）
    if (isFireConfirmed) {
        digitalWrite(BUZZER_PIN, HIGH); // 🚨 蜂鸣器长鸣！
        
        // 👈 【这里成功加入调用二】一旦着火，实时通过蓝牙广播将着火信息散播出去
        startBlinkingBlerBroadcast(smokeVal, maxTemp); 
    } else {
        digitalWrite(BUZZER_PIN, LOW);  // 🔇 保持安静
        pAdvertising->stop();           // 🚫 关闭蓝牙广播
    }

    delay(2000); // 每 2 秒循环一次
}
