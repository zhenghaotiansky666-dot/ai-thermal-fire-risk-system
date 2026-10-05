// 校园微缩 3D（three.js）
//
// 布局与楼名：校园图 OCR（Vision 带坐标）+ 校方 720° 全景场景清单
// （A座行政樓 / C座教學樓 / D座禮堂 / O座教學樓 / N座圖書館 / J座體育館 / G座宿舍 /
//  科技大樓 / 科大醫院 / 澳門國際學校 / 田徑運動場 …）
//
// 外立面：裙楼 + 逐层幕墙（层间板 + 玻璃带）+ 竖向肋 + 角柱 + 入口雨棚 + 女儿墙 +
// 屋面设备 + 楼座招牌（A/C/D/O/N…）+ 天空环境反射。
//
// 交互：拖动旋转 / 滚轮缩放 / 自动缓慢旋转；点楼体进入楼层视角，可逐层切换、
// 动态缩放（＋ / － / 复位 / 放大该层）放大到对应楼层、楼层展开合并、返回校园；
// 火源楼层整层转红并可一键定位。
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CAMPUS_BUILDINGS, CAMPUS_FLOOR_HEIGHT, CAMPUS_LANDMARKS, CAMPUS_ROADS, campusLocationForNode } from './campus.js'

const STYLE = {
  glass: { spandrel: '#243d57', glass: '#8fd3f4', metal: '#c8d8e8', stone: '#1b2836' },
  warm: { spandrel: '#4a3a24', glass: '#ffd88a', metal: '#d8c9a8', stone: '#2c2418' },
  clean: { spandrel: '#2b3c46', glass: '#b6f2df', metal: '#d5e6e0', stone: '#1d2a2e' },
  lab: { spandrel: '#1e3c42', glass: '#93f0e2', metal: '#bfe6e2', stone: '#12262a' },
  office: { spandrel: '#25334a', glass: '#a9cbff', metal: '#cfdcf5', stone: '#182233' },
  dorm: { spandrel: '#2a3050', glass: '#cfd8ff', metal: '#c9cff0', stone: '#181d2e' },
  sport: { spandrel: '#332a4c', glass: '#cbb8ff', metal: '#ded4ff', stone: '#201a33' },
}

function skyTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 0, 64)
  gradient.addColorStop(0, '#0b1930')
  gradient.addColorStop(0.45, '#1b3a5c')
  gradient.addColorStop(0.52, '#3f6f96')
  gradient.addColorStop(0.56, '#0e1a26')
  gradient.addColorStop(1, '#05080f')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function groundTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0a1017'
  ctx.fillRect(0, 0, 512, 512)
  ctx.strokeStyle = 'rgba(56,189,248,0.10)'
  for (let i = 0; i <= 512; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(4, 4)
  return texture
}

function signTexture(letter) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#07131f'
  ctx.fillRect(0, 0, 128, 128)
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 6
  ctx.strokeRect(6, 6, 116, 116)
  ctx.fillStyle = '#e8f6ff'
  ctx.font = 'bold 76px -apple-system, "PingFang SC", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, 64, 70)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const lerp = (from, to, t) => from + (to - from) * t

