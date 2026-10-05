// 系统检测端 · 城市热力地图
// 作用：在指挥视角下明确「火警发生在城市的哪个位置」，按风险强度铺热力斑块。
// 瓦片不可用时自动降级为纯黑示意场（热力斑与相对位置仍然正确）。

import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Crosshair, Flame, MapPin, ShieldAlert, Thermometer } from 'lucide-react'

// 演示点位：澳门（含横琴）与香港，真实部署时由设备的 GPS 上报替换
const DEMO_POINTS = [
  { id: 'must-p11', name: '演示楼 P11', area: '氹仔', lat: 22.1516, lng: 113.5676, risk: 'high', temp: 86.4, hotspots: 3, at: '19:42' },
  { id: 'taipa-old', name: '氹仔旧城区', area: '氹仔', lat: 22.1536, lng: 113.558, risk: 'medium', temp: 52.8, hotspots: 1, at: '16:08' },
  { id: 'lam-ma-tau', name: '黑沙环唐楼群', area: '澳门半岛', lat: 22.2076, lng: 113.552, risk: 'high', temp: 91.2, hotspots: 2, at: '18:25' },
  { id: 'coloane', name: '路环市区旧楼', area: '路环', lat: 22.116, lng: 113.552, risk: 'low', temp: 38.6, hotspots: 0, at: '11:02' },
  { id: 'hengqin', name: '横琴口岸人才公寓', area: '横琴', lat: 22.139, lng: 113.54, risk: 'medium', temp: 49.5, hotspots: 1, at: '14:37' },
  { id: 'hk-mongkok', name: '旺角旧楼', area: '香港', lat: 22.3193, lng: 114.1694, risk: 'high', temp: 88.1, hotspots: 3, at: '20:11' },
  { id: 'hk-shumshuipo', name: '深水埗三无大厦', area: '香港', lat: 22.3307, lng: 114.1622, risk: 'medium', temp: 55.3, hotspots: 1, at: '13:45' },
  { id: 'hk-kwuntong', name: '观塘工厦', area: '香港', lat: 22.3167, lng: 114.226, risk: 'low', temp: 41.2, hotspots: 0, at: '09:18' },
]

const CENTER = [22.19, 113.72]
const RADIUS = { high: 2600, medium: 1700, low: 950 }
const RISK_LABEL = { high: '高风险', medium: '中风险', low: '低风险' }

export default function CityMap({ fire, activeDevice }) {
  const mapNodeRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const [tileFailed, setTileFailed] = useState(false)
  const [selected, setSelected] = useState(null)

  const points = useMemo(() => {
    const list = [...DEMO_POINTS]
    // 有设备时把设备所在位置替换成实时点位
    if (activeDevice?.lat && activeDevice?.lng) {
      list.unshift({
        id: 'live-device',
        name: activeDevice.name,
        area: activeDevice.location || '现场设备',
        lat: activeDevice.lat,
        lng: activeDevice.lng,
        risk: fire ? 'high' : 'medium',
        temp: fire ? 92 : 48,
        hotspots: fire ? 3 : 1,
        at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        live: true,
      })
    }
    return list
  }, [activeDevice, fire])

  const stats = useMemo(() => ({
    total: points.length,
    high: points.filter((point) => point.risk === 'high').length,
    medium: points.filter((point) => point.risk === 'medium').length,
    low: points.filter((point) => point.risk === 'low').length,
  }), [points])

  useEffect(() => {
    if (mapRef.current || !mapNodeRef.current) return undefined
    const map = L.map(mapNodeRef.current, {
      center: CENTER,
      zoom: 12,
      zoomControl: false,
      attributionControl: false,
      // 用 SVG 渲染矢量层：热力斑依赖 CSS blur 滤镜，canvas 渲染会让滤镜失效
      preferCanvas: false,
    })
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)

    const tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      crossOrigin: true,
    })
    let tileErrors = 0
    tiles.on('tileerror', () => {
      tileErrors += 1
      if (tileErrors >= 3) setTileFailed(true)
    })
    tiles.addTo(map)

    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    points.forEach((point) => {
      const color = point.risk === 'high' ? '#ff3b30' : point.risk === 'medium' ? '#ff9f0a' : '#30d158'

      L.circle([point.lat, point.lng], {
        radius: RADIUS[point.risk],
        className: `heat-blob heat-blob-${point.risk}`,
        stroke: false,
        fillColor: color,
        fillOpacity: 0.5,
        interactive: false,
      }).addTo(layer)

      L.circleMarker([point.lat, point.lng], {
        radius: point.risk === 'high' ? 9 : 7,
        className: `heat-core heat-core-${point.risk}${point.live ? ' is-live' : ''}`,
        color: '#ffffff',
        weight: point.live ? 3 : 1.5,
        fillColor: color,
        fillOpacity: 1,
      })
        .addTo(layer)
        .on('click', () => {
          setSelected(point)
          map.flyTo([point.lat, point.lng], 14, { duration: 0.6 })
        })
    })
  }, [points])

  return (
    <div className="city-map-page">
      <div className="city-map" ref={mapNodeRef} />
      {tileFailed && <div className="city-map-fallback">地图瓦片不可用 · 已切换示意模式，热力位置仍然准确</div>}

      <div className="city-map-top">
        <div className="city-map-stats">
          <span className="stat-high">{stats.high} 高风险</span>
          <span className="stat-medium">{stats.medium} 中风险</span>
          <span className="stat-low">{stats.low} 低风险</span>
          <span className="stat-total">共 {stats.total} 处</span>
        </div>
        {fire && (
          <div className="city-map-alert">
            <Flame size={14} />
            <span>当前火警 · {activeDevice?.location || `${BUILDING_FLOOR(fire)} 楼`}</span>
          </div>
        )}
      </div>

      <div className="city-map-list">
        {points.slice(0, 4).map((point) => (
          <button
            key={point.id}
            type="button"
            className={`city-point point-${point.risk} ${selected?.id === point.id ? 'active' : ''}`}
            onClick={() => {
              setSelected(point)
              mapRef.current?.flyTo([point.lat, point.lng], 14, { duration: 0.6 })
            }}
          >
            <span className="point-dot" />
            <div>
              <strong>{point.name}</strong>
              <small>{point.area} · {point.at}</small>
            </div>
            <b>{point.temp.toFixed(1)}°</b>
          </button>
        ))}
      </div>

      {selected && (
        <div className="city-map-detail">
          <div className="detail-head">
            <ShieldAlert size={16} />
            <strong>{selected.name}</strong>
            <button type="button" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <div className="detail-rows">
            <div><Thermometer size={14} /><span>最高温度</span><b>{selected.temp.toFixed(1)}°C</b></div>
            <div><Crosshair size={14} /><span>高温区域</span><b>{selected.hotspots} 处</b></div>
            <div><MapPin size={14} /><span>位置</span><b>{selected.lat.toFixed(4)}, {selected.lng.toFixed(4)}</b></div>
            <div><ShieldAlert size={14} /><span>风险等级</span><b>{RISK_LABEL[selected.risk]}</b></div>
          </div>
        </div>
      )}
    </div>
  )
}

function BUILDING_FLOOR(fire) {
  return fire?.floor ?? 4
}
