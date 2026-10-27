/**
 * SpaceCraft 3D — 웹 기반 3D 인테리어 및 공간 시뮬레이션 플랫폼
 * Scale: 1000mm = 1.0 unit (Three.js meter scale)
 * Features:
 * 1. 2D Floorplan Editor (Presets + Custom Wall/Door/Window Drawing) -> Real-time 3D Extrusion
 * 2. 3D Furniture Catalog, Raycaster Drag & Drop, AABB Collision & Ergonomic Door Swing (900mm) Check
 * 3. AI Custom 3D Furniture Generator (Canvas Dominant Color + CanvasTexture + Procedural 3D Mesh Synthesis)
 */

(function () {
  'use strict';

  const MM_TO_UNIT = 0.001; // 1000mm = 1 unit
  const UNIT_TO_MM = 1000;
  const STORAGE_KEY = 'SPACECRAFT_3D_INTERIOR_STATE_V1';

  // ==================== APPLICATION STATE ====================
  const state = {
    mode: '3d', // '2d' | '3d'
    activePreset: 'studio',
    roomName: '원룸 오픈형 (3500 × 4500 mm)',
    ceilingHeight: 2400, // mm
    wallThickness: 160,  // mm
    autoCutaway: true,
    globalErgoVisible: true,
    snapToGrid: true,

    // 2D Floorplan Data (in mm, centered around 0,0)
    // floorPolygons: array of points [{x, z}, ...] in mm
    floorPolygon: [],
    // walls: [{ id, x1, z1, x2, z2, thickness, height, isInterior }]
    walls: [],
    // openings: [{ id, wallId, type: 'door'|'window', t: 0..1, width: 900, height: 2100, sill: 0, swingDir: 1 }]
    openings: [],

    // Furniture Instances
    // [{ id, catalogId, name, category, shape, w, d, h, x, y, z, rotY, color, textureDataUrl, ergoVisible, isAI }]
    furnitureList: [],
    selectedFurnitureId: null,

    // Saved AI Custom Furniture Catalog Vault
    aiVault: [],

    // 2D Editor Interaction State
    drawTool: 'select', // 'select' | 'wall' | 'door' | 'window' | 'erase'
    isDrawingWall: false,
    drawStartPt: null,
    drawCurrentPt: null,
    dragging2DFurnitureId: null,
    drag2DOffset: { x: 0, z: 0 },
    pan2D: { x: 0, y: 0 },
    zoom2D: 0.11, // px per mm

    // AI Upload Temp State
    aiUploadedImageDataUrl: null,
    aiExtractedHex: '#A47D55'
  };

  // ==================== DEFAULT FURNITURE CATALOG ====================
  const DEFAULT_CATALOG = [
    {
      catalogId: 'bed_single',
      name: '모던 싱글 침대',
      category: 'bed',
      shape: 'legged',
      w: 1050, d: 2080, h: 850,
      color: '#4B5563',
      tag: '침실',
      ergoClearance: { front: 500, side: 450 }
    },
    {
      catalogId: 'bed_queen',
      name: '호텔형 퀸 침대',
      category: 'bed',
      shape: 'legged',
      w: 1580, d: 2120, h: 920,
      color: '#57534E',
      tag: '침실',
      ergoClearance: { front: 550, side: 500 }
    },
    {
      catalogId: 'desk_work',
      name: '데스크테리어 모션 데스크',
      category: 'desk',
      shape: 'legged',
      w: 1400, d: 700, h: 740,
      color: '#8D6E63',
      tag: '서재/데스크',
      ergoClearance: { front: 750, side: 100 }
    },
    {
      catalogId: 'chair_office',
      name: '에르고 메쉬 오피스 체어',
      category: 'chair',
      shape: 'cylinder',
      w: 620, d: 620, h: 980,
      color: '#374151',
      tag: '서재/데스크',
      ergoClearance: { front: 450, side: 350 }
    },
    {
      catalogId: 'wardrobe_std',
      name: '빌트인 슬림 옷장 (2도어)',
      category: 'wardrobe',
      shape: 'box',
      w: 1000, d: 600, h: 2100,
      color: '#D6D3D1',
      tag: '수납',
      ergoClearance: { front: 650, side: 50 }
    },
    {
      catalogId: 'sofa_3seat',
      name: '노르딕 3인용 패브릭 소파',
      category: 'chair',
      shape: 'legged',
      w: 2050, d: 880, h: 800,
      color: '#64748B',
      tag: '거실',
      ergoClearance: { front: 600, side: 200 }
    },
    {
      catalogId: 'bookshelf_5tier',
      name: '오픈형 5단 와이드 책장',
      category: 'wardrobe',
      shape: 'box',
      w: 900, d: 340, h: 1850,
      color: '#785A46',
      tag: '수납',
      ergoClearance: { front: 500, side: 50 }
    },
    {
      catalogId: 'lamp_floor',
      name: '아키텍처 장스탠드 조명',
      category: 'decor',
      shape: 'cylinder',
      w: 420, d: 420, h: 1620,
      color: '#F59E0B',
      tag: '조명/소품',
      ergoClearance: { front: 250, side: 250 }
    }
  ];

  // ==================== THREE.JS SCENE GLOBALS ====================
  let scene, camera, renderer, controls;
  let roomGroup, furnitureGroup, helperGroup;
  let raycaster, mouseNDC, dragPlane;
  let isDragging3D = false;
  let dragged3DObject = null;
  let drag3DOffset = new THREE.Vector3();

  // Map furniture id -> THREE.Group
  const furnitureMeshMap = new Map();
  // Wall meshes for cutaway & collision
  const wallMeshes = [];
  // Door swing zones in world coordinates for collision check
  const doorSwingZones = [];

  // 2D Canvas Context
  let canvas2D, ctx2D;

  // ==================== INITIALIZATION ====================
  window.addEventListener('DOMContentLoaded', () => {
    initThreeScene();
    init2DCanvas();
    renderCatalogUI();
    bindUIEvents();

    // Load default preset (① 원룸 오픈형 3500x4500mm) with starter furniture
    loadFloorplanPreset('studio', true);

    animate();
  });

  // ==================== THREE.JS SETUP ====================
  function initThreeScene() {
    const canvas = document.getElementById('three-canvas');
    const container = document.getElementById('center-viewport');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121316);

    camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    resetCameraView();

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // Prevent going below floor
    controls.minDistance = 1.5;
    controls.maxDistance = 22;
    controls.target.set(0, 0.6, 0);

    // Subtle dark GridHelper (#2A2C32)
    const gridHelper = new THREE.GridHelper(16, 32, 0x383B46, 0x2A2C32);
    gridHelper.position.y = -0.002;
    scene.add(gridHelper);

    // Lighting Setup (Architectural Studio Lighting)
    const ambientLight = new THREE.AmbientLight(0xDCE3F2, 0.62);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xE2E8F0, 0x1E1F24, 0.35);
    hemiLight.position.set(0, 8, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xFFFBEB, 0.78);
    dirLight.position.set(5.5, 9.5, 6.5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 25;
    const d = 7;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    roomGroup = new THREE.Group();
    furnitureGroup = new THREE.Group();
    helperGroup = new THREE.Group();
    scene.add(roomGroup);
    scene.add(furnitureGroup);
    scene.add(helperGroup);

    raycaster = new THREE.Raycaster();
    mouseNDC = new THREE.Vector2();
    dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // 3D Pointer Events for Raycaster Drag & Drop
    canvas.addEventListener('pointerdown', on3DPointerDown);
    canvas.addEventListener('pointermove', on3DPointerMove);
    window.addEventListener('pointerup', on3DPointerUp);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', onGlobalKeyDown);
  }

  function resetCameraView() {
    if (!camera) return;
    camera.position.set(4.8, 5.4, 5.8);
    if (controls) {
      controls.target.set(0, 0.6, 0);
      controls.update();
    }
  }

  function onWindowResize() {
    const container = document.getElementById('center-viewport');
    if (!container || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);

    if (canvas2D) {
      canvas2D.width = w;
      canvas2D.height = h;
      draw2DFloorplan();
    }
  }

  // ==================== [기능 1] 건물 3D 시뮬레이션 (프리셋 + 2D 편집 + 3D Extrusion) ====================
  function loadFloorplanPreset(presetKey, includeSampleFurniture = false) {
    state.activePreset = presetKey;
    state.walls = [];
    state.openings = [];

    const t = state.wallThickness;
    const h = state.ceilingHeight;

    if (presetKey === 'studio') {
      // ① 원룸 오픈형 3500 x 4500 mm
      const W = 3500, D = 4500;
      state.roomName = '① 원룸 오픈형 (3500 × 4500 mm)';
      setRoomDimensionInputs(W, D, h);
      buildRectangularRoomWalls(W, D, t, h);
      // 방문 (하단 벽 좌측) + 창문 (상단 벽 중앙)
      state.openings.push({
        id: 'open_door_1',
        wallId: 'wall_bottom',
        type: 'door',
        t: 0.25,
        width: 900,
        height: 2100,
        sill: 0,
        swingDir: 1
      });
      state.openings.push({
        id: 'open_win_1',
        wallId: 'wall_top',
        type: 'window',
        t: 0.5,
        width: 1600,
        height: 1200,
        sill: 850
      });
    } else if (presetKey === 'onehalf') {
      // ② 분리형 1.5룸 5200 x 4200 mm (가벽 및 중문 포함)
      const W = 5200, D = 4200;
      state.roomName = '② 분리형 1.5룸 (5200 × 4200 mm)';
      setRoomDimensionInputs(W, D, h);
      buildRectangularRoomWalls(W, D, t, h);
      // 중앙 분리 가벽
      state.walls.push({
        id: 'wall_partition_1',
        x1: -200, z1: -D / 2,
        x2: -200, z2: 700,
        thickness: 140,
        height: h,
        isInterior: true
      });
      // 현관문, 침실 방문, 거실 대형 창문
      state.openings.push({
        id: 'open_door_main',
        wallId: 'wall_bottom',
        type: 'door',
        t: 0.22,
        width: 900,
        height: 2100,
        sill: 0,
        swingDir: 1
      });
      state.openings.push({
        id: 'open_door_inner',
        wallId: 'wall_partition_1',
        type: 'door',
        t: 0.65,
        width: 900,
        height: 2100,
        sill: 0,
        swingDir: 1
      });
      state.openings.push({
        id: 'open_win_living',
        wallId: 'wall_top',
        type: 'window',
        t: 0.7,
        width: 1800,
        height: 1300,
        sill: 800
      });
      state.openings.push({
        id: 'open_win_bed',
        wallId: 'wall_top',
        type: 'window',
        t: 0.22,
        width: 1200,
        height: 1200,
        sill: 850
      });
    } else if (presetKey === 'aptbed') {
      // ③ 국민평형 아파트 침실형 3600 x 3900 mm
      const W = 3600, D = 3900;
      state.roomName = '③ 국민평형 침실형 (3600 × 3900 mm)';
      setRoomDimensionInputs(W, D, h);
      buildRectangularRoomWalls(W, D, t, h);
      state.openings.push({
        id: 'open_door_apt',
        wallId: 'wall_left',
        type: 'door',
        t: 0.72,
        width: 900,
        height: 2100,
        sill: 0,
        swingDir: 1
      });
      state.openings.push({
        id: 'open_win_apt',
        wallId: 'wall_top',
        type: 'window',
        t: 0.5,
        width: 2000,
        height: 1350,
        sill: 750
      });
    } else if (presetKey === 'lshape') {
      // ④ ㄱ자형 구조 (5000 x 4800 mm 코너형)
      const W = 5000, D = 4800;
      state.roomName = '④ ㄱ자형 코너 구조 (5000 × 4800 mm)';
      setRoomDimensionInputs(W, D, h);
      const pts = [
        { x: -2500, z: -2400 },
        { x: 2500,  z: -2400 },
        { x: 2500,  z: 400 },
        { x: 400,   z: 400 },
        { x: 400,   z: 2400 },
        { x: -2500, z: 2400 }
      ];
      state.floorPolygon = pts;
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        state.walls.push({
          id: 'wall_l_' + i,
          x1: p1.x, z1: p1.z,
          x2: p2.x, z2: p2.z,
          thickness: t,
          height: h,
          isInterior: false
        });
      }
      state.openings.push({
        id: 'open_door_l',
        wallId: 'wall_l_4',
        type: 'door',
        t: 0.5,
        width: 900,
        height: 2100,
        sill: 0,
        swingDir: 1
      });
      state.openings.push({
        id: 'open_win_l1',
        wallId: 'wall_l_0',
        type: 'window',
        t: 0.35,
        width: 1800,
        height: 1250,
        sill: 800
      });
      state.openings.push({
        id: 'open_win_l2',
        wallId: 'wall_l_1',
        type: 'window',
        t: 0.5,
        width: 1400,
        height: 1250,
        sill: 800
      });
    }

    if (includeSampleFurniture) {
      state.furnitureList = [];
      furnitureMeshMap.clear();
      clearThreeGroup(furnitureGroup);

      // 초기 데모 가구 배치 (원룸 기준 깔끔한 배치)
      addFurnitureFromTemplate(DEFAULT_CATALOG[0], { x: -1100, z: -1050, rotY: 0 });   // 싱글 침대
      addFurnitureFromTemplate(DEFAULT_CATALOG[2], { x: 950,   z: -1650, rotY: 0 });   // 데스크
      addFurnitureFromTemplate(DEFAULT_CATALOG[3], { x: 950,   z: -950,  rotY: 180 }); // 오피스 의자
      addFurnitureFromTemplate(DEFAULT_CATALOG[4], { x: 1150,  z: 750,   rotY: -90 }); // 옷장
    }

    document.getElementById('hud-room-text').textContent = state.roomName;
    updatePresetCardUI();
    rebuild3DRoomGeometry();
    evaluateAllCollisions();
    draw2DFloorplan();
    updateInspectorUI();
  }

  function buildRectangularRoomWalls(W, D, thickness, height) {
    const hw = W / 2;
    const hd = D / 2;
    state.floorPolygon = [
      { x: -hw, z: -hd },
      { x: hw,  z: -hd },
      { x: hw,  z: hd },
      { x: -hw, z: hd }
    ];
    state.walls = [
      { id: 'wall_top',    x1: -hw, z1: -hd, x2: hw,  z2: -hd, thickness, height, isInterior: false },
      { id: 'wall_right',  x1: hw,  z1: -hd, x2: hw,  z2: hd,  thickness, height, isInterior: false },
      { id: 'wall_bottom', x1: hw,  z1: hd,  x2: -hw, z2: hd,  thickness, height, isInterior: false },
      { id: 'wall_left',   x1: -hw, z1: hd,  x2: -hw, z2: -hd, thickness, height, isInterior: false }
    ];
  }

  function setRoomDimensionInputs(w, d, h) {
    document.getElementById('room-width-input').value = w;
    document.getElementById('room-depth-input').value = d;
    document.getElementById('room-height-input').value = h;
  }

  // ==================== 3D ROOM EXTRUSION BUILDER ====================
  function clearThreeGroup(group) {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
    }
  }

  function rebuild3DRoomGeometry() {
    clearThreeGroup(roomGroup);
    wallMeshes.length = 0;
    doorSwingZones.length = 0;

    // 1. Floor Mesh Extrusion from floorPolygon (or bounding box of walls)
    const poly = getEffectiveFloorPolygon();
    if (poly.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x * MM_TO_UNIT, -poly[0].z * MM_TO_UNIT);
      for (let i = 1; i < poly.length; i++) {
        shape.lineTo(poly[i].x * MM_TO_UNIT, -poly[i].z * MM_TO_UNIT);
      }
      shape.closePath();

      const floorGeo = new THREE.ExtrudeGeometry(shape, {
        depth: 0.04,
        bevelEnabled: false
      });
      floorGeo.rotateX(-Math.PI / 2);
      floorGeo.translate(0, -0.04, 0);

      // Subtle wood-herringbone procedural canvas texture for floor
      const floorMat = new THREE.MeshStandardMaterial({
        map: createProceduralFloorTexture(),
        roughness: 0.75,
        metalness: 0.05
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.receiveShadow = true;
      floorMesh.name = 'RoomFloor';
      roomGroup.add(floorMesh);
    }

    // 2. Extrude 3D Walls & Openings (Doors + 900mm Swing Arc, Windows)
    const wallMatBase = new THREE.MeshStandardMaterial({
      color: 0x2F333D,
      roughness: 0.85,
      metalness: 0.05,
      transparent: true,
      opacity: 1.0
    });

    const baseboardMat = new THREE.MeshStandardMaterial({
      color: 0x1F2229,
      roughness: 0.7
    });

    state.walls.forEach((wall) => {
      const dx = wall.x2 - wall.x1;
      const dz = wall.z2 - wall.z1;
      const lenMM = Math.hypot(dx, dz);
      if (lenMM < 50) return;

      const angle = Math.atan2(dz, dx);
      const lenU = lenMM * MM_TO_UNIT;
      const thickU = (wall.thickness || state.wallThickness) * MM_TO_UNIT;
      const heightU = (wall.height || state.ceilingHeight) * MM_TO_UNIT;

      const wallContainer = new THREE.Group();
      const midX = ((wall.x1 + wall.x2) / 2) * MM_TO_UNIT;
      const midZ = ((wall.z1 + wall.z2) / 2) * MM_TO_UNIT;
      wallContainer.position.set(midX, 0, midZ);
      wallContainer.rotation.y = -angle;

      // Normal vector pointing outward from room center (0,0)
      const normalX = Math.sin(angle);
      const normalZ = -Math.cos(angle);
      const dotSign = (midX * normalX + midZ * normalZ) >= 0 ? 1 : -1;
      wallContainer.userData = {
        wallData: wall,
        outwardNormal: new THREE.Vector3(normalX * dotSign, 0, normalZ * dotSign),
        midPoint: new THREE.Vector3(midX, 0, midZ),
        isInterior: !!wall.isInterior
      };

      const wallOpenings = state.openings
        .filter((o) => o.wallId === wall.id)
        .sort((a, b) => a.t - b.t);

      const wallMat = wallMatBase.clone();
      wallContainer.userData.wallMaterial = wallMat;

      if (wallOpenings.length === 0) {
        const geo = new THREE.BoxGeometry(lenU, heightU, thickU);
        geo.translate(0, heightU / 2, 0);
        const mesh = new THREE.Mesh(geo, wallMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        wallContainer.add(mesh);
      } else {
        // Segmented wall construction around doors & windows
        let cursorMM = -lenMM / 2;
        wallOpenings.forEach((op) => {
          const opCenterMM = (op.t - 0.5) * lenMM;
          const halfW = op.width / 2;
          const opStartMM = Math.max(-lenMM / 2 + 40, opCenterMM - halfW);
          const opEndMM = Math.min(lenMM / 2 - 40, opCenterMM + halfW);

          // Left solid segment before opening
          const segLenMM = opStartMM - cursorMM;
          if (segLenMM > 10) {
            const segU = segLenMM * MM_TO_UNIT;
            const segCenterU = ((cursorMM + opStartMM) / 2) * MM_TO_UNIT;
            const segGeo = new THREE.BoxGeometry(segU, heightU, thickU);
            segGeo.translate(segCenterU, heightU / 2, 0);
            const segMesh = new THREE.Mesh(segGeo, wallMat);
            segMesh.castShadow = true;
            segMesh.receiveShadow = true;
            wallContainer.add(segMesh);
          }

          const opWidthU = (opEndMM - opStartMM) * MM_TO_UNIT;
          const opCenterU = ((opStartMM + opEndMM) / 2) * MM_TO_UNIT;
          const opHeightU = (op.height || 2100) * MM_TO_UNIT;
          const sillU = (op.sill || 0) * MM_TO_UNIT;

          // Header segment above door/window
          const topHeadU = heightU - (sillU + opHeightU);
          if (topHeadU > 0.02) {
            const headGeo = new THREE.BoxGeometry(opWidthU, topHeadU, thickU);
            headGeo.translate(opCenterU, sillU + opHeightU + topHeadU / 2, 0);
            const headMesh = new THREE.Mesh(headGeo, wallMat);
            headMesh.castShadow = true;
            wallContainer.add(headMesh);
          }

          // Sill segment below window
          if (sillU > 0.02) {
            const sillGeo = new THREE.BoxGeometry(opWidthU, sillU, thickU);
            sillGeo.translate(opCenterU, sillU / 2, 0);
            const sillMesh = new THREE.Mesh(sillGeo, wallMat);
            sillMesh.castShadow = true;
            wallContainer.add(sillMesh);
          }

          // Build Door or Window 3D Fixture
          if (op.type === 'door') {
            build3DDoorFixture(wallContainer, opCenterU, opWidthU, opHeightU, thickU, wall, angle, op);
          } else if (op.type === 'window') {
            build3DWindowFixture(wallContainer, opCenterU, sillU, opWidthU, opHeightU, thickU);
          }

          cursorMM = opEndMM;
        });

        // Right solid segment after last opening
        const tailMM = lenMM / 2 - cursorMM;
        if (tailMM > 10) {
          const tailU = tailMM * MM_TO_UNIT;
          const tailCenterU = ((cursorMM + lenMM / 2) / 2) * MM_TO_UNIT;
          const tailGeo = new THREE.BoxGeometry(tailU, heightU, thickU);
          tailGeo.translate(tailCenterU, heightU / 2, 0);
          const tailMesh = new THREE.Mesh(tailGeo, wallMat);
          tailMesh.castShadow = true;
          tailMesh.receiveShadow = true;
          wallContainer.add(tailMesh);
        }
      }

      // Baseboard trim
      const baseGeo = new THREE.BoxGeometry(lenU, 0.06, thickU + 0.008);
      baseGeo.translate(0, 0.03, 0);
      const baseMesh = new THREE.Mesh(baseGeo, baseboardMat);
      wallContainer.add(baseMesh);

      roomGroup.add(wallContainer);
      wallMeshes.push(wallContainer);
    });
  }

  function build3DDoorFixture(wallContainer, centerU, widthU, heightU, thickU, wall, wallAngle, op) {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4B5563, roughness: 0.5 });
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x8B6F4E,
      roughness: 0.65,
      transparent: true,
      opacity: 0.92
    });

    // Door Frame
    const frameThick = 0.04;
    const leftPost = new THREE.Mesh(new THREE.BoxGeometry(frameThick, heightU, thickU + 0.02), frameMat);
    leftPost.position.set(centerU - widthU / 2 + frameThick / 2, heightU / 2, 0);
    wallContainer.add(leftPost);

    const rightPost = new THREE.Mesh(new THREE.BoxGeometry(frameThick, heightU, thickU + 0.02), frameMat);
    rightPost.position.set(centerU + widthU / 2 - frameThick / 2, heightU / 2, 0);
    wallContainer.add(rightPost);

    // Slightly ajar door leaf (opened at 65 degrees into the room)
    const swingRadiusU = 0.9; // 900mm standard door clearance radius
    const hingeX = centerU - widthU / 2 + frameThick;
    const doorPivot = new THREE.Group();
    doorPivot.position.set(hingeX, 0, 0);

    // Determine inward swing direction
    const inwardSign = (op.swingDir || 1);
    doorPivot.rotation.y = inwardSign * (Math.PI * 0.38);

    const leafW = widthU - frameThick * 2;
    const leafGeo = new THREE.BoxGeometry(leafW, heightU - 0.03, 0.04);
    leafGeo.translate(leafW / 2, (heightU - 0.03) / 2, 0);
    const leafMesh = new THREE.Mesh(leafGeo, panelMat);
    leafMesh.castShadow = true;
    doorPivot.add(leafMesh);

    // Door Handle
    const handleMat = new THREE.MeshStandardMaterial({ color: 0xD1D5DB, metalness: 0.8, roughness: 0.2 });
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.09), handleMat);
    handle.position.set(leafW - 0.09, 0.95, 0);
    doorPivot.add(handle);

    wallContainer.add(doorPivot);

    // 900mm Door Swing Ergonomic Sector on the Floor
    const sectorGeo = new THREE.CircleGeometry(swingRadiusU, 28, 0, Math.PI / 2);
    sectorGeo.rotateX(-Math.PI / 2);
    if (inwardSign < 0) {
      sectorGeo.scale(1, 1, -1);
    }
    const sectorMat = new THREE.MeshBasicMaterial({
      color: 0x4F46E5,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const sectorMesh = new THREE.Mesh(sectorGeo, sectorMat);
    sectorMesh.position.set(hingeX, 0.006, 0);
    sectorMesh.name = 'ErgoDoorSwing';
    sectorMesh.visible = state.globalErgoVisible;
    wallContainer.add(sectorMesh);

    // Arc Outline for 900mm Door Swing
    const arcPts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * (Math.PI / 2);
      arcPts.push(new THREE.Vector3(
        hingeX + Math.cos(a) * swingRadiusU,
        0.008,
        Math.sin(a) * swingRadiusU * (inwardSign >= 0 ? -1 : 1)
      ));
    }
    const arcLineGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
    const arcLineMat = new THREE.LineBasicMaterial({ color: 0x818CF8 });
    const arcLine = new THREE.Line(arcLineGeo, arcLineMat);
    arcLine.name = 'ErgoDoorSwing';
    arcLine.visible = state.globalErgoVisible;
    wallContainer.add(arcLine);

    // Compute world-space bounding box of the 900mm door swing zone for collision checks
    const localSwingCenter = new THREE.Vector3(
      centerU,
      0.4,
      (inwardSign >= 0 ? -1 : 1) * (swingRadiusU * 0.48)
    );
    wallContainer.updateMatrixWorld(true);
    const worldSwingCenter = localSwingCenter.applyMatrix4(wallContainer.matrixWorld);

    doorSwingZones.push({
      id: op.id,
      center: worldSwingCenter,
      radiusMM: 900,
      box3: new THREE.Box3().setFromCenterAndSize(
        worldSwingCenter,
        new THREE.Vector3(swingRadiusU * 0.9, 1.8, swingRadiusU * 0.9)
      ),
      sectorMesh
    });
  }

  function build3DWindowFixture(wallContainer, centerU, sillU, widthU, heightU, thickU) {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1F242D, roughness: 0.4, metalness: 0.3 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x93C5FD,
      transparent: true,
      opacity: 0.32,
      roughness: 0.1,
      transmission: 0.5
    });

    const frameGroup = new THREE.Group();
    frameGroup.position.set(centerU, sillU + heightU / 2, 0);

    // Outer frame bars
    const barT = 0.045;
    const topBar = new THREE.Mesh(new THREE.BoxGeometry(widthU, barT, thickU + 0.02), frameMat);
    topBar.position.y = heightU / 2 - barT / 2;
    const botBar = new THREE.Mesh(new THREE.BoxGeometry(widthU, barT, thickU + 0.03), frameMat);
    botBar.position.y = -heightU / 2 + barT / 2;
    const midMullion = new THREE.Mesh(new THREE.BoxGeometry(barT, heightU, thickU + 0.01), frameMat);

    const glassPane = new THREE.Mesh(new THREE.BoxGeometry(widthU - barT * 2, heightU - barT * 2, 0.018), glassMat);

    frameGroup.add(topBar, botBar, midMullion, glassPane);
    wallContainer.add(frameGroup);
  }

  function getEffectiveFloorPolygon() {
    if (state.floorPolygon && state.floorPolygon.length >= 3) {
      return state.floorPolygon;
    }
    if (state.walls.length === 0) {
      return [
        { x: -1750, z: -2250 },
        { x: 1750,  z: -2250 },
        { x: 1750,  z: 2250 },
        { x: -1750, z: 2250 }
      ];
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    state.walls.forEach((w) => {
      minX = Math.min(minX, w.x1, w.x2);
      maxX = Math.max(maxX, w.x1, w.x2);
      minZ = Math.min(minZ, w.z1, w.z2);
      maxZ = Math.max(maxZ, w.z1, w.z2);
    });
    return [
      { x: minX, z: minZ },
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
      { x: minX, z: maxZ }
    ];
  }

  function createProceduralFloorTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#262423';
    ctx.fillRect(0, 0, 256, 256);

    // Subtle dark wood plank lines
    ctx.strokeStyle = '#1E1C1B';
    ctx.lineWidth = 2;
    for (let y = 0; y < 256; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();

      const offset = (y / 32) % 2 === 0 ? 64 : 160;
      ctx.beginPath();
      ctx.moveTo(offset, y);
      ctx.lineTo(offset, y + 32);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1.5, 1.5);
    return tex;
  }

  // ==================== [기능 2 & 3] 절차적 3D 가구 생성 알고리즘 (Procedural Mesh Generator) ====================
  function createProceduralFurnitureGroup(itemData) {
    const group = new THREE.Group();
    group.name = 'Furniture_' + itemData.id;
    group.userData = { furnitureId: itemData.id };

    const W = itemData.w * MM_TO_UNIT;
    const D = itemData.d * MM_TO_UNIT;
    const H = itemData.h * MM_TO_UNIT;

    // Prepare Primary Material (supports AI CanvasTexture if uploaded)
    let mainTexture = null;
    if (itemData.textureDataUrl) {
      const img = new Image();
      img.src = itemData.textureDataUrl;
      mainTexture = new THREE.CanvasTexture(img);
      img.onload = () => {
        mainTexture.needsUpdate = true;
      };
    }

    const primaryMat = new THREE.MeshStandardMaterial({
      color: mainTexture ? 0xFFFFFF : new THREE.Color(itemData.color || '#8B6F4E'),
      map: mainTexture || null,
      roughness: 0.58,
      metalness: 0.08
    });

    const secondaryMat = new THREE.MeshStandardMaterial({
      color: 0x272932,
      roughness: 0.45,
      metalness: 0.5
    });

    const fabricLightMat = new THREE.MeshStandardMaterial({
      color: 0xE5E7EB,
      roughness: 0.85,
      metalness: 0.02
    });

    const meshContainer = new THREE.Group();
    meshContainer.name = 'VisualMeshes';

    const cat = itemData.category;
    const shape = itemData.shape || 'legged';

    // Category + Shape aware compound geometry construction
    if (cat === 'bed') {
      // Bed Frame + Headboard + Legs + Mattress + Pillows + Blanket
      const legH = Math.min(0.16, H * 0.2);
      const baseH = Math.max(0.16, H * 0.25);
      const mattH = Math.max(0.18, H * 0.24);

      addFourCornerLegs(meshContainer, W, D, legH, 0.045, secondaryMat);

      // Bed frame base
      const frameMesh = createBoxMesh(W, baseH, D, primaryMat, 0, legH + baseH / 2, 0);
      meshContainer.add(frameMesh);

      // Headboard at -Z
      const headThick = Math.min(0.11, D * 0.06);
      const headMesh = createBoxMesh(W, H - legH, headThick, primaryMat, 0, legH + (H - legH) / 2, -D / 2 + headThick / 2);
      meshContainer.add(headMesh);

      // Mattress
      const mattW = W * 0.94;
      const mattD = D - headThick - 0.05;
      const mattY = legH + baseH + mattH / 2;
      const mattMesh = createBoxMesh(mattW, mattH, mattD, fabricLightMat, 0, mattY, headThick / 2);
      meshContainer.add(mattMesh);

      // Duvet / Blanket cover in primary color
      const duvetMesh = createBoxMesh(mattW + 0.01, mattH * 0.65, mattD * 0.65, primaryMat, 0, mattY + 0.015, headThick / 2 + mattD * 0.16);
      meshContainer.add(duvetMesh);

      // Pillows (1 for single, 2 for queen/wide)
      const pillowCount = itemData.w >= 1350 ? 2 : 1;
      const pillowW = pillowCount === 2 ? mattW * 0.4 : mattW * 0.58;
      for (let i = 0; i < pillowCount; i++) {
        const px = pillowCount === 2 ? (i === 0 ? -mattW * 0.24 : mattW * 0.24) : 0;
        const pillow = createBoxMesh(pillowW, 0.09, 0.34, fabricLightMat, px, legH + baseH + mattH + 0.04, -D / 2 + headThick + 0.24);
        meshContainer.add(pillow);
      }
    } else if (cat === 'desk') {
      if (shape === 'lshape') {
        // L-Shape Corner Desk
        const topThick = Math.min(0.05, H * 0.07);
        const legH = H - topThick;
        const wingW = W * 0.42;
        const wingD = D * 0.45;

        // Main desktop bar + side return bar
        const topMain = createBoxMesh(W, topThick, wingD, primaryMat, 0, H - topThick / 2, -D / 2 + wingD / 2);
        const topSide = createBoxMesh(wingW, topThick, D - wingD, primaryMat, -W / 2 + wingW / 2, H - topThick / 2, wingD / 2);
        meshContainer.add(topMain, topSide);

        const legPositions = [
          [-W / 2 + 0.05, -D / 2 + 0.05],
          [W / 2 - 0.05,  -D / 2 + 0.05],
          [W / 2 - 0.05,  -D / 2 + wingD - 0.05],
          [-W / 2 + 0.05, D / 2 - 0.05],
          [-W / 2 + wingW - 0.05, D / 2 - 0.05]
        ];
        legPositions.forEach(([lx, lz]) => {
          const leg = createCylinderMesh(0.025, 0.025, legH, secondaryMat, lx, legH / 2, lz);
          meshContainer.add(leg);
        });
      } else if (shape === 'cylinder') {
        // Round / Cafe Pedestal Table
        const topThick = 0.04;
        const radius = Math.min(W, D) / 2;
        const topCyl = createCylinderMesh(radius, radius, topThick, primaryMat, 0, H - topThick / 2, 0);
        const pole = createCylinderMesh(0.05, 0.05, H - topThick, secondaryMat, 0, (H - topThick) / 2, 0);
        const basePlate = createCylinderMesh(radius * 0.55, radius * 0.55, 0.025, secondaryMat, 0, 0.0125, 0);
        meshContainer.add(topCyl, pole, basePlate);
      } else {
        // Standard Desk / Table with Legs, Crossbar & Monitor Prop
        const topThick = 0.04;
        const legH = H - topThick;
        const topMesh = createBoxMesh(W, topThick, D, primaryMat, 0, H - topThick / 2, 0);
        meshContainer.add(topMesh);
        addFourCornerLegs(meshContainer, W * 0.92, D * 0.88, legH, 0.04, secondaryMat);

        // Modesty / structural bar
        const bar = createBoxMesh(W * 0.88, 0.04, 0.03, secondaryMat, 0, legH * 0.72, -D * 0.38);
        meshContainer.add(bar);

        // If it's the work desk catalog item, add a sleek monitor + keyboard prop
        if (itemData.catalogId === 'desk_work') {
          const stand = createBoxMesh(0.18, 0.14, 0.14, secondaryMat, 0, H + 0.07, -D * 0.25);
          const screen = createBoxMesh(0.62, 0.36, 0.025, secondaryMat, 0, H + 0.26, -D * 0.23);
          const pad = createBoxMesh(0.68, 0.006, 0.28, secondaryMat, 0, H + 0.004, D * 0.1);
          meshContainer.add(stand, screen, pad);
        }
      }
    } else if (cat === 'chair') {
      if (itemData.catalogId === 'chair_office' || shape === 'cylinder') {
        // Swivel Office Chair or Cylindrical Lounge Chair
        const seatY = H * 0.46;
        const baseStar = createCylinderMesh(W * 0.42, W * 0.45, 0.04, secondaryMat, 0, 0.04, 0);
        const gasLift = createCylinderMesh(0.03, 0.03, seatY - 0.04, secondaryMat, 0, seatY / 2, 0);
        const seat = createBoxMesh(W * 0.82, 0.07, D * 0.8, primaryMat, 0, seatY, 0);
        const back = createBoxMesh(W * 0.76, H - seatY - 0.04, 0.06, primaryMat, 0, seatY + (H - seatY) / 2, -D * 0.36);
        // Armrests
        const armL = createBoxMesh(0.045, 0.2, D * 0.5, secondaryMat, -W * 0.42, seatY + 0.12, -0.02);
        const armR = createBoxMesh(0.045, 0.2, D * 0.5, secondaryMat, W * 0.42, seatY + 0.12, -0.02);
        meshContainer.add(baseStar, gasLift, seat, back, armL, armR);
      } else if (shape === 'lshape') {
        // L-Shape Sectional Sofa
        const legH = 0.08;
        const seatH = H * 0.42;
        const backH = H - legH - seatH;
        const mainSeat = createBoxMesh(W, seatH, D * 0.58, primaryMat, 0, legH + seatH / 2, -D * 0.21);
        const chaiseSeat = createBoxMesh(W * 0.36, seatH, D * 0.42, primaryMat, W * 0.32, legH + seatH / 2, D * 0.29);
        const backrest = createBoxMesh(W, backH, 0.16, primaryMat, 0, legH + seatH + backH / 2, -D / 2 + 0.08);
        addFourCornerLegs(meshContainer, W * 0.94, D * 0.9, legH, 0.04, secondaryMat);
        meshContainer.add(mainSeat, chaiseSeat, backrest);
      } else {
        // Sofa or Armchair with Backrest, Armrests & Legs
        const legH = 0.1;
        const seatH = (H - legH) * 0.42;
        const armW = Math.min(0.16, W * 0.14);
        addFourCornerLegs(meshContainer, W * 0.92, D * 0.88, legH, 0.04, secondaryMat);

        const seatBase = createBoxMesh(W - armW * 2, seatH, D * 0.88, primaryMat, 0, legH + seatH / 2, 0.03);
        const backrest = createBoxMesh(W - armW * 2, H - legH - seatH, D * 0.2, primaryMat, 0, legH + seatH + (H - legH - seatH) / 2, -D / 2 + D * 0.1);
        const armL = createBoxMesh(armW, (H - legH) * 0.68, D, primaryMat, -W / 2 + armW / 2, legH + (H - legH) * 0.34, 0);
        const armR = createBoxMesh(armW, (H - legH) * 0.68, D, primaryMat, W / 2 - armW / 2, legH + (H - legH) * 0.34, 0);
        meshContainer.add(seatBase, backrest, armL, armR);
      }
    } else if (cat === 'wardrobe' || cat === 'appliance') {
      if (itemData.catalogId === 'bookshelf_5tier') {
        // 5-Tier Open Bookshelf
        const sideT = 0.03;
        const leftP = createBoxMesh(sideT, H, D, primaryMat, -W / 2 + sideT / 2, H / 2, 0);
        const rightP = createBoxMesh(sideT, H, D, primaryMat, W / 2 - sideT / 2, H / 2, 0);
        const backP = createBoxMesh(W, H, 0.015, primaryMat, 0, H / 2, -D / 2 + 0.008);
        meshContainer.add(leftP, rightP, backP);
        for (let i = 0; i <= 5; i++) {
          const sy = (i / 5) * (H - 0.03) + 0.015;
          const shelf = createBoxMesh(W - sideT * 2, 0.025, D - 0.01, primaryMat, 0, sy, 0);
          meshContainer.add(shelf);
        }
      } else {
        // Wardrobe / Cabinet / Appliance with Door Seam & Handles
        const body = createBoxMesh(W, H - 0.04, D - 0.02, primaryMat, 0, (H - 0.04) / 2 + 0.04, -0.01);
        const plinth = createBoxMesh(W * 0.96, 0.04, D * 0.92, secondaryMat, 0, 0.02, 0);
        const doorL = createBoxMesh(W / 2 - 0.008, H - 0.06, 0.02, primaryMat, -W / 4, H / 2 + 0.01, D / 2 - 0.01);
        const doorR = createBoxMesh(W / 2 - 0.008, H - 0.06, 0.02, primaryMat, W / 4, H / 2 + 0.01, D / 2 - 0.01);
        const handleL = createBoxMesh(0.018, 0.22, 0.025, secondaryMat, -0.04, H * 0.52, D / 2 + 0.01);
        const handleR = createBoxMesh(0.018, 0.22, 0.025, secondaryMat, 0.04, H * 0.52, D / 2 + 0.01);
        meshContainer.add(body, plinth, doorL, doorR, handleL, handleR);
      }
    } else {
      // Decor / Floor Lamp / Custom Shape Fallback
      if (itemData.catalogId === 'lamp_floor' || (cat === 'decor' && H > 1.0)) {
        const base = createCylinderMesh(W * 0.38, W * 0.42, 0.035, secondaryMat, 0, 0.018, 0);
        const pole = createCylinderMesh(0.018, 0.018, H - 0.3, secondaryMat, 0, (H - 0.3) / 2 + 0.03, 0);
        const shadeMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(itemData.color || '#F59E0B'),
          emissive: new THREE.Color(itemData.color || '#F59E0B'),
          emissiveIntensity: 0.35,
          roughness: 0.4
        });
        const shade = createCylinderMesh(W * 0.32, W * 0.48, 0.32, shadeMat, 0, H - 0.16, 0);
        meshContainer.add(base, pole, shade);
      } else if (shape === 'cylinder') {
        const cyl = createCylinderMesh(W / 2, W * 0.45, H, primaryMat, 0, H / 2, 0);
        meshContainer.add(cyl);
      } else if (shape === 'lshape') {
        const b1 = createBoxMesh(W, H, D * 0.45, primaryMat, 0, H / 2, -D * 0.275);
        const b2 = createBoxMesh(W * 0.45, H, D * 0.55, primaryMat, -W * 0.275, H / 2, D * 0.225);
        meshContainer.add(b1, b2);
      } else if (shape === 'legged') {
        const legH = H * 0.35;
        addFourCornerLegs(meshContainer, W * 0.9, D * 0.9, legH, 0.035, secondaryMat);
        const topBox = createBoxMesh(W, H - legH, D, primaryMat, 0, legH + (H - legH) / 2, 0);
        meshContainer.add(topBox);
      } else {
        const box = createBoxMesh(W, H, D, primaryMat, 0, H / 2, 0);
        meshContainer.add(box);
      }
    }

    group.add(meshContainer);
    group.userData.primaryMaterial = primaryMat;

    // Selection & Collision Bounding Wireframe Box (#4F46E5 when selected, #EF4444 when colliding)
    const boundGeo = new THREE.BoxGeometry(W + 0.02, H + 0.02, D + 0.02);
    boundGeo.translate(0, H / 2, 0);
    const edgesGeo = new THREE.EdgesGeometry(boundGeo);
    const outlineMat = new THREE.LineBasicMaterial({
      color: 0x4F46E5,
      linewidth: 2,
      transparent: true,
      opacity: 0.0
    });
    const outlineBox = new THREE.LineSegments(edgesGeo, outlineMat);
    outlineBox.name = 'SelectionOutline';
    group.add(outlineBox);

    // Red Collision Tint Shell (shown when colliding)
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0xEF4444,
      transparent: true,
      opacity: 0.0,
      depthWrite: false
    });
    const tintBox = new THREE.Mesh(boundGeo, tintMat);
    tintBox.name = 'CollisionShell';
    group.add(tintBox);

    // Ergonomic Activity Clearance Zone on Floor (생활과학 동선 반경)
    const frontClearance = (itemData.ergoClearance?.front || 550) * MM_TO_UNIT;
    const sideClearance = (itemData.ergoClearance?.side || 200) * MM_TO_UNIT;
    const ergoW = W + sideClearance * 2;
    const ergoD = D + frontClearance;

    const ergoGeo = new THREE.PlaneGeometry(ergoW, ergoD);
    ergoGeo.rotateX(-Math.PI / 2);
    ergoGeo.translate(0, 0.005, frontClearance / 2);

    const ergoMat = new THREE.MeshBasicMaterial({
      color: 0x10B981,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ergoPlane = new THREE.Mesh(ergoGeo, ergoMat);
    ergoPlane.name = 'ErgoZoneMesh';
    ergoPlane.visible = state.globalErgoVisible && (itemData.ergoVisible !== false);
    group.add(ergoPlane);

    // Front Direction Indicator Arrow on Ergo Zone
    const ergoEdge = new THREE.EdgesGeometry(ergoGeo);
    const ergoLine = new THREE.LineSegments(
      ergoEdge,
      new THREE.LineBasicMaterial({ color: 0x34D399, transparent: true, opacity: 0.45 })
    );
    ergoLine.name = 'ErgoZoneLine';
    ergoLine.visible = ergoPlane.visible;
    group.add(ergoLine);

    // Apply Transform
    group.position.set(
      itemData.x * MM_TO_UNIT,
      (itemData.y || 0) * MM_TO_UNIT,
      itemData.z * MM_TO_UNIT
    );
    group.rotation.y = THREE.MathUtils.degToRad(itemData.rotY || 0);

    return group;
  }

  function createBoxMesh(w, h, d, mat, x, y, z) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function createCylinderMesh(rt, rb, h, mat, x, y, z) {
    const geo = new THREE.CylinderGeometry(rt, rb, h, 24);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function addFourCornerLegs(parent, spanW, spanD, legH, legSize, mat) {
    const hw = spanW / 2 - legSize / 2;
    const hd = spanD / 2 - legSize / 2;
    const coords = [
      [-hw, -hd],
      [hw,  -hd],
      [hw,  hd],
      [-hw, hd]
    ];
    coords.forEach(([lx, lz]) => {
      const leg = createBoxMesh(legSize, legH, legSize, mat, lx, legH / 2, lz);
      parent.add(leg);
    });
  }

  // ==================== FURNITURE CRUD & PLACEMENT ====================
  function addFurnitureFromTemplate(template, customTransform = {}) {
    const id = 'furn_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newItem = {
      id,
      catalogId: template.catalogId || id,
      name: template.name,
      category: template.category,
      shape: template.shape || 'legged',
      w: Number(template.w),
      d: Number(template.d),
      h: Number(template.h),
      x: customTransform.x !== undefined ? customTransform.x : 0,
      y: customTransform.y !== undefined ? customTransform.y : 0,
      z: customTransform.z !== undefined ? customTransform.z : 0,
      rotY: customTransform.rotY !== undefined ? customTransform.rotY : 0,
      color: template.color || '#8B6F4E',
      textureDataUrl: template.textureDataUrl || null,
      ergoClearance: template.ergoClearance || { front: 550, side: 200 },
      ergoVisible: true,
      isAI: !!template.isAI,
      isColliding: false,
      collisionReason: ''
    };

    state.furnitureList.push(newItem);
    const meshGroup = createProceduralFurnitureGroup(newItem);
    furnitureGroup.add(meshGroup);
    furnitureMeshMap.set(id, meshGroup);

    selectFurniture(id);
    evaluateAllCollisions();
    draw2DFloorplan();
    return newItem;
  }

  function rebuildSingleFurnitureMesh(item) {
    const oldMesh = furnitureMeshMap.get(item.id);
    if (oldMesh) {
      furnitureGroup.remove(oldMesh);
    }
    const newMesh = createProceduralFurnitureGroup(item);
    furnitureGroup.add(newMesh);
    furnitureMeshMap.set(item.id, newMesh);
    updateFurnitureVisualStatus(item);
  }

  function selectFurniture(id) {
    state.selectedFurnitureId = id;
    state.furnitureList.forEach((item) => {
      updateFurnitureVisualStatus(item);
    });
    updateInspectorUI();
    draw2DFloorplan();
  }

  function deleteSelectedFurniture() {
    if (!state.selectedFurnitureId) return;
    const id = state.selectedFurnitureId;
    const idx = state.furnitureList.findIndex((f) => f.id === id);
    if (idx !== -1) {
      const removed = state.furnitureList.splice(idx, 1)[0];
      const mesh = furnitureMeshMap.get(id);
      if (mesh) {
        furnitureGroup.remove(mesh);
        furnitureMeshMap.delete(id);
      }
      showToast(`'${removed.name}' 가구가 삭제되었습니다.`);
    }
    state.selectedFurnitureId = null;
    evaluateAllCollisions();
    updateInspectorUI();
    draw2DFloorplan();
  }

  // ==================== [기능 2-3] 충돌 감지 및 생활과학 동선(방문 900mm 반경) 체크 ====================
  function evaluateAllCollisions() {
    // Compute oriented bounding boxes (approximated as world AABB of the VisualMeshes group)
    const itemBoxes = new Map();

    state.furnitureList.forEach((item) => {
      const group = furnitureMeshMap.get(item.id);
      if (!group) return;
      group.updateMatrixWorld(true);
      const visualNode = group.getObjectByName('VisualMeshes') || group;
      const box3 = new THREE.Box3().setFromObject(visualNode);
      // Slight inward tolerance (8mm) so flush-against-wall placement is allowed without false positive
      box3.expandByScalar(-0.008);
      itemBoxes.set(item.id, box3);

      item.isColliding = false;
      item.collisionReason = '';
    });

    // 1. Check Furniture vs Furniture AABB Collision
    for (let i = 0; i < state.furnitureList.length; i++) {
      for (let j = i + 1; j < state.furnitureList.length; j++) {
        const a = state.furnitureList[i];
        const b = state.furnitureList[j];
        const boxA = itemBoxes.get(a.id);
        const boxB = itemBoxes.get(b.id);
        if (boxA && boxB && boxA.intersectsBox(boxB)) {
          a.isColliding = true;
          b.isColliding = true;
          a.collisionReason = `다른 가구(${b.name})와 공간이 겹쳐 있습니다.`;
          b.collisionReason = `다른 가구(${a.name})와 공간이 겹쳐 있습니다.`;
        }
      }
    }

    // 2. Check Furniture vs Walls & Outside Floor Boundary
    const poly = getEffectiveFloorPolygon();
    state.furnitureList.forEach((item) => {
      const box = itemBoxes.get(item.id);
      if (!box) return;

      // Check 4 bottom corners of furniture AABB against floor polygon
      const cornersMM = [
        { x: box.min.x * UNIT_TO_MM, z: box.min.z * UNIT_TO_MM },
        { x: box.max.x * UNIT_TO_MM, z: box.min.z * UNIT_TO_MM },
        { x: box.max.x * UNIT_TO_MM, z: box.max.z * UNIT_TO_MM },
        { x: box.min.x * UNIT_TO_MM, z: box.max.z * UNIT_TO_MM }
      ];

      for (const pt of cornersMM) {
        if (!isPointInPolygon2D(pt, poly)) {
          item.isColliding = true;
          item.collisionReason = '가구가 벽체를 뚫고 방 경계 밖으로 벗어났습니다.';
          break;
        }
      }

      // Check against each wall segment thickness
      for (const wall of state.walls) {
        const halfThick = (wall.thickness || state.wallThickness) / 2 - 12;
        if (boxIntersectsWallSegmentMM(box, wall, halfThick)) {
          item.isColliding = true;
          item.collisionReason = '가구가 벽체(Wall) 내부와 충돌하고 있습니다.';
          break;
        }
      }

      // 3. Check Furniture vs 900mm Door Opening Swing Radius
      for (const doorZone of doorSwingZones) {
        if (box.intersectsBox(doorZone.box3)) {
          // Refine with 2D circle-AABB check on XZ plane (radius = 0.88m)
          const cx = doorZone.center.x;
          const cz = doorZone.center.z;
          const closestX = Math.max(box.min.x, Math.min(cx, box.max.x));
          const closestZ = Math.max(box.min.z, Math.min(cz, box.max.z));
          const dist = Math.hypot(cx - closestX, cz - closestZ);
          if (dist < 0.45) {
            item.isColliding = true;
            item.collisionReason = '방문 개폐 반경(900mm)을 침범하여 문이 열리지 않습니다.';
            break;
          }
        }
      }

      updateFurnitureVisualStatus(item);
    });

    // Update HUD Banner
    const collidingItems = state.furnitureList.filter((f) => f.isColliding);
    const hudBanner = document.getElementById('hud-collision-banner');
    const hudText = document.getElementById('hud-collision-text');

    if (collidingItems.length > 0) {
      hudBanner.classList.remove('status-ok');
      hudBanner.classList.add('status-danger');
      hudText.textContent = `충돌 경고 (${collidingItems.length}건): ${collidingItems[0].collisionReason}`;
    } else {
      hudBanner.classList.remove('status-danger');
      hudBanner.classList.add('status-ok');
      hudText.textContent = '충돌 없음 · 방문(900mm) 및 생활 동선 안전';
    }

    renderPlacedFurnitureListUI();
    if (state.selectedFurnitureId) {
      updateSelectedCollisionUI();
    }
  }

  function updateFurnitureVisualStatus(item) {
    const group = furnitureMeshMap.get(item.id);
    if (!group) return;

    const isSelected = item.id === state.selectedFurnitureId;
    const outline = group.getObjectByName('SelectionOutline');
    const shell = group.getObjectByName('CollisionShell');
    const ergoMesh = group.getObjectByName('ErgoZoneMesh');
    const ergoLine = group.getObjectByName('ErgoZoneLine');

    if (outline) {
      if (item.isColliding) {
        outline.material.color.setHex(0xEF4444); // Red warning
        outline.material.opacity = 1.0;
      } else if (isSelected) {
        outline.material.color.setHex(0x4F46E5); // Indigo active
        outline.material.opacity = 1.0;
      } else {
        outline.material.opacity = 0.0;
      }
    }

    if (shell) {
      shell.material.opacity = item.isColliding ? 0.28 : 0.0;
    }

    const showErgo = state.globalErgoVisible && (item.ergoVisible !== false);
    if (ergoMesh) {
      ergoMesh.visible = showErgo;
      ergoMesh.material.color.setHex(item.isColliding ? 0xEF4444 : 0x10B981);
    }
    if (ergoLine) {
      ergoLine.visible = showErgo;
    }
  }

  function isPointInPolygon2D(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;
      const intersect = ((zi > pt.z) !== (zj > pt.z)) &&
        (pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi + 0.00001) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function boxIntersectsWallSegmentMM(box, wall, halfThickMM) {
    const minX = box.min.x * UNIT_TO_MM;
    const maxX = box.max.x * UNIT_TO_MM;
    const minZ = box.min.z * UNIT_TO_MM;
    const maxZ = box.max.z * UNIT_TO_MM;

    // Sample points along the wall segment
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const wx = wall.x1 + (wall.x2 - wall.x1) * t;
      const wz = wall.z1 + (wall.z2 - wall.z1) * t;
      if (
        wx >= minX - halfThickMM &&
        wx <= maxX + halfThickMM &&
        wz >= minZ - halfThickMM &&
        wz <= maxZ + halfThickMM
      ) {
        return true;
      }
    }
    return false;
  }

  // ==================== 3D RAYCASTER DRAG & DROP ====================
  function on3DPointerDown(e) {
    if (state.mode !== '3d' || e.button !== 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouseNDC, camera);
    const hitList = raycaster.intersectObjects(furnitureGroup.children, true);

    if (hitList.length > 0) {
      // Find top-level furniture group
      let node = hitList[0].object;
      while (node && node.parent !== furnitureGroup) {
        node = node.parent;
      }
      if (node && node.userData.furnitureId) {
        const fid = node.userData.furnitureId;
        selectFurniture(fid);

        isDragging3D = true;
        dragged3DObject = node;
        controls.enabled = false;

        const intersectPt = new THREE.Vector3();
        dragPlane.constant = -node.position.y;
        if (raycaster.ray.intersectPlane(dragPlane, intersectPt)) {
          drag3DOffset.copy(node.position).sub(intersectPt);
        }
        return;
      }
    } else {
      // Clicked empty space -> deselect
      selectFurniture(null);
    }
  }

  function on3DPointerMove(e) {
    if (!isDragging3D || !dragged3DObject || state.mode !== '3d') return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouseNDC, camera);
    const intersectPt = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, intersectPt)) {
      const targetPos = intersectPt.add(drag3DOffset);
      let newXMM = targetPos.x * UNIT_TO_MM;
      let newZMM = targetPos.z * UNIT_TO_MM;

      if (state.snapToGrid) {
        newXMM = Math.round(newXMM / 50) * 50;
        newZMM = Math.round(newZMM / 50) * 50;
      }

      dragged3DObject.position.x = newXMM * MM_TO_UNIT;
      dragged3DObject.position.z = newZMM * MM_TO_UNIT;

      const item = state.furnitureList.find((f) => f.id === dragged3DObject.userData.furnitureId);
      if (item) {
        item.x = Math.round(newXMM);
        item.z = Math.round(newZMM);
        syncInspectorPositionFields(item);
      }

      evaluateAllCollisions();
    }
  }

  function on3DPointerUp() {
    if (isDragging3D) {
      isDragging3D = false;
      dragged3DObject = null;
      controls.enabled = true;
      draw2DFloorplan();
    }
  }

  function onGlobalKeyDown(e) {
    // Ignore when typing inside an input
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedFurnitureId) {
        deleteSelectedFurniture();
      }
    } else if (e.key === 'r' || e.key === 'R') {
      if (state.selectedFurnitureId) {
        rotateSelectedFurnitureBy(90);
      }
    }
  }

  // ==================== FRONT WALL CUTAWAY IN 3D VIEW ====================
  function updateFrontWallCutaway() {
    if (!wallMeshes.length) return;
    const camDir = new THREE.Vector3();

    wallMeshes.forEach((wallGroup) => {
      const mat = wallGroup.userData.wallMaterial;
      if (!mat) return;

      if (!state.autoCutaway || wallGroup.userData.isInterior) {
        mat.opacity = 1.0;
        wallGroup.scale.y = 1.0;
        return;
      }

      // Vector from wall midpoint to camera
      camDir.copy(camera.position).sub(wallGroup.userData.midPoint).normalize();
      const dot = camDir.dot(wallGroup.userData.outwardNormal);

      // If camera is looking from the outside of this exterior wall inward, make it low & translucent
      if (dot > 0.22) {
        mat.opacity = 0.18;
        wallGroup.scale.y = 0.22;
      } else {
        mat.opacity = 1.0;
        wallGroup.scale.y = 1.0;
      }
    });
  }

  // ==================== [기능 1-2] 2D FLOORPLAN EDITOR ====================
  function init2DCanvas() {
    canvas2D = document.getElementById('floorplan-canvas');
    ctx2D = canvas2D.getContext('2d');

    const container = document.getElementById('center-viewport');
    canvas2D.width = container.clientWidth;
    canvas2D.height = container.clientHeight;

    canvas2D.addEventListener('pointerdown', on2DPointerDown);
    canvas2D.addEventListener('pointermove', on2DPointerMove);
    window.addEventListener('pointerup', on2DPointerUp);
    canvas2D.addEventListener('wheel', on2DWheel, { passive: false });
  }

  function mmToCanvas2D(xMM, zMM) {
    const cx = canvas2D.width / 2 + state.pan2D.x;
    const cy = canvas2D.height / 2 + state.pan2D.y;
    return {
      px: cx + xMM * state.zoom2D,
      py: cy + zMM * state.zoom2D
    };
  }

  function canvas2DToMM(px, py, snap = 100) {
    const cx = canvas2D.width / 2 + state.pan2D.x;
    const cy = canvas2D.height / 2 + state.pan2D.y;
    let xMM = (px - cx) / state.zoom2D;
    let zMM = (py - cy) / state.zoom2D;
    if (snap > 0) {
      xMM = Math.round(xMM / snap) * snap;
      zMM = Math.round(zMM / snap) * snap;
    }
    return { x: xMM, z: zMM };
  }

  function draw2DFloorplan() {
    if (!ctx2D || !canvas2D) return;
    const W = canvas2D.width;
    const H = canvas2D.height;

    ctx2D.clearRect(0, 0, W, H);
    ctx2D.fillStyle = '#121316';
    ctx2D.fillRect(0, 0, W, H);

    // 1. Draw CAD Grid (100mm minor, 500mm major)
    const stepMinor = 100 * state.zoom2D;
    const stepMajor = 500 * state.zoom2D;
    const cx = W / 2 + state.pan2D.x;
    const cy = H / 2 + state.pan2D.y;

    if (stepMinor >= 6) {
      ctx2D.strokeStyle = '#1B1D22';
      ctx2D.lineWidth = 1;
      ctx2D.beginPath();
      for (let x = cx % stepMinor; x < W; x += stepMinor) {
        ctx2D.moveTo(x, 0); ctx2D.lineTo(x, H);
      }
      for (let y = cy % stepMinor; y < H; y += stepMinor) {
        ctx2D.moveTo(0, y); ctx2D.lineTo(W, y);
      }
      ctx2D.stroke();
    }

    ctx2D.strokeStyle = '#262932';
    ctx2D.lineWidth = 1;
    ctx2D.beginPath();
    for (let x = cx % stepMajor; x < W; x += stepMajor) {
      ctx2D.moveTo(x, 0); ctx2D.lineTo(x, H);
    }
    for (let y = cy % stepMajor; y < H; y += stepMajor) {
      ctx2D.moveTo(0, y); ctx2D.lineTo(W, y);
    }
    ctx2D.stroke();

    // 2. Draw Floor Polygon Fill
    const poly = getEffectiveFloorPolygon();
    if (poly.length >= 3) {
      ctx2D.fillStyle = '#1C1E24';
      ctx2D.beginPath();
      poly.forEach((pt, idx) => {
        const p = mmToCanvas2D(pt.x, pt.z);
        if (idx === 0) ctx2D.moveTo(p.px, p.py);
        else ctx2D.lineTo(p.px, p.py);
      });
      ctx2D.closePath();
      ctx2D.fill();
    }

    // 3. Draw Furniture Footprint Boxes & Ergonomic Zones in 2D
    state.furnitureList.forEach((item) => {
      const center = mmToCanvas2D(item.x, item.z);
      const pw = item.w * state.zoom2D;
      const pd = item.d * state.zoom2D;

      ctx2D.save();
      ctx2D.translate(center.px, center.py);
      ctx2D.rotate(THREE.MathUtils.degToRad(-item.rotY));

      // Ergonomic zone in 2D
      if (state.globalErgoVisible && item.ergoVisible !== false) {
        const frontC = (item.ergoClearance?.front || 550) * state.zoom2D;
        const sideC = (item.ergoClearance?.side || 200) * state.zoom2D;
        ctx2D.fillStyle = item.isColliding ? 'rgba(239, 68, 68, 0.16)' : 'rgba(16, 185, 129, 0.12)';
        ctx2D.strokeStyle = item.isColliding ? '#EF4444' : '#10B981';
        ctx2D.setLineDash([4, 4]);
        ctx2D.lineWidth = 1;
        ctx2D.fillRect(-pw / 2 - sideC, -pd / 2, pw + sideC * 2, pd + frontC);
        ctx2D.strokeRect(-pw / 2 - sideC, -pd / 2, pw + sideC * 2, pd + frontC);
        ctx2D.setLineDash([]);
      }

      // Furniture Box
      ctx2D.fillStyle = item.isColliding ? 'rgba(239, 68, 68, 0.45)' : (item.color || '#4B5563');
      ctx2D.strokeStyle = item.id === state.selectedFurnitureId ? '#4F46E5' : (item.isColliding ? '#EF4444' : '#E2E4E9');
      ctx2D.lineWidth = item.id === state.selectedFurnitureId ? 2.5 : 1.2;
      ctx2D.fillRect(-pw / 2, -pd / 2, pw, pd);
      ctx2D.strokeRect(-pw / 2, -pd / 2, pw, pd);

      // Label
      ctx2D.fillStyle = '#FFFFFF';
      ctx2D.font = '600 11px Inter, sans-serif';
      ctx2D.textAlign = 'center';
      ctx2D.textBaseline = 'middle';
      ctx2D.fillText(item.name.slice(0, 10), 0, 0);
      ctx2D.restore();
    });

    // 4. Draw Walls & Dimension Labels
    state.walls.forEach((wall) => {
      const p1 = mmToCanvas2D(wall.x1, wall.z1);
      const p2 = mmToCanvas2D(wall.x2, wall.z2);
      const thickPx = Math.max(6, (wall.thickness || state.wallThickness) * state.zoom2D);

      ctx2D.strokeStyle = '#9CA3AF';
      ctx2D.lineWidth = thickPx;
      ctx2D.lineCap = 'square';
      ctx2D.beginPath();
      ctx2D.moveTo(p1.px, p1.py);
      ctx2D.lineTo(p2.px, p2.py);
      ctx2D.stroke();

      // Dimension label in mm
      const lenMM = Math.round(Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1));
      const midX = (p1.px + p2.px) / 2;
      const midY = (p1.py + p2.py) / 2;
      ctx2D.fillStyle = '#18191C';
      ctx2D.fillRect(midX - 28, midY - 9, 56, 18);
      ctx2D.strokeStyle = '#3F4352';
      ctx2D.lineWidth = 1;
      ctx2D.strokeRect(midX - 28, midY - 9, 56, 18);
      ctx2D.fillStyle = '#E2E4E9';
      ctx2D.font = '500 10.5px "JetBrains Mono", monospace';
      ctx2D.textAlign = 'center';
      ctx2D.textBaseline = 'middle';
      ctx2D.fillText(`${lenMM}mm`, midX, midY);
    });

    // 5. Draw Doors (with 900mm swing arc) & Windows on Walls
    state.openings.forEach((op) => {
      const wall = state.walls.find((w) => w.id === op.wallId);
      if (!wall) return;

      const wx = wall.x1 + (wall.x2 - wall.x1) * op.t;
      const wz = wall.z1 + (wall.z2 - wall.z1) * op.t;
      const angle = Math.atan2(wall.z2 - wall.z1, wall.x2 - wall.x1);
      const center = mmToCanvas2D(wx, wz);
      const widthPx = (op.width || 900) * state.zoom2D;
      const thickPx = Math.max(8, (wall.thickness || state.wallThickness) * state.zoom2D + 2);

      ctx2D.save();
      ctx2D.translate(center.px, center.py);
      ctx2D.rotate(angle);

      // Clear wall gap
      ctx2D.fillStyle = '#121316';
      ctx2D.fillRect(-widthPx / 2, -thickPx / 2, widthPx, thickPx);

      if (op.type === 'door') {
        const rPx = 900 * state.zoom2D;
        // 900mm Door Swing Sector
        ctx2D.fillStyle = 'rgba(79, 70, 229, 0.22)';
        ctx2D.strokeStyle = '#818CF8';
        ctx2D.lineWidth = 1.5;
        ctx2D.beginPath();
        ctx2D.moveTo(-widthPx / 2, 0);
        ctx2D.arc(-widthPx / 2, 0, rPx, 0, Math.PI / 2);
        ctx2D.closePath();
        ctx2D.fill();
        ctx2D.stroke();

        // Label 900mm
        ctx2D.fillStyle = '#A5B4FC';
        ctx2D.font = '500 10px "JetBrains Mono", monospace';
        ctx2D.fillText('R900', -widthPx / 2 + rPx * 0.45, rPx * 0.45);
      } else {
        // Window symbol (double pane cyan line)
        ctx2D.strokeStyle = '#38BDF8';
        ctx2D.lineWidth = 2;
        ctx2D.strokeRect(-widthPx / 2, -thickPx / 3, widthPx, (thickPx * 2) / 3);
      }

      ctx2D.restore();
    });

    // 6. Active Wall Drawing Preview Line
    if (state.isDrawingWall && state.drawStartPt && state.drawCurrentPt) {
      const p1 = mmToCanvas2D(state.drawStartPt.x, state.drawStartPt.z);
      const p2 = mmToCanvas2D(state.drawCurrentPt.x, state.drawCurrentPt.z);
      ctx2D.strokeStyle = '#4F46E5';
      ctx2D.lineWidth = state.wallThickness * state.zoom2D;
      ctx2D.beginPath();
      ctx2D.moveTo(p1.px, p1.py);
      ctx2D.lineTo(p2.px, p2.py);
      ctx2D.stroke();

      const dist = Math.round(Math.hypot(
        state.drawCurrentPt.x - state.drawStartPt.x,
        state.drawCurrentPt.z - state.drawStartPt.z
      ));
      ctx2D.fillStyle = '#818CF8';
      ctx2D.font = '600 12px "JetBrains Mono", monospace';
      ctx2D.fillText(`${dist} mm`, (p1.px + p2.px) / 2, (p1.py + p2.py) / 2 - 14);
    }
  }

  function on2DPointerDown(e) {
    if (state.mode !== '2d') return;
    const rect = canvas2D.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (state.drawTool === 'wall') {
      state.isDrawingWall = true;
      state.drawStartPt = canvas2DToMM(px, py, 100);
      state.drawCurrentPt = { ...state.drawStartPt };
      draw2DFloorplan();
    } else if (state.drawTool === 'door' || state.drawTool === 'window') {
      const clickMM = canvas2DToMM(px, py, 10);
      placeOpeningOnClosestWall(clickMM, state.drawTool);
    } else if (state.drawTool === 'erase') {
      const clickMM = canvas2DToMM(px, py, 10);
      erase2DElementNear(clickMM);
    } else {
      // 'select' tool -> select and drag furniture in 2D
      const clickMM = canvas2DToMM(px, py, 1);
      const hitFurn = findFurnitureAt2DPoint(clickMM.x, clickMM.z);
      if (hitFurn) {
        selectFurniture(hitFurn.id);
        state.dragging2DFurnitureId = hitFurn.id;
        state.drag2DOffset = {
          x: hitFurn.x - clickMM.x,
          z: hitFurn.z - clickMM.z
        };
      } else {
        selectFurniture(null);
      }
    }
  }

  function on2DPointerMove(e) {
    if (state.mode !== '2d') return;
    const rect = canvas2D.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (state.isDrawingWall) {
      state.drawCurrentPt = canvas2DToMM(px, py, 100);
      draw2DFloorplan();
    } else if (state.dragging2DFurnitureId) {
      const mm = canvas2DToMM(px, py, 1);
      const item = state.furnitureList.find((f) => f.id === state.dragging2DFurnitureId);
      if (item) {
        let nx = mm.x + state.drag2DOffset.x;
        let nz = mm.z + state.drag2DOffset.z;
        if (state.snapToGrid) {
          nx = Math.round(nx / 50) * 50;
          nz = Math.round(nz / 50) * 50;
        }
        item.x = Math.round(nx);
        item.z = Math.round(nz);
        const mesh = furnitureMeshMap.get(item.id);
        if (mesh) {
          mesh.position.x = item.x * MM_TO_UNIT;
          mesh.position.z = item.z * MM_TO_UNIT;
        }
        syncInspectorPositionFields(item);
        evaluateAllCollisions();
        draw2DFloorplan();
      }
    }
  }

  function on2DPointerUp() {
    if (state.isDrawingWall && state.drawStartPt && state.drawCurrentPt) {
      const len = Math.hypot(
        state.drawCurrentPt.x - state.drawStartPt.x,
        state.drawCurrentPt.z - state.drawStartPt.z
      );
      if (len >= 200) {
        state.walls.push({
          id: 'wall_custom_' + Date.now(),
          x1: state.drawStartPt.x,
          z1: state.drawStartPt.z,
          x2: state.drawCurrentPt.x,
          z2: state.drawCurrentPt.z,
          thickness: state.wallThickness,
          height: state.ceilingHeight,
          isInterior: true
        });
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        showToast(`새 벽체 (${Math.round(len)}mm)가 추가되었습니다.`);
      }
    }
    state.isDrawingWall = false;
    state.drawStartPt = null;
    state.drawCurrentPt = null;
    state.dragging2DFurnitureId = null;
    draw2DFloorplan();
  }

  function on2DWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    state.zoom2D = Math.min(0.28, Math.max(0.04, state.zoom2D * factor));
    draw2DFloorplan();
  }

  function placeOpeningOnClosestWall(ptMM, type) {
    let bestWall = null;
    let bestT = 0.5;
    let bestDist = Infinity;

    state.walls.forEach((w) => {
      const dx = w.x2 - w.x1;
      const dz = w.z2 - w.z1;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1) return;
      let t = ((ptMM.x - w.x1) * dx + (ptMM.z - w.z1) * dz) / lenSq;
      t = Math.max(0.18, Math.min(0.82, t));
      const projX = w.x1 + t * dx;
      const projZ = w.z1 + t * dz;
      const d = Math.hypot(ptMM.x - projX, ptMM.z - projZ);
      if (d < bestDist) {
        bestDist = d;
        bestWall = w;
        bestT = t;
      }
    });

    if (bestWall && bestDist < 450) {
      state.openings.push({
        id: 'open_' + Date.now(),
        wallId: bestWall.id,
        type,
        t: bestT,
        width: type === 'door' ? 900 : 1400,
        height: type === 'door' ? 2100 : 1200,
        sill: type === 'door' ? 0 : 850,
        swingDir: 1
      });
      rebuild3DRoomGeometry();
      evaluateAllCollisions();
      draw2DFloorplan();
      showToast(type === 'door' ? '방문(개폐 반경 900mm)이 벽에 배치되었습니다.' : '창문이 벽에 배치되었습니다.');
    } else {
      showToast('문/창문을 배치하려면 기존 벽 선분 위를 클릭하세요.');
    }
  }

  function erase2DElementNear(ptMM) {
    // First check openings
    for (let i = state.openings.length - 1; i >= 0; i--) {
      const op = state.openings[i];
      const w = state.walls.find((wall) => wall.id === op.wallId);
      if (!w) continue;
      const ox = w.x1 + (w.x2 - w.x1) * op.t;
      const oz = w.z1 + (w.z2 - w.z1) * op.t;
      if (Math.hypot(ptMM.x - ox, ptMM.z - oz) < 350) {
        state.openings.splice(i, 1);
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        draw2DFloorplan();
        showToast('문/창문 요소가 삭제되었습니다.');
        return;
      }
    }

    // Check walls
    for (let i = state.walls.length - 1; i >= 0; i--) {
      const w = state.walls[i];
      const mx = (w.x1 + w.x2) / 2;
      const mz = (w.z1 + w.z2) / 2;
      if (Math.hypot(ptMM.x - mx, ptMM.z - mz) < 450) {
        const wid = w.id;
        state.walls.splice(i, 1);
        state.openings = state.openings.filter((o) => o.wallId !== wid);
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        draw2DFloorplan();
        showToast('벽체가 삭제되었습니다.');
        return;
      }
    }
  }

  function findFurnitureAt2DPoint(xMM, zMM) {
    for (let i = state.furnitureList.length - 1; i >= 0; i--) {
      const item = state.furnitureList[i];
      const hw = item.w / 2;
      const hd = item.d / 2;
      if (xMM >= item.x - hw && xMM <= item.x + hw && zMM >= item.z - hd && zMM <= item.z + hd) {
        return item;
      }
    }
    return null;
  }

  // ==================== [기능 3] AI 기반 미제공 가구 3D 모델 자동 생성기 ====================
  function handleAIImageUpload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const img = new Image();
      img.onload = () => {
        // Extract Dominant Color + create normalized texture via HTML5 Canvas
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = 128;
        sampleCanvas.height = 128;
        const sCtx = sampleCanvas.getContext('2d');
        sCtx.drawImage(img, 0, 0, 128, 128);

        const imgData = sCtx.getImageData(16, 16, 96, 96).data;
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let i = 0; i < imgData.length; i += 4) {
          const a = imgData[i + 3];
          if (a < 128) continue;
          rSum += imgData[i];
          gSum += imgData[i + 1];
          bSum += imgData[i + 2];
          count++;
        }
        if (count > 0) {
          const r = Math.round(rSum / count);
          const g = Math.round(gSum / count);
          const b = Math.round(bSum / count);
          const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
          state.aiExtractedHex = hex;
          document.getElementById('ai-fallback-color').value = hex;
          document.getElementById('ai-fallback-color-label').textContent = hex;
          document.getElementById('ai-extracted-swatch').style.background = hex;
          document.getElementById('ai-extracted-hex').textContent = `추출 색상: ${hex}`;
        }

        state.aiUploadedImageDataUrl = sampleCanvas.toDataURL('image/jpeg', 0.85);
        const previewImg = document.getElementById('ai-preview-img');
        previewImg.src = dataUrl;
        document.getElementById('ai-dropzone-prompt').classList.add('hidden');
        document.getElementById('ai-preview-wrap').classList.remove('hidden');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function triggerAIFurnitureGeneration() {
    const name = document.getElementById('ai-furn-name').value.trim() || 'AI 커스텀 가구';
    const category = document.getElementById('ai-furn-category').value;
    const shape = document.getElementById('ai-furn-shape').value;
    const w = Math.max(200, Number(document.getElementById('ai-dim-w').value) || 1200);
    const d = Math.max(200, Number(document.getElementById('ai-dim-d').value) || 700);
    const h = Math.max(200, Number(document.getElementById('ai-dim-h').value) || 750);
    const color = document.getElementById('ai-fallback-color').value || state.aiExtractedHex;

    const loadingBox = document.getElementById('ai-loading-box');
    const progressBar = document.getElementById('ai-progress-bar');
    const stepText = document.getElementById('ai-loading-step');
    const genBtn = document.getElementById('btn-generate-ai-furniture');

    loadingBox.classList.remove('hidden');
    genBtn.disabled = true;
    progressBar.style.width = '0%';

    const startTime = performance.now();
    const duration = 1500; // 1.5s AI analysis & procedural mesh synthesis simulation

    function stepAnim(now) {
      const elapsed = now - startTime;
      const pct = Math.min(100, Math.round((elapsed / duration) * 100));
      progressBar.style.width = pct + '%';

      if (pct < 35) {
        stepText.textContent = '1/3 HTML5 Canvas 픽셀 샘플링 및 주요 색상(Dominant Color) 추출 중...';
      } else if (pct < 75) {
        stepText.textContent = `2/3 [${category.toUpperCase()} + ${shape}] 절차적 3D 지오메트리 합성 중...`;
      } else {
        stepText.textContent = '3/3 THREE.CanvasTexture UV 매핑 및 충돌 경계 상자(Box3) 생성 중...';
      }

      if (elapsed < duration) {
        requestAnimationFrame(stepAnim);
      } else {
        loadingBox.classList.add('hidden');
        genBtn.disabled = false;

        const aiTemplate = {
          catalogId: 'ai_custom_' + Date.now(),
          name,
          category,
          shape,
          w,
          d,
          h,
          color,
          textureDataUrl: state.aiUploadedImageDataUrl,
          tag: 'AI 생성',
          isAI: true,
          ergoClearance: { front: 600, side: 200 }
        };

        // Save to '내 AI 가구 보관함'
        state.aiVault.unshift(aiTemplate);
        renderAIVaultUI();

        // Switch to 3D mode if currently in 2D and place in room center
        if (state.mode !== '3d') {
          switchViewportMode('3d');
        }
        addFurnitureFromTemplate(aiTemplate, { x: 0, z: 0, rotY: 0 });
        showToast(`AI 커스텀 가구 '${name}' 생성 완료 및 공간 중앙 배치!`);
      }
    }

    requestAnimationFrame(stepAnim);
  }

  // ==================== UI RENDERING & BINDINGS ====================
  function renderCatalogUI() {
    const listEl = document.getElementById('catalog-list');
    listEl.innerHTML = '';

    DEFAULT_CATALOG.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'catalog-card';
      card.innerHTML = `
        <div class="catalog-card-top">
          <span class="catalog-swatch" style="background:${item.color};"></span>
          <span class="catalog-tag">${item.tag}</span>
        </div>
        <div class="catalog-name">${item.name}</div>
        <div class="catalog-dim">${item.w} × ${item.d} × ${item.h} mm</div>
      `;
      card.addEventListener('click', () => {
        const offset = (state.furnitureList.length % 4) * 150 - 200;
        addFurnitureFromTemplate(item, { x: offset, z: offset, rotY: 0 });
        showToast(`'${item.name}' 가구가 공간 중앙에 배치되었습니다.`);
      });
      listEl.appendChild(card);
    });
  }

  function renderAIVaultUI() {
    const vaultEl = document.getElementById('ai-vault-list');
    if (state.aiVault.length === 0) {
      vaultEl.innerHTML = `<div class="empty-vault-msg">아직 생성된 AI 가구가 없습니다.<br/>[3. AI 가구 생성기] 탭에서 나만의 가구를 만들어보세요.</div>`;
      return;
    }

    vaultEl.innerHTML = '';
    state.aiVault.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'catalog-card';
      const thumbStyle = item.textureDataUrl
        ? `background-image:url('${item.textureDataUrl}'); background-size:cover;`
        : `background:${item.color};`;
      card.innerHTML = `
        <div class="catalog-card-top">
          <span class="catalog-swatch" style="${thumbStyle}"></span>
          <span class="catalog-tag" style="color:#A5B4FC;">AI Custom</span>
        </div>
        <div class="catalog-name">${item.name}</div>
        <div class="catalog-dim">${item.w} × ${item.d} × ${item.h} mm</div>
      `;
      card.addEventListener('click', () => {
        addFurnitureFromTemplate(item, { x: 0, z: 0, rotY: 0 });
        showToast(`AI 보관함에서 '${item.name}' 가구를 배치했습니다.`);
      });
      vaultEl.appendChild(card);
    });
  }

  function renderPlacedFurnitureListUI() {
    const countEl = document.getElementById('placed-count');
    const listEl = document.getElementById('placed-furniture-list');
    countEl.textContent = state.furnitureList.length;
    listEl.innerHTML = '';

    state.furnitureList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'placed-item-row' + (item.isColliding ? ' colliding' : '');
      row.innerHTML = `
        <span>${item.name}</span>
        <span class="mono-val">${item.isColliding ? '충돌 경고' : `${item.w}×${item.d}`}</span>
      `;
      row.addEventListener('click', () => selectFurniture(item.id));
      listEl.appendChild(row);
    });
  }

  function updateInspectorUI() {
    const emptyState = document.getElementById('inspector-empty-state');
    const furnState = document.getElementById('inspector-furniture-state');
    const badge = document.getElementById('inspector-target-badge');

    const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
    if (!item) {
      emptyState.classList.remove('hidden');
      furnState.classList.add('hidden');
      badge.textContent = '공간 설정';
      renderPlacedFurnitureListUI();
      return;
    }

    emptyState.classList.add('hidden');
    furnState.classList.remove('hidden');
    badge.textContent = item.isAI ? 'AI 커스텀 가구' : '선택된 가구';

    document.getElementById('prop-item-category').textContent = `${item.category.toUpperCase()} · ${item.shape}`;
    document.getElementById('prop-item-name').textContent = item.name;

    syncInspectorPositionFields(item);

    const rotDeg = ((Math.round(item.rotY) % 360) + 360) % 360;
    document.getElementById('prop-rot-slider').value = rotDeg;
    document.getElementById('prop-rot-value').textContent = `${rotDeg}°`;

    document.getElementById('prop-dim-w').value = item.w;
    document.getElementById('prop-dim-d').value = item.d;
    document.getElementById('prop-dim-h').value = item.h;

    document.getElementById('prop-color-picker').value = item.color || '#6B7280';
    document.getElementById('prop-color-hex').textContent = (item.color || '#6B7280').toUpperCase();
    document.getElementById('prop-ergo-toggle').checked = item.ergoVisible !== false;

    updateSelectedCollisionUI();
  }

  function syncInspectorPositionFields(item) {
    if (state.selectedFurnitureId !== item.id) return;
    document.getElementById('prop-pos-x').value = Math.round(item.x);
    document.getElementById('prop-pos-y').value = Math.round(item.y || 0);
    document.getElementById('prop-pos-z').value = Math.round(item.z);
  }

  function updateSelectedCollisionUI() {
    const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
    if (!item) return;

    const tag = document.getElementById('prop-collision-badge');
    const alertBox = document.getElementById('prop-collision-detail');
    const reasonEl = document.getElementById('prop-collision-reason');

    if (item.isColliding) {
      tag.textContent = '충돌 감지됨';
      tag.className = 'collision-tag danger';
      alertBox.classList.remove('hidden');
      reasonEl.textContent = item.collisionReason || '벽체 또는 다른 가구와 충돌 중입니다.';
    } else {
      tag.textContent = '정상 배치';
      tag.className = 'collision-tag safe';
      alertBox.classList.add('hidden');
    }
  }

  function rotateSelectedFurnitureBy(deltaDeg) {
    const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
    if (!item) return;
    item.rotY = (((item.rotY + deltaDeg) % 360) + 360) % 360;
    const mesh = furnitureMeshMap.get(item.id);
    if (mesh) {
      mesh.rotation.y = THREE.MathUtils.degToRad(item.rotY);
    }
    evaluateAllCollisions();
    updateInspectorUI();
    draw2DFloorplan();
  }

  function switchViewportMode(mode) {
    state.mode = mode;
    document.getElementById('btn-mode-2d').classList.toggle('active', mode === '2d');
    document.getElementById('btn-mode-3d').classList.toggle('active', mode === '3d');
    document.getElementById('viewport-2d').classList.toggle('active', mode === '2d');
    document.getElementById('viewport-3d').classList.toggle('active', mode === '3d');

    if (mode === '3d') {
      rebuild3DRoomGeometry();
      evaluateAllCollisions();
    } else {
      onWindowResize();
      draw2DFloorplan();
    }
  }

  function updatePresetCardUI() {
    document.querySelectorAll('.preset-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.activePreset);
    });
  }

  function bindUIEvents() {
    // Mode Switch Buttons
    document.getElementById('btn-mode-2d').addEventListener('click', () => switchViewportMode('2d'));
    document.getElementById('btn-mode-3d').addEventListener('click', () => switchViewportMode('3d'));
    document.getElementById('btn-open-2d-editor').addEventListener('click', () => switchViewportMode('2d'));
    document.getElementById('btn-2d-to-3d-extrude').addEventListener('click', () => {
      switchViewportMode('3d');
      showToast('2D 단면도를 3D 벽체 및 공간 메쉬로 입체 변환(Extrusion)했습니다.');
    });

    // Left Sidebar Tabs
    document.querySelectorAll('.sidebar-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        tabBtn.classList.add('active');
        document.getElementById(tabBtn.dataset.tab).classList.add('active');
      });
    });

    // Preset Cards
    document.querySelectorAll('.preset-card').forEach((card) => {
      card.addEventListener('click', () => {
        loadFloorplanPreset(card.dataset.preset, false);
        showToast(`'${state.roomName}' 프리셋 구조가 적용되었습니다.`);
      });
    });

    // Custom Room Dimensions Apply
    document.getElementById('btn-apply-room-dim').addEventListener('click', () => {
      const W = Math.max(1500, Number(document.getElementById('room-width-input').value) || 3500);
      const D = Math.max(1500, Number(document.getElementById('room-depth-input').value) || 4500);
      const H = Math.max(2000, Number(document.getElementById('room-height-input').value) || 2400);
      const T = Math.max(80, Number(document.getElementById('wall-thickness-input').value) || 160);

      state.ceilingHeight = H;
      state.wallThickness = T;
      state.activePreset = 'custom';
      state.roomName = `사용자 정의 공간 (${W} × ${D} × H${H} mm)`;
      document.getElementById('hud-room-text').textContent = state.roomName;

      buildRectangularRoomWalls(W, D, T, H);
      state.openings = [
        { id: 'open_custom_door', wallId: 'wall_bottom', type: 'door', t: 0.28, width: 900, height: 2100, sill: 0, swingDir: 1 },
        { id: 'open_custom_win',  wallId: 'wall_top',    type: 'window', t: 0.5, width: 1500, height: 1200, sill: 850 }
      ];
      updatePresetCardUI();
      rebuild3DRoomGeometry();
      evaluateAllCollisions();
      draw2DFloorplan();
      showToast(`방 치수(${W}×${D}×${H}mm)가 2D/3D 공간에 반영되었습니다.`);
    });

    // 2D Drawing Tool Selection (Left Sidebar & 2D Floating Toolbar synced)
    function setDrawTool(tool) {
      state.drawTool = tool;
      document.querySelectorAll('.draw-tool-btn, .hud-tool-chip').forEach((b) => {
        b.classList.toggle('active', b.dataset.tool === tool);
      });
      if (state.mode !== '2d') {
        switchViewportMode('2d');
      }
    }

    document.querySelectorAll('.draw-tool-btn, .hud-tool-chip').forEach((btn) => {
      btn.addEventListener('click', () => setDrawTool(btn.dataset.tool));
    });

    document.getElementById('btn-clear-2d-walls').addEventListener('click', () => {
      state.walls = [];
      state.openings = [];
      rebuild3DRoomGeometry();
      draw2DFloorplan();
      showToast('모든 벽체와 문/창문이 초기화되었습니다. 2D 캔버스에서 새로 그려보세요.');
    });

    // Header Utilities
    document.getElementById('chk-auto-cutaway').addEventListener('change', (e) => {
      state.autoCutaway = e.target.checked;
    });

    document.getElementById('btn-reset-camera').addEventListener('click', () => {
      resetCameraView();
      showToast('카메라 시점이 초기화되었습니다.');
    });

    // Save & Load State via localStorage
    document.getElementById('btn-save-state').addEventListener('click', () => {
      const payload = {
        roomName: state.roomName,
        ceilingHeight: state.ceilingHeight,
        wallThickness: state.wallThickness,
        floorPolygon: state.floorPolygon,
        walls: state.walls,
        openings: state.openings,
        furnitureList: state.furnitureList,
        aiVault: state.aiVault
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      showToast('현재 인테리어 도면 및 가구 배치가 브라우저(localStorage)에 저장되었습니다.');
    });

    document.getElementById('btn-load-state').addEventListener('click', () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        showToast('저장된 인테리어 데이터가 없습니다.');
        return;
      }
      try {
        const data = JSON.parse(raw);
        state.roomName = data.roomName || state.roomName;
        state.ceilingHeight = data.ceilingHeight || 2400;
        state.wallThickness = data.wallThickness || 160;
        state.floorPolygon = data.floorPolygon || [];
        state.walls = data.walls || [];
        state.openings = data.openings || [];
        state.aiVault = data.aiVault || [];

        clearThreeGroup(furnitureGroup);
        furnitureMeshMap.clear();
        state.furnitureList = [];

        (data.furnitureList || []).forEach((item) => {
          state.furnitureList.push(item);
          const meshGroup = createProceduralFurnitureGroup(item);
          furnitureGroup.add(meshGroup);
          furnitureMeshMap.set(item.id, meshGroup);
        });

        document.getElementById('hud-room-text').textContent = state.roomName;
        renderAIVaultUI();
        rebuild3DRoomGeometry();
        selectFurniture(null);
        evaluateAllCollisions();
        draw2DFloorplan();
        showToast('저장된 인테리어 구성을 성공적으로 불러왔습니다.');
      } catch (err) {
        console.error(err);
        showToast('저장 데이터 불러오기에 실패했습니다.');
      }
    });

    // Global Ergo & Snap Checkboxes
    document.getElementById('chk-global-ergo').addEventListener('change', (e) => {
      state.globalErgoVisible = e.target.checked;
      roomGroup.traverse((obj) => {
        if (obj.name === 'ErgoDoorSwing') obj.visible = state.globalErgoVisible;
      });
      state.furnitureList.forEach((f) => updateFurnitureVisualStatus(f));
      draw2DFloorplan();
    });

    document.getElementById('chk-snap-grid').addEventListener('change', (e) => {
      state.snapToGrid = e.target.checked;
    });

    // Right Inspector Controls
    ['prop-pos-x', 'prop-pos-y', 'prop-pos-z'].forEach((inputId) => {
      document.getElementById(inputId).addEventListener('input', () => {
        const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
        if (!item) return;
        item.x = Number(document.getElementById('prop-pos-x').value) || 0;
        item.y = Math.max(0, Number(document.getElementById('prop-pos-y').value) || 0);
        item.z = Number(document.getElementById('prop-pos-z').value) || 0;

        const mesh = furnitureMeshMap.get(item.id);
        if (mesh) {
          mesh.position.set(item.x * MM_TO_UNIT, item.y * MM_TO_UNIT, item.z * MM_TO_UNIT);
        }
        evaluateAllCollisions();
        draw2DFloorplan();
      });
    });

    document.getElementById('prop-rot-slider').addEventListener('input', (e) => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      item.rotY = Number(e.target.value);
      document.getElementById('prop-rot-value').textContent = `${item.rotY}°`;
      const mesh = furnitureMeshMap.get(item.id);
      if (mesh) {
        mesh.rotation.y = THREE.MathUtils.degToRad(item.rotY);
      }
      evaluateAllCollisions();
      draw2DFloorplan();
    });

    document.querySelectorAll('.rot-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        rotateSelectedFurnitureBy(Number(btn.dataset.rotDelta));
      });
    });

    document.querySelectorAll('.rot-set-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
        if (!item) return;
        item.rotY = Number(btn.dataset.rotSet);
        const mesh = furnitureMeshMap.get(item.id);
        if (mesh) mesh.rotation.y = THREE.MathUtils.degToRad(item.rotY);
        evaluateAllCollisions();
        updateInspectorUI();
        draw2DFloorplan();
      });
    });

    document.getElementById('btn-apply-prop-dim').addEventListener('click', () => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      item.w = Math.max(150, Number(document.getElementById('prop-dim-w').value) || item.w);
      item.d = Math.max(150, Number(document.getElementById('prop-dim-d').value) || item.d);
      item.h = Math.max(150, Number(document.getElementById('prop-dim-h').value) || item.h);
      rebuildSingleFurnitureMesh(item);
      evaluateAllCollisions();
      draw2DFloorplan();
      showToast(`'${item.name}' 치수가 ${item.w}×${item.d}×${item.h}mm로 변경되었습니다.`);
    });

    document.getElementById('prop-color-picker').addEventListener('input', (e) => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      item.color = e.target.value;
      document.getElementById('prop-color-hex').textContent = item.color.toUpperCase();
      const mesh = furnitureMeshMap.get(item.id);
      if (mesh && mesh.userData.primaryMaterial) {
        mesh.userData.primaryMaterial.map = null;
        mesh.userData.primaryMaterial.color.set(item.color);
        mesh.userData.primaryMaterial.needsUpdate = true;
      }
      draw2DFloorplan();
    });

    document.getElementById('prop-ergo-toggle').addEventListener('change', (e) => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      item.ergoVisible = e.target.checked;
      updateFurnitureVisualStatus(item);
      draw2DFloorplan();
    });

    document.getElementById('btn-duplicate-item').addEventListener('click', () => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      addFurnitureFromTemplate(item, {
        x: item.x + 250,
        y: item.y,
        z: item.z + 250,
        rotY: item.rotY
      });
      showToast(`'${item.name}' 가구가 복제되었습니다.`);
    });

    document.getElementById('btn-deselect-item').addEventListener('click', () => selectFurniture(null));
    document.getElementById('btn-delete-item').addEventListener('click', deleteSelectedFurniture);

    // AI Studio Dropzone & Controls
    const dropzone = document.getElementById('ai-dropzone');
    const fileInput = document.getElementById('ai-image-input');

    dropzone.addEventListener('click', (e) => {
      if (e.target.id === 'btn-remove-ai-img') return;
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleAIImageUpload(e.target.files[0]);
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleAIImageUpload(e.dataTransfer.files[0]);
      }
    });

    document.getElementById('btn-remove-ai-img').addEventListener('click', (e) => {
      e.stopPropagation();
      state.aiUploadedImageDataUrl = null;
      fileInput.value = '';
      document.getElementById('ai-dropzone-prompt').classList.remove('hidden');
      document.getElementById('ai-preview-wrap').classList.add('hidden');
    });

    document.getElementById('ai-fallback-color').addEventListener('input', (e) => {
      document.getElementById('ai-fallback-color-label').textContent = e.target.value.toUpperCase();
    });

    document.getElementById('btn-generate-ai-furniture').addEventListener('click', triggerAIFurnitureGeneration);
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('toast-notification');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3200);
  }

  // ==================== RENDER LOOP ====================
  function animate() {
    requestAnimationFrame(animate);
    if (state.mode === '3d' && renderer && scene && camera) {
      controls.update();
      updateFrontWallCutaway();
      renderer.render(scene, camera);
    }
  }
})();
