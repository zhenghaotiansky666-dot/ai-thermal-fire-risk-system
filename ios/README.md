# FireAegis · iOS

两个 App，一套核心逻辑：

| Target | 定位 | 主界面 |
| --- | --- | --- |
| `ThermalGuardUser` | **用户端**：火灾逃生路线指引 | 指南针式单屏表盘 |
| `ThermalGuardSystem` | **系统检测端**：消防监控 | 城市热力地图 / 现场监控 / 检测 / 预警 / 逃生 |

## 结构

```
ios/ThermalGuard/
  project.yml                 XcodeGen 工程描述（改结构就改它）
  ThermalGuard.xcodeproj      生成产物，已入库方便直接打开
  Sources/Core/               两个 App 共享
    Building.swift            楼宇拓扑（8 层 / A、B 梯 / 正门 / 天台）
    Evacuation.swift          危险扩散 + A* 动态避障 + 逃生指令
    ThermalFrame.swift        热像帧、热区检测、风险分级、城市点位
    Theme.swift               主题色（与网页端同一套 token）
  Sources/User/               用户端：表盘、朝向、位置、状态
  Sources/System/             系统端：地图、检测、预警、报警
    LiveMonitorView.swift     现场监控：HLS 用 AVPlayer、MJPEG 用 WebView、内置演示流
  Info/                       生成的两份 Info.plist
```

核心算法与 Web 端 `src/mobile/building.js`、`evacuation.js`、`thermal.js` 同构，
三端（网页 / iOS / macOS）算出的路线与风险等级应当一致。

## 构建与运行

```bash
cd ios/ThermalGuard

# 需要 XcodeGen 时（改过 project.yml 才需要）
xcodegen generate

# 命令行构建
xcodebuild -project ThermalGuard.xcodeproj -scheme ThermalGuardUser \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build

# 装到模拟器并运行
xcrun simctl boot 'iPhone 17 Pro'
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/ThermalGuardUser.app
xcrun simctl launch booted com.thermalguard.user
```

## 测试

核心逻辑的单元测试（11 项），断言与 Web 端 `tests/*.test.mjs` 同一组不变量：

```bash
xcodebuild -project ThermalGuard.xcodeproj -scheme ThermalGuardCoreTests \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

覆盖：无火情路线距离 76 米、避开起火楼梯、站在火源点仍能撤离、
出口全封时给出避险提示、向下通道中断改走天台、危险半径随时间增长、
方位角与方位词映射、三种工况的风险分级与阈值可配置。

## 演示与截图用启动参数

| 参数 | 作用 |
| --- | --- |
| `-demoFire` | 启动即进入火警 / 演练状态 |
| `-demoFloor 6` | 用户端指定所在楼层 |
| `-fixedNorth` | 用户端强制固定指北（不申请方向权限，截图与回归用） |
| `-startTab map\|detect\|alerts\|escape` | 系统端指定初始标签 |

> `-startTab` 还支持 `monitor`（现场监控）。

例如：

```bash
xcrun simctl launch booted com.thermalguard.user -demoFire -demoFloor 6
xcrun simctl launch booted com.thermalguard.system -startTab map -demoFire
```

## 资源打包的注意点

`project.yml` 里资源目录要写在 target 的 **`sources`** 下（XcodeGen 会按文件类型自动归类到
Copy Bundle Resources）。XcodeGen **没有** `resources:` 这个键，写了会被静默忽略——
表现为 AppIcon 不生效、内置演示流 `demo-live.gif` 找不到。改完可用下面的方式确认：

```bash
grep -c demo-live.gif ThermalGuard.xcodeproj/project.pbxproj   # 应大于 0
ls <DerivedData>/Build/Products/Debug-iphonesimulator/ThermalGuardSystem.app/
# 应当能看到 demo-live.gif 与 Assets.car
```

## 两个 App 之间的警情联动

系统端的全屏报警里有一个「推送警情到用户端」按钮，会打开：

```
thermalguarduser://fire?floor=6
```

用户端注册了 `thermalguarduser` scheme，收到后直接进入对应楼层的撤离状态
（`thermalguarduser://clear` 则回到常态）。解析逻辑在 `Core/FireLink.swift`，有单元测试覆盖。

注意：这是**演示手段**。真实产品应当由后端经 APNs 下发报警，
这样用户端在锁屏、静音下也能被叫醒；URL scheme 只在用户端处于可被唤起的状态时才有效。

另外在模拟器上用 `xcrun simctl openurl` 测试时，iOS 会先弹一个系统确认框
（因为请求来自 App 之外），点掉才会进 App；真机上从系统端 App 内点击按钮则直接打开。

## 已知前置条件

- 部署目标 iOS 17.0，Swift 5 语言模式
- 用户端的真机罗盘需要定位权限（`NSLocationWhenInUseUsageDescription` 已配置）；
  拿不到权限时自动保持固定指北
- 两个 App 之间目前各自独立，真实部署时由后端经 APNs 下发报警；
  同一台设备上跨 App 共享火情状态需要配置 App Group
