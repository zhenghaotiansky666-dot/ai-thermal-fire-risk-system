# 热感哨兵 · Android 安装包（TWA 工程）

这个目录把网页版打包成**安卓 APK / AAB**（Google 官方的 Trusted Web Activity 方式：
一个真正的 App，全屏打开我们的站点，内容与 PWA 完全一致）。

## 为什么需要它

- iPhone 用描述文件（`.mobileconfig`）装到主屏幕；**安卓没有等价的安装文件**——
  Chrome 的“安装应用”是 PWA，不产生可分发文件；
- 要给住户“一个能下载安装的安卓包”，就得打 APK。这一步必须在装了 Android SDK 的机器上执行
  （Android Studio 打开本目录，或命令行 `./gradlew assembleRelease`），工程已经写好。

## 构建（3 步）

```bash
# 1) 换域名只改两处：app/src/main/res/values/strings.xml 的 host / launch_url，
#    以及 app/build.gradle 的 applicationId（如需）

# 2) 生成签名密钥（只需一次，务必保管好 keystore 与密码）
keytool -genkey -v -keystore thermal-guard.keystore -alias thermalguard \
  -keyalg RSA -keysize 2048 -validity 10000

# 3) 打包（需要 JDK 17 + Android SDK；Android Studio 里 Build → Build APK 也一样）
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

## 装到手机

- 把 APK 发到手机（邮件 / 网盘 / 微信），点开安装；首次需允许“安装未知来源应用”。
- 或上传到内测分发（Firebase App Distribution、蒲公英等），发个链接给住户。

## 让地址栏消失（TWA 校验，可选但推荐）

1. 取签名指纹：`keytool -list -v -keystore thermal-guard.keystore -alias thermalguard`
2. 把 SHA-256 指纹与包名填进 `public/.well-known/assetlinks.json`（仓库已放模板）；
3. 部署后确认 `https://<站点>/.well-known/assetlinks.json` 可访问，安卓不再显示地址栏。

## 与网页版的关系

- 网页版（PWA）始终可用，不依赖本工程；
- 打出的 APK 只做两件事：全屏打开我们的 HTTPS 站点、走系统权限；
  网页更新后 App 不需要重新发版。