export default function Campus3D({ fires = [], onPick }) {
  const wrapRef = useRef(null)
  const stageRef = useRef(null)
  const apiRef = useRef(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const [focus, setFocus] = useState(null)
  const [exploded, setExploded] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const wrap = wrapRef.current
    const stage = stageRef.current
    if (!wrap || !stage) return undefined

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05080f')
    scene.fog = new THREE.Fog('#05080f', 700, 1900)

    const camera = new THREE.PerspectiveCamera(42, 1, 1, 3600)
    camera.position.set(470, 430, 640)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18
    stage.appendChild(renderer.domElement)

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.style.position = 'absolute'
    labelRenderer.domElement.style.inset = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    stage.appendChild(labelRenderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 30, 40)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 90
    controls.maxDistance = 2200
    controls.maxPolarAngle = Math.PI * 0.47
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.3

    const pmrem = new THREE.PMREMGenerator(renderer)
    const sky = skyTexture()
    const envTarget = pmrem.fromEquirectangular(sky)
    scene.environment = envTarget.texture

    scene.add(new THREE.HemisphereLight('#9ec9ff', '#050a12', 0.65))
    const key = new THREE.DirectionalLight('#e2efff', 1.6)
    key.position.set(360, 560, 300)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 120
    key.shadow.camera.far = 2000
    key.shadow.camera.left = -760
    key.shadow.camera.right = 760
    key.shadow.camera.top = 760
    key.shadow.camera.bottom = -760
    key.shadow.bias = -0.0006
    scene.add(key)
    const rim = new THREE.DirectionalLight('#3b82f6', 0.55)
    rim.position.set(-440, 260, -360)
    scene.add(rim)

    const disposables = []
    const track = (object) => { disposables.push(object); return object }
    // 程序化环境（地面/道路/地标）单独成组：Blender 模型加载成功后整体隐藏，避免重叠
    const environment = new THREE.Group()
    scene.add(environment)
    const landmarkLabels = []

    const ground = track(new THREE.Mesh(
      track(new THREE.PlaneGeometry(2800, 2800)),
      track(new THREE.MeshStandardMaterial({ map: groundTexture(), color: '#101c2a', roughness: 0.95 })),
    ))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    environment.add(ground)

    const lawn = track(new THREE.Mesh(
      track(new THREE.CircleGeometry(540, 72)),
      track(new THREE.MeshStandardMaterial({ color: '#0e2b23', roughness: 1 })),
    ))
    lawn.rotation.x = -Math.PI / 2
    lawn.position.y = 0.05
    lawn.receiveShadow = true
    environment.add(lawn)

    const roadMaterial = track(new THREE.MeshStandardMaterial({ color: '#1d2937', roughness: 0.85 }))
    CAMPUS_ROADS.forEach((road) => {
      const mesh = track(new THREE.Mesh(track(new THREE.BoxGeometry(road.w, 1.2, road.d)), roadMaterial))
      mesh.position.set(road.x, 0.6, road.z)
      mesh.rotation.y = -road.angle
      mesh.receiveShadow = true
      environment.add(mesh)
    })

    const materials = {}
    Object.entries(STYLE).forEach(([styleKey, palette]) => {
      materials[styleKey] = {
        spandrel: track(new THREE.MeshStandardMaterial({ color: palette.spandrel, roughness: 0.6, metalness: 0.25 })),
        glass: track(new THREE.MeshPhysicalMaterial({ color: palette.glass, roughness: 0.08, metalness: 0.4, transparent: true, opacity: 0.62, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.5 })),
        metal: track(new THREE.MeshStandardMaterial({ color: palette.metal, roughness: 0.35, metalness: 0.75 })),
        stone: track(new THREE.MeshStandardMaterial({ color: palette.stone, roughness: 0.85 })),
      }
    })
    const roofMaterial = track(new THREE.MeshStandardMaterial({ color: '#26313d', roughness: 0.7, metalness: 0.3 }))
    const hvacMaterial = track(new THREE.MeshStandardMaterial({ color: '#4b5563', roughness: 0.6, metalness: 0.5 }))
    const accentMaterial = track(new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#0ea5e9', emissiveIntensity: 1.1, roughness: 0.3, metalness: 0.25 }))
    const fireMaterial = track(new THREE.MeshStandardMaterial({ color: '#ff5a3c', emissive: '#ff3b30', emissiveIntensity: 1.6, roughness: 0.35 }))

    const landmarkMaterial = track(new THREE.MeshStandardMaterial({ color: '#2a5578', roughness: 0.5, metalness: 0.4 }))
    CAMPUS_LANDMARKS.forEach((landmark) => {
      const height = landmark.kind === 'station' ? 14 : 12
      const mesh = track(new THREE.Mesh(track(new THREE.BoxGeometry(landmark.w, height, landmark.d)), landmarkMaterial))
      mesh.position.set(landmark.x, height / 2, landmark.z)
      mesh.castShadow = true
      environment.add(mesh)
      const el = document.createElement('div')
      el.className = 'campus-label is-landmark'
      el.textContent = landmark.name
      const label = new CSS2DObject(el)
      label.position.set(landmark.x, height + 10, landmark.z)
      scene.add(label)
      landmarkLabels.push(label)
    })

    const buildings = {}
    CAMPUS_BUILDINGS.forEach((building) => {
      const palette = materials[building.style] ?? materials.glass
      const group = new THREE.Group()
      group.position.set(building.x, 0, building.z)
      scene.add(group)

      const podiumFloors = Math.min(2, building.floors)
      const podiumHeight = podiumFloors * CAMPUS_FLOOR_HEIGHT
      const towerFloors = Math.max(0, building.floors - podiumFloors)
      const towerW = building.w * 0.88
      const towerD = building.d * 0.88
      const totalHeight = podiumHeight + towerFloors * CAMPUS_FLOOR_HEIGHT

      const podium = track(new THREE.Mesh(
        track(new THREE.BoxGeometry(building.w * 1.1, podiumHeight, building.d * 1.1)),
        palette.stone,
      ))
      podium.position.y = podiumHeight / 2
      podium.castShadow = true
      podium.receiveShadow = true
      group.add(podium)
      const podiumGlass = track(new THREE.Mesh(
        track(new THREE.BoxGeometry(building.w * 1.11, podiumHeight * 0.42, building.d * 1.11)),
        palette.glass,
      ))
      podiumGlass.position.y = podiumHeight * 0.42
      group.add(podiumGlass)

      const floorParts = []
      for (let index = 0; index < towerFloors; index += 1) {
        const level = podiumFloors + index + 1
        const baseY = podiumHeight + (index + 0.5) * CAMPUS_FLOOR_HEIGHT
        const spandrelMaterial = track(palette.spandrel.clone())
        const glassMaterial = track(palette.glass.clone())
        const spandrel = track(new THREE.Mesh(
          track(new THREE.BoxGeometry(towerW, CAMPUS_FLOOR_HEIGHT * 0.42, towerD)),
          spandrelMaterial,
        ))
        spandrel.position.y = baseY + CAMPUS_FLOOR_HEIGHT * 0.22
        spandrel.castShadow = true
        spandrel.receiveShadow = true
        const glass = track(new THREE.Mesh(
          track(new THREE.BoxGeometry(towerW + 1.2, CAMPUS_FLOOR_HEIGHT * 0.5, towerD + 1.2)),
          glassMaterial,
        ))
        glass.position.y = baseY - CAMPUS_FLOOR_HEIGHT * 0.12
        spandrel.userData.originY = spandrel.position.y
        glass.userData.originY = glass.position.y
        group.add(spandrel, glass)
        floorParts.push({
          floor: level,
          meshes: [spandrel, glass],
          materials: [spandrelMaterial, glassMaterial],
          baseStates: [
            { material: spandrelMaterial, color: palette.spandrel.color.clone(), opacity: 1, transparent: false, emissive: new THREE.Color('#000000'), emissiveIntensity: 0 },
            { material: glassMaterial, color: palette.glass.color.clone(), opacity: palette.glass.opacity, transparent: true, emissive: new THREE.Color('#000000'), emissiveIntensity: 0 },
          ],
        })
      }

      const finCount = Math.max(3, Math.round(towerW / 12))
      for (let index = 1; index < finCount; index += 1) {
        const x = -towerW / 2 + (towerW / finCount) * index
        const fin = track(new THREE.Mesh(
          track(new THREE.BoxGeometry(1.1, Math.max(totalHeight, CAMPUS_FLOOR_HEIGHT), 1.6)),
          palette.metal,
        ))
        fin.position.set(x, Math.max(totalHeight, CAMPUS_FLOOR_HEIGHT) / 2, towerD / 2)
        const finBack = fin.clone()
        finBack.position.z = -towerD / 2
        group.add(fin, finBack)
      }

      ;[[-towerW / 2, -towerD / 2], [towerW / 2, -towerD / 2], [-towerW / 2, towerD / 2], [towerW / 2, towerD / 2]].forEach(([x, z]) => {
        const column = track(new THREE.Mesh(
          track(new THREE.BoxGeometry(1.8, Math.max(totalHeight, CAMPUS_FLOOR_HEIGHT), 1.8)),
          palette.metal,
        ))
        column.position.set(x, Math.max(totalHeight, CAMPUS_FLOOR_HEIGHT) / 2, z)
        column.castShadow = true
        group.add(column)
      })

      const parapet = track(new THREE.Mesh(
        track(new THREE.BoxGeometry(towerW + 2.4, 2.6, towerD + 2.4)),
        roofMaterial,
      ))
      parapet.position.y = totalHeight + 1.2
      parapet.castShadow = true
      group.add(parapet)
      for (let index = 0; index < 2; index += 1) {
        const hvac = track(new THREE.Mesh(
          track(new THREE.BoxGeometry(6 + index * 2, 3.2, 6)),
          hvacMaterial,
        ))
        hvac.position.set(-towerW / 4 + (index * towerW) / 2.4, totalHeight + 3.6, 0)
        hvac.castShadow = true
        group.add(hvac)
      }

      const canopy = track(new THREE.Mesh(
        track(new THREE.BoxGeometry(building.w * 0.42, 1.4, 10)),
        palette.metal,
      ))
      canopy.position.set(0, podiumHeight + 1.2, building.d * 0.55 + 4)
      canopy.castShadow = true
      group.add(canopy)
      if (building.letter) {
        const sign = track(new THREE.Mesh(
          track(new THREE.PlaneGeometry(11, 11)),
          track(new THREE.MeshBasicMaterial({ map: track(signTexture(building.letter)), transparent: true })),
        ))
        sign.position.set(0, podiumHeight + 9, building.d * 0.56 + 0.4)
        group.add(sign)
      }

      const labelEl = document.createElement('div')
      labelEl.className = 'campus-label'
      labelEl.textContent = building.short
      const label = new CSS2DObject(labelEl)
      label.position.set(0, totalHeight + 20, 0)
      group.add(label)

      buildings[building.id] = { building, group, floorParts, labelEl, labelObject: label, height: totalHeight, podiumFloors }
    })

    const markerGeo = track(new THREE.CylinderGeometry(3.6, 5.6, 1, 20, 1, true))
    const markerMat = track(new THREE.MeshBasicMaterial({ color: '#ff6b4a', transparent: true, opacity: 0.4, depthWrite: false }))
    const ringGeo = track(new THREE.RingGeometry(26, 34, 48))
    const ringMat = track(new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.6, side: THREE.DoubleSide }))
    const glowGeo = track(new THREE.SphereGeometry(6.8, 18, 18))
    const glowMat = track(new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.85 }))
    const markers = []
    for (let index = 0; index < 6; index += 1) {
      const beacon = new THREE.Mesh(markerGeo, markerMat)
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = -Math.PI / 2
      const glow = new THREE.Mesh(glowGeo, glowMat)
      const el = document.createElement('div')
      el.className = 'campus-fire-label'
      const label = new CSS2DObject(el)
      scene.add(beacon, ring, glow, label)
      markers.push({ beacon, ring, glow, label, el, location: null })
    }

    let fireLocations = []
    let focusState = null
    let explodeState = false
    let manual = false
    const desired = { position: camera.position.clone(), target: controls.target.clone() }

    const refresh = () => {
      Object.values(buildings).forEach((entry) => {
        const isFocusedBuilding = focusState?.buildingId === entry.building.id
        const palette = materials[entry.building.style] ?? materials.glass
        entry.floorParts.forEach((part) => {
          const isFire = fireLocations.some((location) => location.buildingId === entry.building.id && location.floor === part.floor)
          const isFocused = isFocusedBuilding && focusState.floor === part.floor
          // 统一用"基准状态"复位：程序化模型与 Blender(GL)B 模型走同一套逻辑
          part.baseStates.forEach((state) => {
            const material = state.material
            if (!material) return
            material.color.copy(state.color)
            material.opacity = state.opacity
            material.transparent = state.transparent
            if (state.emissive && material.emissive) {
              material.emissive.copy(state.emissive)
              material.emissiveIntensity = state.emissiveIntensity
            }
            if (isFire) {
              material.color.set('#ff5a3c')
              if (material.emissive) {
                material.emissive.set('#ff3b30')
                material.emissiveIntensity = 1.5
              }
            } else if (isFocused) {
              material.color.set('#38bdf8')
              if (material.emissive) {
                material.emissive.set('#0ea5e9')
                material.emissiveIntensity = 1
              }
            } else if (focusState && !isFocusedBuilding) {
              material.transparent = true
              material.opacity = Math.min(material.opacity, 0.2)
            } else if (isFocusedBuilding) {
              material.transparent = true
              material.opacity = Math.min(material.opacity, 0.38)
            }
            material.needsUpdate = true
          })

          const offset = focusState && explodeState ? (part.floor - 1) * 4.2 : 0
          part.meshes.forEach((mesh) => {
            const originY = mesh.userData.originY ?? mesh.position.y
            mesh.position.y = originY + offset
          })
        })
        entry.labelEl.classList.toggle('is-fire', fireLocations.some((location) => location.buildingId === entry.building.id))
        entry.labelEl.classList.toggle('is-focused', focusState?.buildingId === entry.building.id)
      })

      markers.forEach((marker, index) => {
        const location = fireLocations[index]
        marker.location = location ?? null
        const visible = Boolean(location)
        marker.beacon.visible = visible
        marker.ring.visible = visible
        marker.glow.visible = visible
        marker.label.visible = visible
        if (!visible) return
        marker.beacon.position.set(location.building.x, location.height / 2 + 6, location.building.z)
        marker.beacon.scale.set(1, Math.max(location.height, 24), 1)
        marker.ring.position.set(location.building.x, 1.2, location.building.z)
        marker.glow.position.set(location.building.x, location.height, location.building.z)
        marker.label.position.set(location.building.x, location.height + 22, location.building.z)
        marker.el.textContent = `火源 · ${location.label}`
      })

      if (focusState) {
        const entry = buildings[focusState.buildingId]
        if (entry) {
          const { building, podiumFloors } = entry
          const focusY = focusState.floor <= podiumFloors
            ? (focusState.floor - 0.5) * CAMPUS_FLOOR_HEIGHT
            : podiumFloors * CAMPUS_FLOOR_HEIGHT + (focusState.floor - podiumFloors - 0.5) * CAMPUS_FLOOR_HEIGHT
          const base = Math.max(building.w, building.d) * 2.2 + 150
          const distance = base * zoomRef.current
          desired.target.set(building.x, focusY, building.z)
          desired.position.set(building.x + distance * 0.8, focusY + distance * 0.42, building.z + distance * 0.9)
        }
      } else {
        const base = 470
        desired.target.set(0, 30, 40)
        desired.position.set(base * (0.8 + 0.2 * zoomRef.current), 430 * zoomRef.current + 140, base * (1.05 * zoomRef.current + 0.25))
      }
      controls.autoRotate = !focusState
      manual = false
    }

    apiRef.current = {
      setFires: (list) => {
        fireLocations = []
        const seen = new Set()
        ;(Array.isArray(list) ? list : []).forEach((fire) => {
          const location = campusLocationForNode(typeof fire === 'string' ? fire : fire?.nodeId)
          if (!location) return
          const key = `${location.buildingId}-${location.floor}`
          if (seen.has(key)) return
          seen.add(key)
          fireLocations.push(location)
        })
        refresh()
      },
      setFocus: (nextFocus, nextExploded) => {
        focusState = nextFocus
        explodeState = Boolean(nextExploded)
        refresh()
      },
      setZoom: (nextZoom) => {
        zoomRef.current = nextZoom
        refresh()
      },
    }

    // 加载 Blender 导出的校园模型（GLB）。加载成功后用它替换程序化楼体与环境；
    // 楼层对象名形如 `{楼栋}_F{层号}` 与 `{id}_F{n}_spandrel`，据此建立单层高亮映射。
    let glbRoot = null
    const gltfLoader = new GLTFLoader()
    gltfLoader.load('./models/must-campus.glb', (gltf) => {
      glbRoot = gltf.scene
      glbRoot.traverse((object) => {
        if (!object.isMesh) return
        object.castShadow = true
        object.receiveShadow = true
      })
      scene.add(glbRoot)
      environment.visible = false
      landmarkLabels.forEach((label) => scene.attach(label))
      Object.values(buildings).forEach((entry) => {
        if (entry.labelObject) scene.attach(entry.labelObject)
        entry.group.visible = false
        entry.floorParts = []
      })
      glbRoot.traverse((object) => {
        const match = /^(.+)_F(\d+)(_spandrel)?$/.exec(object.name)
        if (!match) return
        const entry = buildings[match[1]]
        if (!entry) return
        const floor = Number(match[2])
        let part = entry.floorParts.find((item) => item.floor === floor)
        if (!part) {
          part = { floor, meshes: [], materials: [], baseStates: [] }
          entry.floorParts.push(part)
        }
        object.userData.originY = object.position.y
        part.meshes.push(object)
        part.materials.push(object.material)
        part.baseStates.push({
          material: object.material,
          color: object.material.color.clone(),
          opacity: object.material.opacity,
          transparent: object.material.transparent,
          emissive: object.material.emissive ? object.material.emissive.clone() : null,
          emissiveIntensity: object.material.emissiveIntensity ?? 0,
        })
      })
      wrap.dataset.campusSource = 'glb'
      refresh()
    }, undefined, () => {
      wrap.dataset.campusSource = 'procedural'
    })

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const onClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const entries = Object.values(buildings)
      const targets = entries.flatMap((entry) => entry.floorParts.flatMap((part) => part.meshes))
      const hits = raycaster.intersectObjects(targets, false)
      if (!hits.length) return
      const hit = hits[0].object
      const entry = entries.find((item) => item.floorParts.some((part) => part.meshes.includes(hit)))
      const part = entry?.floorParts.find((item) => item.meshes.includes(hit))
      if (!entry || !part) return
      setFocus({ buildingId: entry.building.id, floor: part.floor })
      pickRef.current?.({ building: entry.building, floor: part.floor })
    }
    renderer.domElement.addEventListener('click', onClick)
    const onUserStart = () => { manual = true }
    controls.addEventListener('start', onUserStart)

    const resize = () => {
      const width = stage.clientWidth || 360
      const height = stage.clientHeight || 340
      renderer.setSize(width, height, false)
      labelRenderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)

    let raf = 0
    const startedAt = performance.now()
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const time = (performance.now() - startedAt) / 1000
      if (!manual) {
        camera.position.set(
          lerp(camera.position.x, desired.position.x, 0.08),
          lerp(camera.position.y, desired.position.y, 0.08),
          lerp(camera.position.z, desired.position.z, 0.08),
        )
        controls.target.set(
          lerp(controls.target.x, desired.target.x, 0.1),
          lerp(controls.target.y, desired.target.y, 0.1),
          lerp(controls.target.z, desired.target.z, 0.1),
        )
      }
      markers.forEach((marker, index) => {
        if (!marker.location) return
        marker.glow.scale.setScalar(1 + 0.16 * Math.sin(time * 3 + index))
        marker.ring.scale.setScalar(1 + 0.1 * Math.sin(time * 2 + index))
        marker.ring.material.opacity = 0.32 + 0.3 * (0.5 + 0.5 * Math.sin(time * 2 + index))
        marker.beacon.material.opacity = 0.26 + 0.18 * (0.5 + 0.5 * Math.sin(time * 1.6 + index))
      })
      fireMaterial.emissiveIntensity = 1.2 + 0.5 * (0.5 + 0.5 * Math.sin(time * 2.4))
      accentMaterial.emissiveIntensity = 0.9 + 0.35 * (0.5 + 0.5 * Math.sin(time * 2))
      controls.update()
      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)
    }
    animate()
    wrap.dataset.campusReady = 'true'

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      renderer.domElement.removeEventListener('click', onClick)
      controls.removeEventListener('start', onUserStart)
      controls.dispose()
      apiRef.current = null
      if (glbRoot) {
        glbRoot.traverse((object) => {
          if (!object.isMesh) return
          object.geometry?.dispose()
          const list = Array.isArray(object.material) ? object.material : [object.material]
          list.forEach((material) => material?.dispose())
        })
      }
      disposables.forEach((item) => item.dispose?.())
      envTarget.dispose()
      sky.dispose()
      pmrem.dispose()
      scene.traverse((object) => {
        if (object instanceof CSS2DObject) object.element?.remove()
      })
      renderer.dispose()
      stage.removeChild(renderer.domElement)
      stage.removeChild(labelRenderer.domElement)
    }
  }, [])

  useEffect(() => { apiRef.current?.setFires(fires) }, [fires])
  useEffect(() => { apiRef.current?.setFocus(focus, exploded) }, [focus, exploded])
  useEffect(() => { apiRef.current?.setZoom(zoom) }, [zoom])

  const focusedBuilding = focus ? CAMPUS_BUILDINGS.find((item) => item.id === focus.buildingId) : null
  const fireLocation = fires.length ? campusLocationForNode(typeof fires[0] === 'string' ? fires[0] : fires[0]?.nodeId) : null

  return (
    <div className="campus-3d" ref={wrapRef}>
      <div className="campus-3d-stage" ref={stageRef} />

      {focus && focusedBuilding ? (
        <div className={`campus-floor-panel ${panelCollapsed ? 'is-collapsed' : ''}`}>
          <div className="campus-floor-head">
            <div>
              <strong>{focusedBuilding.name}</strong>
              <small>共 {focusedBuilding.floors} 層 · 当前第 {focus.floor} 層 · 视距 {Math.round(zoom * 100)}%</small>
            </div>
            <div className="campus-floor-head-actions">
              <button type="button" onClick={() => setPanelCollapsed((value) => !value)}>{panelCollapsed ? '展开' : '收起'}</button>
              <button type="button" onClick={() => setFocus(null)}>返回校园</button>
            </div>
          </div>
          {!panelCollapsed && (
            <>
              <div className="campus-floor-grid">
                {Array.from({ length: focusedBuilding.floors }, (_, index) => index + 1).map((floor) => (
                  <button
                    key={floor}
                    type="button"
                    className={focus.floor === floor ? 'active' : ''}
                    onClick={() => setFocus({ buildingId: focusedBuilding.id, floor })}
                  >
                    {floor} 層
                  </button>
                ))}
              </div>
              <div className="campus-floor-actions">
                <button type="button" disabled={focus.floor <= 1} onClick={() => setFocus({ buildingId: focusedBuilding.id, floor: focus.floor - 1 })}>下一层</button>
                <button type="button" disabled={focus.floor >= focusedBuilding.floors} onClick={() => setFocus({ buildingId: focusedBuilding.id, floor: focus.floor + 1 })}>上一层</button>
                <button type="button" onClick={() => setZoom((value) => Math.max(0.32, Number((value - 0.16).toFixed(2))))}>放大 ＋</button>
                <button type="button" onClick={() => setZoom((value) => Math.min(1.6, Number((value + 0.16).toFixed(2))))}>缩小 －</button>
                <button type="button" onClick={() => setZoom(0.5)}>放大该层</button>
                <button type="button" className={exploded ? 'active' : ''} onClick={() => setExploded((value) => !value)}>{exploded ? '楼层合并' : '楼层展开'}</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="campus-3d-legend">
          <span>拖动旋转 · 滚轮缩放 · 点击楼体进入楼层视角</span>
          {fireLocation && (
            <button
              type="button"
              className="campus-jump-fire"
              onClick={() => setFocus({ buildingId: fireLocation.buildingId, floor: fireLocation.floor })}
            >
              定位到火源 · {fireLocation.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
