import Foundation

// 热像帧与风险分级：与 Web 端 thermal.js 同一套阈值与热区检测规则，
// 保证系统端在 iPhone、网页、macOS 三处看到的风险等级一致。

enum RiskLevel: String {
    case high, medium, low

    var label: String {
        switch self {
        case .high: return "高风险"
        case .medium: return "中风险"
        case .low: return "低风险"
        }
    }

    var advice: String {
        switch self {
        case .high: return "立即疏散"
        case .medium: return "现场核查"
        case .low: return "持续观察"
        }
    }
}

struct HotSpot: Identifiable {
    let id = UUID()
    let x: Double   // 百分比
    let y: Double
    let width: Double
    let height: Double
    let temperature: Double
}

struct ThermalFrame {
    let width: Int
    let height: Int
    let temperatures: [Double]
    let minTemp: Double
    let maxTemp: Double
    let averageTemp: Double
    let hotspots: [HotSpot]
    let source: String
    let capturedAt: Date

    static let defaultThresholds = (high: 65.0, medium: 45.0)

    func risk(high: Double = defaultThresholds.high, medium: Double = defaultThresholds.medium) -> RiskLevel {
        if maxTemp >= high { return .high }
        if maxTemp >= medium { return .medium }
        return .low
    }

    /// 模拟工况：normal 室温、warming 缓慢升温、fire 火情，与网页端三种工况一致
    enum Profile: String, CaseIterable, Identifiable {
        case normal, warming, fire
        var id: String { rawValue }
        var label: String {
            switch self {
            case .normal: return "正常运行"
            case .warming: return "缓慢升温"
            case .fire: return "高温火情"
            }
        }
    }

    static func simulated(phase: Double, profile: Profile = .normal) -> ThermalFrame {
        let width = 32
        let height = 24
        let gain: Double
        switch profile {
        case .fire: gain = 1
        case .warming: gain = 0.08 + 0.62 * min(phase / 40, 1)
        case .normal: gain = 0.05
        }

        var temperatures: [Double] = []
        temperatures.reserveCapacity(width * height)

        for y in 0..<height {
            for x in 0..<width {
                let nx = Double(x) / Double(width - 1)
                let ny = Double(y) / Double(height - 1)
                let drift = sin(phase * 0.055) * 4
                let second = cos(phase * 0.031) * 3
                let base = 27.5 + 3.5 * (1 - ny) + 0.9 * sin(nx * 8)
                let hotA = (60 + drift) * gain * exp(-(pow(nx - 0.35, 2) + pow(ny - 0.34, 2)) / 0.019)
                let hotB = (39 + second) * gain * exp(-(pow(nx - 0.72, 2) + pow(ny - 0.28, 2)) / 0.027)
                let hotC = (21 + drift * 0.4) * gain * exp(-(pow(nx - 0.79, 2) + pow(ny - 0.70, 2)) / 0.031)
                temperatures.append(base + hotA + hotB + hotC)
            }
        }

        let maxTemp = temperatures.max() ?? 0
        let minTemp = temperatures.min() ?? 0
        let average = temperatures.reduce(0, +) / Double(temperatures.count)

        return ThermalFrame(
            width: width,
            height: height,
            temperatures: temperatures,
            minTemp: minTemp,
            maxTemp: maxTemp,
            averageTemp: average,
            hotspots: detectHotspots(width: width, height: height, temperatures: temperatures, maxTemp: maxTemp, averageTemp: average),
            source: "模拟热像仪 · \(profile.label)",
            capturedAt: Date()
        )
    }

    /// 从温度矩阵实时检测热区：阈值同时要求「明显高于全画幅均温」和「接近本帧最高温」
    static func detectHotspots(width: Int, height: Int, temperatures: [Double], maxTemp: Double, averageTemp: Double) -> [HotSpot] {
        let threshold = max(averageTemp + 6, maxTemp - 24)
        var candidates: [(x: Int, y: Int, temp: Double)] = []

        for y in 0..<height {
            for x in 0..<width {
                let temp = temperatures[y * width + x]
                if temp >= threshold { candidates.append((x, y, temp)) }
            }
        }
        candidates.sort { $0.temp > $1.temp }

        var picked: [(x: Int, y: Int, temp: Double)] = []
        for candidate in candidates {
            if picked.count >= 3 { break }
            if picked.contains(where: { abs($0.x - candidate.x) < 5 && abs($0.y - candidate.y) < 5 }) { continue }
            picked.append(candidate)
        }

        return picked.map { spot in
            HotSpot(
                x: max(2, min(80, Double(spot.x) / Double(width) * 100 - 8)),
                y: max(2, min(74, Double(spot.y) / Double(height) * 100 - 10)),
                width: 18,
                height: 22,
                temperature: spot.temp
            )
        }
    }
}

// 城市热力地图上的点位：真实部署时由设备的 GPS 上报替换
struct AlarmPoint: Identifiable {
    let id: String
    let name: String
    let area: String
    let latitude: Double
    let longitude: Double
    let risk: RiskLevel
    let temperature: Double
    let hotspots: Int
    let time: String

    static let demo: [AlarmPoint] = [
        AlarmPoint(id: "must-p11", name: "演示楼 P11", area: "氹仔", latitude: 22.1516, longitude: 113.5676, risk: .high, temperature: 86.4, hotspots: 3, time: "19:42"),
        AlarmPoint(id: "taipa-old", name: "氹仔旧城区", area: "氹仔", latitude: 22.1536, longitude: 113.5580, risk: .medium, temperature: 52.8, hotspots: 1, time: "16:08"),
        AlarmPoint(id: "lam-ma-tau", name: "黑沙环唐楼群", area: "澳门半岛", latitude: 22.2076, longitude: 113.5520, risk: .high, temperature: 91.2, hotspots: 2, time: "18:25"),
        AlarmPoint(id: "coloane", name: "路环市区旧楼", area: "路环", latitude: 22.1160, longitude: 113.5520, risk: .low, temperature: 38.6, hotspots: 0, time: "11:02"),
        AlarmPoint(id: "hengqin", name: "横琴口岸人才公寓", area: "横琴", latitude: 22.1390, longitude: 113.5400, risk: .medium, temperature: 49.5, hotspots: 1, time: "14:37"),
        AlarmPoint(id: "hk-mongkok", name: "旺角旧楼", area: "香港", latitude: 22.3193, longitude: 114.1694, risk: .high, temperature: 88.1, hotspots: 3, time: "20:11"),
    ]
}
