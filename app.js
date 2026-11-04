/**
 * SpaceCraft 3D — AI Blueprint & 3D 공간 시뮬레이션 플랫폼
 * Scale: 1000mm = 1.0 unit (Three.js meter scale)
 *
 * All Bugs Fixed & Enhanced Version:
 * 1. Safe JSON extraction from LLM conversational text using robust regex pattern matching
 * 2. Accurate point-to-segment distance for 2D Wall Erase Tool (erases on click anywhere along wall)
 * 3. Complete floor polygon reset on 2D clear walls and dynamic boundary computation
 * 4. High-performance non-destructive color changes (direct material color update without geometry destruction)
 * 5. Full GLB 3D model preservation (cloning from memory for vault re-placement and smooth scale updates)
 * 6. Smooth 2D canvas Panning (Right-Click Drag or Middle-Click Drag) and pointer capture
 * 7. Persistent placed furniture list in inspector for instant one-click switching
 * 8. Safe door/window placement margin checks to prevent corrupted segmented wall geometry
 * 9. Escape key shortcut for deselection and drawing cancellation
 * 10. Robust Ollama API response compatibility (checks both data.response and data.message.content)
 */

(function () {
  'use strict';

  const MM_TO_UNIT = 0.001; // 1000mm = 1 unit
  const UNIT_TO_MM = 1000;
  const STORAGE_KEY_STATE = 'SPACECRAFT_3D_INTERIOR_STATE_V2';
  const STORAGE_KEY_AI_CONFIG = 'SPACECRAFT_3D_AI_CONFIG_V2';

  // ==================== APPLICATION STATE ====================
  const state = {
    mode: '3d', // '2d' | '3d'
    deviceMode: 'pc', // 'pc' | 'mobile'
    activePreset: 'studio',
    roomName: '① 원룸 오픈형 (3500 × 4500 mm)',
    ceilingHeight: 2400, // mm
    wallThickness: 160,  // mm
    autoCutaway: true,
    globalErgoVisible: true,
    snapToGrid: true,

    // 2D Floorplan Data (in mm, centered around 0,0)
    floorPolygon: [],
    walls: [],
    openings: [],

    // Furniture Instances
    furnitureList: [],
    selectedFurnitureId: null,

    // Saved AI Custom Furniture & GLB Catalog Vault
    aiVault: [],

    // Memory Store for Loaded GLB Models (id -> THREE.Group or Scene)
    glbModelCache: new Map(),

    // AI Engine Configuration
    aiConfig: {
      provider: 'gemini', // 'gemini' | 'openai' | 'ollama' | 'smart_preset'
      geminiApiKey: '',
      openaiApiKey: '',
      ollamaUrl: 'http://localhost:11434/api/generate',
      ollamaModel: 'llama3.2-vision'
    },

    // AI Upload Temp State
    aiUploadedBase64: null,
    aiUploadedMimeType: 'image/jpeg',
    aiExtractedHex: '#C89D7C',

    // 2D Editor Interaction State
    drawTool: 'select', // 'select' | 'wall' | 'door' | 'window' | 'erase'
    isDrawingWall: false,
    drawStartPt: null,
    drawCurrentPt: null,
    dragging2DFurnitureId: null,
    drag2DOffset: { x: 0, z: 0 },

    // Selection & 2D Wall/Vertex Manipulation Extensions
    selectedWallId: null,
    hoveredWallId: null,
    hoveredVertex: null,
    drag2DMode: null, // 'pan' | 'wall' | 'vertex' | 'furniture' | null
    draggingWall: null,
    draggingVertex: null,
    hasDragged2D: false,
    orthoGuideLine: null,

    // 2D Canvas Panning & Zooming
    isPanning2D: false,
    panStart2D: { x: 0, y: 0 },
    pan2D: { x: 0, y: 0 },
    zoom2D: 0.11 // px per mm
  };

  // ==================== UNDO / REDO HISTORY SYSTEM ====================
  const HistoryManager = {
    undoStack: [],
    redoStack: [],
    maxSteps: 50,
    isApplying: false,

    takeSnapshot() {
      return {
        walls: JSON.parse(JSON.stringify(state.walls || [])),
        openings: JSON.parse(JSON.stringify(state.openings || [])),
        floorPolygon: JSON.parse(JSON.stringify(state.floorPolygon || [])),
        furnitureList: JSON.parse(JSON.stringify(state.furnitureList || [])),
        roomName: state.roomName,
        activePreset: state.activePreset,
        ceilingHeight: state.ceilingHeight,
        wallThickness: state.wallThickness
      };
    },

    pushState() {
      if (this.isApplying) return;
      const snap = this.takeSnapshot();

      // Avoid redundant identical snapshots
      if (this.undoStack.length > 0) {
        const last = this.undoStack[this.undoStack.length - 1];
        if (JSON.stringify(last) === JSON.stringify(snap)) {
          return;
        }
      }

      this.undoStack.push(snap);
      if (this.undoStack.length > this.maxSteps) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.updateButtonsUI();
    },

    applySnapshot(snap) {
      if (!snap) return;
      this.isApplying = true;

      state.walls = JSON.parse(JSON.stringify(snap.walls || []));
      state.openings = JSON.parse(JSON.stringify(snap.openings || []));
      state.floorPolygon = JSON.parse(JSON.stringify(snap.floorPolygon || []));
      state.furnitureList = JSON.parse(JSON.stringify(snap.furnitureList || []));
      if (snap.roomName) state.roomName = snap.roomName;
      if (snap.activePreset) state.activePreset = snap.activePreset;
      if (snap.ceilingHeight) state.ceilingHeight = snap.ceilingHeight;
      if (snap.wallThickness) state.wallThickness = snap.wallThickness;

      if (state.selectedFurnitureId && !state.furnitureList.some((f) => f.id === state.selectedFurnitureId)) {
        state.selectedFurnitureId = null;
      }
      if (state.selectedWallId && !state.walls.some((w) => w.id === state.selectedWallId)) {
        state.selectedWallId = null;
      }

      rebuild3DRoomGeometry();
      syncAllFurnitureMeshesFromState();
      evaluateAllCollisions();

      updateInspectorUI();
      draw2DFloorplan();

      this.isApplying = false;
      this.updateButtonsUI();
    },

    undo() {
      if (this.undoStack.length <= 1) {
        showToast('더 이상 되돌릴 이전 내역이 없습니다.');
        return;
      }
      const current = this.undoStack.pop();
      this.redoStack.push(current);

      const prev = this.undoStack[this.undoStack.length - 1];
      this.applySnapshot(prev);
      showToast('실행 취소(Undo)되었습니다.');
    },

    redo() {
      if (this.redoStack.length === 0) {
        showToast('복구할(Redo) 다음 내역이 없습니다.');
        return;
      }
      const next = this.redoStack.pop();
      this.undoStack.push(next);
      this.applySnapshot(next);
      showToast('다시 실행(Redo)되었습니다.');
    },

    updateButtonsUI() {
      const btnUndo = document.getElementById('btn-undo');
      const btnRedo = document.getElementById('btn-redo');
      const canUndo = this.undoStack.length > 1;
      const canRedo = this.redoStack.length > 0;
      if (btnUndo) {
        btnUndo.disabled = !canUndo;
        btnUndo.classList.toggle('disabled', !canUndo);
      }
      if (btnRedo) {
        btnRedo.disabled = !canRedo;
        btnRedo.classList.toggle('disabled', !canRedo);
      }
    }
  };

  function syncAllFurnitureMeshesFromState() {
    const activeIds = new Set(state.furnitureList.map((f) => f.id));

    // Remove obsolete meshes
    for (const [id, mesh] of furnitureMeshMap.entries()) {
      if (!activeIds.has(id)) {
        furnitureGroup.remove(mesh);
        furnitureMeshMap.delete(id);
      }
    }

    // Add or update meshes
    state.furnitureList.forEach((item) => {
      let meshGroup = furnitureMeshMap.get(item.id);
      if (!meshGroup) {
        if (item.isGLB) {
          const cachedScene = state.glbModelCache.get(item.catalogId) || state.glbModelCache.get(item.id);
          if (cachedScene) {
            meshGroup = buildGLBFurnitureGroup(cachedScene, item);
          } else {
            const bp = item.blueprintData || generateSmartBlueprint('modern_rect_desk', item.w, item.d, item.h, item.color, 'wood');
            meshGroup = buildFurnitureFromAIJson(bp, item);
          }
        } else {
          const bp = item.blueprintData || generateSmartBlueprint(item.shape, item.w, item.d, item.h, item.color, item.materialType);
          meshGroup = buildFurnitureFromAIJson(bp, item);
        }
        furnitureGroup.add(meshGroup);
        furnitureMeshMap.set(item.id, meshGroup);
      } else {
        meshGroup.position.set(item.x * MM_TO_UNIT, (item.y || 0) * MM_TO_UNIT, item.z * MM_TO_UNIT);
        meshGroup.rotation.y = THREE.MathUtils.degToRad(-item.rotY);
        updateFurnitureMaterialColor(item, item.color || '#4B5563');
      }
    });
  }

  function selectWall(id) {
    state.selectedWallId = id;
    if (id) {
      state.selectedFurnitureId = null;
      state.furnitureList.forEach((item) => updateFurnitureVisualStatus(item));
      if (state.deviceMode === 'mobile') {
        openMobileDrawer('right');
      }
    }
    updateInspectorUI();
    draw2DFloorplan();
  }

  function deleteSelectedWall() {
    if (!state.selectedWallId) return;
    const wallId = state.selectedWallId;
    const idx = state.walls.findIndex((w) => w.id === wallId);
    if (idx !== -1) {
      state.walls.splice(idx, 1);
      state.openings = state.openings.filter((o) => o.wallId !== wallId);
      state.selectedWallId = null;
      rebuild3DRoomGeometry();
      evaluateAllCollisions();
      updateInspectorUI();
      draw2DFloorplan();
      HistoryManager.pushState();
      showToast('선택한 벽체와 부착된 문/창문이 삭제되었습니다.');
    }
  }

  function applySelectedWallLength(newLenMM) {
    if (!state.selectedWallId) return;
    const wall = state.walls.find((w) => w.id === state.selectedWallId);
    if (!wall) return;
    newLenMM = Math.max(300, Math.min(25000, Number(newLenMM) || 1000));
    const curLen = Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1);
    if (curLen < 1) return;
    const ux = (wall.x2 - wall.x1) / curLen;
    const uz = (wall.z2 - wall.z1) / curLen;
    wall.x2 = Math.round(wall.x1 + ux * newLenMM);
    wall.z2 = Math.round(wall.z1 + uz * newLenMM);
    rebuild3DRoomGeometry();
    evaluateAllCollisions();
    updateInspectorUI();
    draw2DFloorplan();
    HistoryManager.pushState();
    showToast(`벽체 길이가 ${newLenMM}mm 로 변경되었습니다.`);
  }

  function getConnectedWallEndpoints(vx, vz, toleranceMM = 70) {
    const connections = [];
    state.walls.forEach((w) => {
      if (Math.hypot(w.x1 - vx, w.z1 - vz) <= toleranceMM) {
        connections.push({ wall: w, endpoint: 'start', origX: w.x1, origZ: w.z1 });
      }
      if (Math.hypot(w.x2 - vx, w.z2 - vz) <= toleranceMM) {
        connections.push({ wall: w, endpoint: 'end', origX: w.x2, origZ: w.z2 });
      }
    });
    return connections;
  }

  function findVertexNearCanvasPoint(px, py, hitRadiusPx = 14) {
    let best = null;
    let bestDist = hitRadiusPx;

    state.walls.forEach((wall) => {
      const p1 = mmToCanvas2D(wall.x1, wall.z1);
      const d1 = Math.hypot(px - p1.px, py - p1.py);
      if (d1 < bestDist) {
        bestDist = d1;
        best = {
          wallId: wall.id,
          endpoint: 'start',
          x: wall.x1,
          z: wall.z1,
          px: p1.px,
          py: p1.py
        };
      }

      const p2 = mmToCanvas2D(wall.x2, wall.z2);
      const d2 = Math.hypot(px - p2.px, py - p2.py);
      if (d2 < bestDist) {
        bestDist = d2;
        best = {
          wallId: wall.id,
          endpoint: 'end',
          x: wall.x2,
          z: wall.z2,
          px: p2.px,
          py: p2.py
        };
      }
    });

    return best;
  }

  function findWallNearPoint(ptMM, maxDistMM = 220) {
    let bestWall = null;
    let bestDist = maxDistMM;

    state.walls.forEach((wall) => {
      const d = distToSegment(ptMM.x, ptMM.z, wall.x1, wall.z1, wall.x2, wall.z2);
      if (d < bestDist) {
        bestDist = d;
        bestWall = wall;
      }
    });

    return bestWall;
  }

  // ==================== DEFAULT FURNITURE CATALOG ====================
  const DEFAULT_CATALOG = [
    {
      catalogId: 'bed_single',
      name: '모던 싱글 침대',
      category: 'bed',
      shape: 'bed_frame_headboard',
      w: 1050, d: 2080, h: 850,
      color: '#4B5563',
      materialType: 'fabric',
      tag: '침실',
      ergoClearance: { front: 500, side: 450 }
    },
    {
      catalogId: 'bed_queen',
      name: '호텔형 퀸 침대',
      category: 'bed',
      shape: 'bed_frame_headboard',
      w: 1580, d: 2120, h: 920,
      color: '#57534E',
      materialType: 'fabric',
      tag: '침실',
      ergoClearance: { front: 550, side: 500 }
    },
    {
      catalogId: 'desk_work',
      name: '데스크테리어 모션 데스크',
      category: 'desk',
      shape: 'modern_rect_desk',
      w: 1400, d: 700, h: 740,
      color: '#8D6E63',
      materialType: 'wood',
      tag: '서재/데스크',
      ergoClearance: { front: 750, side: 100 }
    },
    {
      catalogId: 'chair_office',
      name: '에르고 메쉬 오피스 체어',
      category: 'chair',
      shape: 'office_swivel_chair',
      w: 620, d: 620, h: 980,
      color: '#374151',
      materialType: 'metal',
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
      materialType: 'wood',
      tag: '수납',
      ergoClearance: { front: 650, side: 50 }
    },
    {
      catalogId: 'sofa_3seat',
      name: '노르딕 3인용 패브릭 소파',
      category: 'chair',
      shape: 'cushion_sofa_armchair',
      w: 2050, d: 880, h: 800,
      color: '#64748B',
      materialType: 'fabric',
      tag: '거실',
      ergoClearance: { front: 600, side: 200 }
    },
    {
      catalogId: 'bookshelf_5tier',
      name: '오픈형 5단 와이드 책장',
      category: 'wardrobe',
      shape: 'open_shelf_bookcase',
      w: 900, d: 340, h: 1850,
      color: '#785A46',
      materialType: 'wood',
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
      materialType: 'metal',
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

  // Material and Texture Caches
  const textureCache = new Map();

  // 2D Canvas Context
  let canvas2D, ctx2D;

  // ==================== DEVICE MODE (PC vs MOBILE) & DRAWER CONTROLS ====================
  function initDeviceMode() {
    let savedMode = null;
    try {
      savedMode = localStorage.getItem('SPACECRAFT_DEVICE_MODE');
    } catch (e) {}

    if (savedMode === 'pc' || savedMode === 'mobile') {
      setDeviceMode(savedMode, false);
    } else {
      const isSmallScreen = window.innerWidth <= 860;
      const isTouchDev = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
      setDeviceMode((isSmallScreen || (isTouchDev && window.innerWidth <= 1024)) ? 'mobile' : 'pc', false);
    }
  }

  function setDeviceMode(mode, save = true) {
    state.deviceMode = mode;
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      appContainer.classList.toggle('device-mode-mobile', mode === 'mobile');
      appContainer.classList.toggle('device-mode-pc', mode === 'pc');
    }

    const toggleBtn = document.getElementById('btn-toggle-device-mode');
    if (toggleBtn) {
      toggleBtn.classList.toggle('is-mobile', mode === 'mobile');
      toggleBtn.title = mode === 'mobile' ? '현재: 모바일 모드 (클릭하여 PC 모드로 전환)' : '현재: PC 모드 (클릭하여 모바일 모드로 전환)';
    }

    if (mode === 'pc') {
      closeMobileDrawers();
    }

    if (save) {
      try {
        localStorage.setItem('SPACECRAFT_DEVICE_MODE', mode);
      } catch (e) {}
    }

    onWindowResize();
    draw2DFloorplan();
  }

  function openMobileDrawer(drawerName) {
    const leftSidebar = document.getElementById('left-sidebar');
    const rightSidebar = document.getElementById('right-sidebar');
    const backdrop = document.getElementById('mobile-drawer-backdrop');

    if (drawerName === 'left') {
      if (leftSidebar) leftSidebar.classList.add('mobile-open');
      if (rightSidebar) rightSidebar.classList.remove('mobile-open');
      if (backdrop) backdrop.classList.remove('hidden');
    } else if (drawerName === 'right') {
      if (rightSidebar) rightSidebar.classList.add('mobile-open');
      if (leftSidebar) leftSidebar.classList.remove('mobile-open');
      if (backdrop) backdrop.classList.remove('hidden');
    }
  }

  function closeMobileDrawers() {
    const leftSidebar = document.getElementById('left-sidebar');
    const rightSidebar = document.getElementById('right-sidebar');
    const backdrop = document.getElementById('mobile-drawer-backdrop');

    if (leftSidebar) leftSidebar.classList.remove('mobile-open');
    if (rightSidebar) rightSidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.add('hidden');
  }

  // ==================== INITIALIZATION ====================
  window.addEventListener('DOMContentLoaded', () => {
    initDeviceMode();
    loadSavedAIConfig();
    initThreeScene();
    init2DCanvas();
    renderCatalogUI();
    renderAIVaultUI();
    bindUIEvents();

    // Load default preset (① 원룸 오픈형 3500x4500mm) with starter furniture
    loadFloorplanPreset('studio', true);

    // Initial clean baseline snapshot for HistoryManager
    HistoryManager.undoStack = [ HistoryManager.takeSnapshot() ];
    HistoryManager.redoStack = [];
    HistoryManager.updateButtonsUI();

    animate();
  });

  // ==================== AI CONFIG STORAGE ====================
  function loadSavedAIConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_AI_CONFIG);
      if (raw) {
        const saved = JSON.parse(raw);
        state.aiConfig = { ...state.aiConfig, ...saved };
      }
    } catch (e) {
      console.warn('Failed to load AI config from localStorage', e);
    }
    syncAIConfigUI();
  }

  function saveAIConfig() {
    try {
      localStorage.setItem(STORAGE_KEY_AI_CONFIG, JSON.stringify(state.aiConfig));
    } catch (e) {
      console.warn('Failed to save AI config to localStorage', e);
    }
  }

  function syncAIConfigUI() {
    const provSelect = document.getElementById('ai-provider-select');
    if (provSelect) provSelect.value = state.aiConfig.provider;

    const cloudKeyWrap = document.getElementById('ai-cloud-key-wrap');
    const ollamaWrap = document.getElementById('ai-ollama-config-wrap');
    const keyInput = document.getElementById('ai-api-key-input');
    const labelKey = document.getElementById('ai-key-provider-label');
    const statusPill = document.getElementById('ai-engine-status-pill');

    const provider = state.aiConfig.provider;

    if (provider === 'gemini') {
      cloudKeyWrap.classList.remove('hidden');
      ollamaWrap.classList.add('hidden');
      labelKey.textContent = 'Gemini';
      keyInput.placeholder = 'AIzaSy... (Google AI Studio Key)';
      keyInput.value = state.aiConfig.geminiApiKey || '';
      statusPill.textContent = 'Gemini 2.5 Flash';
    } else if (provider === 'openai') {
      cloudKeyWrap.classList.remove('hidden');
      ollamaWrap.classList.add('hidden');
      labelKey.textContent = 'OpenAI';
      keyInput.placeholder = 'sk-... (OpenAI API Key)';
      keyInput.value = state.aiConfig.openaiApiKey || '';
      statusPill.textContent = 'GPT-4o-mini';
    } else if (provider === 'ollama') {
      cloudKeyWrap.classList.add('hidden');
      ollamaWrap.classList.remove('hidden');
      document.getElementById('ai-ollama-url').value = state.aiConfig.ollamaUrl || 'http://localhost:11434/api/generate';
      document.getElementById('ai-ollama-model').value = state.aiConfig.ollamaModel || 'llama3.2-vision';
      statusPill.textContent = `Ollama: ${state.aiConfig.ollamaModel || 'vision'}`;
    } else {
      cloudKeyWrap.classList.add('hidden');
      ollamaWrap.classList.add('hidden');
      statusPill.textContent = '스마트 파라미터 프리셋';
    }
  }

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
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minDistance = 1.5;
    controls.maxDistance = 24;
    controls.target.set(0, 0.6, 0);
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    window.controls = controls;

    const gridHelper = new THREE.GridHelper(18, 36, 0x383B46, 0x2A2C32);
    gridHelper.position.y = -0.002;
    scene.add(gridHelper);

    const ambientLight = new THREE.AmbientLight(0xDCE3F2, 0.65);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xE2E8F0, 0x1E1F24, 0.4);
    hemiLight.position.set(0, 8, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xFFFBEB, 0.85);
    dirLight.position.set(6.0, 9.5, 7.0);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 28;
    const d = 7.5;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0004;
    scene.add(dirLight);

    roomGroup = new THREE.Group();
    furnitureGroup = new THREE.Group();
    helperGroup = new THREE.Group();
    scene.add(roomGroup);
    scene.add(furnitureGroup);
    scene.add(helperGroup);

    window.roomGroup = roomGroup;
    window.furnitureGroup = furnitureGroup;
    window.scene = scene;

    raycaster = new THREE.Raycaster();
    mouseNDC = new THREE.Vector2();
    dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

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

  // ==================== PROCEDURAL MATERIALS ====================
  function getProceduralTexture(type, baseHex) {
    const key = `${type}_${baseHex}`;
    if (textureCache.has(key)) return textureCache.get(key);

    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');

    if (type === 'wood') {
      c.width = 256;
      c.height = 256;
      ctx.fillStyle = baseHex;
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 1.6;
      for (let y = 4; y < 256; y += 8) {
        ctx.beginPath();
        for (let x = 0; x <= 256; x += 16) {
          const wave = Math.sin(x * 0.05 + y * 0.02) * 3 + Math.sin(x * 0.12) * 1.5;
          if (x === 0) ctx.moveTo(x, y + wave);
          else ctx.lineTo(x, y + wave);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1.0;
      for (let y = 8; y < 256; y += 16) {
        ctx.beginPath();
        for (let x = 0; x <= 256; x += 16) {
          const wave = Math.sin(x * 0.05 + y * 0.02) * 3;
          if (x === 0) ctx.moveTo(x, y + wave);
          else ctx.lineTo(x, y + wave);
        }
        ctx.stroke();
      }
    } else if (type === 'fabric') {
      c.width = 128;
      c.height = 128;
      ctx.fillStyle = baseHex;
      ctx.fillRect(0, 0, 128, 128);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.09)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 128; i += 4) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i, 128);
        ctx.moveTo(0, i); ctx.lineTo(128, i);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      for (let i = 2; i < 128; i += 4) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i, 128);
        ctx.stroke();
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1.5, 1.5);
    textureCache.set(key, tex);
    return tex;
  }

  function createProceduralMaterial(matType, hexColor) {
    const color = new THREE.Color(hexColor || '#8B6F4E');
    const type = matType || 'wood';

    if (type === 'metal') {
      return new THREE.MeshStandardMaterial({
        color,
        metalness: 0.88,
        roughness: 0.22
      });
    } else if (type === 'glass') {
      return new THREE.MeshPhysicalMaterial({
        color,
        metalness: 0.1,
        roughness: 0.08,
        transparent: true,
        opacity: 0.38,
        transmission: 0.6
      });
    } else if (type === 'fabric') {
      return new THREE.MeshStandardMaterial({
        map: getProceduralTexture('fabric', hexColor || '#64748B'),
        color,
        roughness: 0.86,
        metalness: 0.02
      });
    } else if (type === 'plastic') {
      return new THREE.MeshStandardMaterial({
        color,
        roughness: 0.38,
        metalness: 0.05
      });
    } else {
      return new THREE.MeshStandardMaterial({
        map: getProceduralTexture('wood', hexColor || '#8B6F4E'),
        color,
        roughness: 0.62,
        metalness: 0.05
      });
    }
  }

  // ==================== [기능 1] 건물 3D 시뮬레이션 ====================
  function loadFloorplanPreset(presetKey, includeSampleFurniture = false) {
    state.activePreset = presetKey;
    state.walls = [];
    state.openings = [];

    const t = state.wallThickness;
    const h = state.ceilingHeight;

    if (presetKey === 'studio') {
      const W = 3500, D = 4500;
      state.roomName = '① 원룸 오픈형 (3500 × 4500 mm)';
      setRoomDimensionInputs(W, D, h);
      buildRectangularRoomWalls(W, D, t, h);
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
      const W = 5200, D = 4200;
      state.roomName = '② 분리형 1.5룸 (5200 × 4200 mm)';
      setRoomDimensionInputs(W, D, h);
      buildRectangularRoomWalls(W, D, t, h);
      state.walls.push({
        id: 'wall_partition_1',
        x1: -200, z1: -D / 2,
        x2: -200, z2: 700,
        thickness: 140,
        height: h,
        isInterior: true
      });
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
    }

    if (includeSampleFurniture) {
      state.furnitureList = [];
      furnitureMeshMap.clear();
      clearThreeGroup(furnitureGroup);

      addFurnitureFromTemplate(DEFAULT_CATALOG[0], { x: -1100, z: -1050, rotY: 0 });
      addFurnitureFromTemplate(DEFAULT_CATALOG[2], { x: 950,   z: -1650, rotY: 0 });
      addFurnitureFromTemplate(DEFAULT_CATALOG[3], { x: 950,   z: -950,  rotY: 180 });
      addFurnitureFromTemplate(DEFAULT_CATALOG[4], { x: 1150,  z: 750,   rotY: -90 });
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

    // 1. Floor Mesh Extrusion
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

    // 2. Extrude Walls with Openings
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
        let cursorMM = -lenMM / 2;
        wallOpenings.forEach((op) => {
          const opCenterMM = (op.t - 0.5) * lenMM;
          const halfW = op.width / 2;
          const opStartMM = Math.max(-lenMM / 2 + 40, opCenterMM - halfW);
          const opEndMM = Math.min(lenMM / 2 - 40, opCenterMM + halfW);

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

          const topHeadU = heightU - (sillU + opHeightU);
          if (topHeadU > 0.02) {
            const headGeo = new THREE.BoxGeometry(opWidthU, topHeadU, thickU);
            headGeo.translate(opCenterU, sillU + opHeightU + topHeadU / 2, 0);
            const headMesh = new THREE.Mesh(headGeo, wallMat);
            headMesh.castShadow = true;
            wallContainer.add(headMesh);
          }

          if (sillU > 0.02) {
            const sillGeo = new THREE.BoxGeometry(opWidthU, sillU, thickU);
            sillGeo.translate(opCenterU, sillU / 2, 0);
            const sillMesh = new THREE.Mesh(sillGeo, wallMat);
            sillMesh.castShadow = true;
            wallContainer.add(sillMesh);
          }

          if (op.type === 'door') {
            build3DDoorFixture(wallContainer, opCenterU, opWidthU, opHeightU, thickU, op);
          } else if (op.type === 'window') {
            build3DWindowFixture(wallContainer, opCenterU, sillU, opWidthU, opHeightU, thickU);
          }

          cursorMM = opEndMM;
        });

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

      const baseGeo = new THREE.BoxGeometry(lenU, 0.06, thickU + 0.008);
      baseGeo.translate(0, 0.03, 0);
      const baseMesh = new THREE.Mesh(baseGeo, baseboardMat);
      wallContainer.add(baseMesh);

      roomGroup.add(wallContainer);
      wallMeshes.push(wallContainer);
    });
  }

  function build3DDoorFixture(wallContainer, centerU, widthU, heightU, thickU, op) {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4B5563, roughness: 0.5 });
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x8B6F4E,
      roughness: 0.65,
      transparent: true,
      opacity: 0.92
    });

    const frameThick = 0.04;
    const leftPost = new THREE.Mesh(new THREE.BoxGeometry(frameThick, heightU, thickU + 0.02), frameMat);
    leftPost.position.set(centerU - widthU / 2 + frameThick / 2, heightU / 2, 0);
    wallContainer.add(leftPost);

    const rightPost = new THREE.Mesh(new THREE.BoxGeometry(frameThick, heightU, thickU + 0.02), frameMat);
    rightPost.position.set(centerU + widthU / 2 - frameThick / 2, heightU / 2, 0);
    wallContainer.add(rightPost);

    const swingRadiusU = 0.9;
    const hingeX = centerU - widthU / 2 + frameThick;
    const doorPivot = new THREE.Group();
    doorPivot.position.set(hingeX, 0, 0);

    const inwardSign = (op.swingDir || 1);
    doorPivot.rotation.y = inwardSign * (Math.PI * 0.38);

    const leafW = widthU - frameThick * 2;
    const leafGeo = new THREE.BoxGeometry(leafW, heightU - 0.03, 0.04);
    leafGeo.translate(leafW / 2, (heightU - 0.03) / 2, 0);
    const leafMesh = new THREE.Mesh(leafGeo, panelMat);
    leafMesh.castShadow = true;
    doorPivot.add(leafMesh);

    wallContainer.add(doorPivot);

    const sectorGeo = new THREE.CircleGeometry(swingRadiusU, 28, 0, Math.PI / 2);
    sectorGeo.rotateX(-Math.PI / 2);
    if (inwardSign < 0) sectorGeo.scale(1, 1, -1);

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

    ctx.strokeStyle = '#1E1C1B';
    ctx.lineWidth = 2;
    for (let y = 0; y < 256; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(256, y);
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

  // ==================== [기능 2 & 3] 3D 가구 조립 렌더러 (buildFurnitureFromAIJson) ====================
  function buildFurnitureFromAIJson(blueprint, itemData) {
    const group = new THREE.Group();
    group.name = 'Furniture_' + itemData.id;
    group.userData = { furnitureId: itemData.id, itemData };

    const visualMeshes = new THREE.Group();
    visualMeshes.name = 'VisualMeshes';

    const parts = Array.isArray(blueprint?.parts) ? blueprint.parts : [];

    parts.forEach((p) => {
      const shape = (p.shape || 'box').toLowerCase();
      const size = p.size || [100, 100, 100];
      const pos = p.position || [0, 0, 0];
      const rot = p.rotation || [0, 0, 0];
      const partColor = p.color || itemData.color || '#8B6F4E';
      const partMatType = p.materialType || itemData.materialType || 'wood';

      const mat = createProceduralMaterial(partMatType, partColor);
      let geo = null;

      if (shape === 'cylinder') {
        const rTop = Math.max(0.005, (size[0] || 50) * MM_TO_UNIT);
        const rBot = Math.max(0.005, (size[1] !== undefined ? size[1] : size[0]) * MM_TO_UNIT);
        const h = Math.max(0.01, (size[2] || 100) * MM_TO_UNIT);
        geo = new THREE.CylinderGeometry(rTop, rBot, h, 24);
      } else if (shape === 'sphere') {
        const r = Math.max(0.01, (size[0] || 50) * MM_TO_UNIT);
        geo = new THREE.SphereGeometry(r, 20, 16);
      } else {
        const w = Math.max(0.01, (size[0] || 100) * MM_TO_UNIT);
        const h = Math.max(0.01, (size[1] || 100) * MM_TO_UNIT);
        const d = Math.max(0.01, (size[2] || 100) * MM_TO_UNIT);
        geo = new THREE.BoxGeometry(w, h, d);
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = p.name || 'Part';
      mesh.position.set(pos[0] * MM_TO_UNIT, pos[1] * MM_TO_UNIT, pos[2] * MM_TO_UNIT);
      mesh.rotation.set(
        THREE.MathUtils.degToRad(rot[0] || 0),
        THREE.MathUtils.degToRad(rot[1] || 0),
        THREE.MathUtils.degToRad(rot[2] || 0)
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      visualMeshes.add(mesh);
    });

    group.add(visualMeshes);

    const W = itemData.w * MM_TO_UNIT;
    const D = itemData.d * MM_TO_UNIT;
    const H = itemData.h * MM_TO_UNIT;

    const boundGeo = new THREE.BoxGeometry(W + 0.02, H + 0.02, D + 0.02);
    boundGeo.translate(0, H / 2, 0);

    const outlineMat = new THREE.LineBasicMaterial({
      color: 0x4F46E5,
      linewidth: 2,
      transparent: true,
      opacity: 0.0
    });
    const outlineBox = new THREE.LineSegments(new THREE.EdgesGeometry(boundGeo), outlineMat);
    outlineBox.name = 'SelectionOutline';
    group.add(outlineBox);

    const tintMat = new THREE.MeshBasicMaterial({
      color: 0xEF4444,
      transparent: true,
      opacity: 0.0,
      depthWrite: false
    });
    const tintBox = new THREE.Mesh(boundGeo, tintMat);
    tintBox.name = 'CollisionShell';
    group.add(tintBox);

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

    const ergoLine = new THREE.LineSegments(
      new THREE.EdgesGeometry(ergoGeo),
      new THREE.LineBasicMaterial({ color: 0x34D399, transparent: true, opacity: 0.45 })
    );
    ergoLine.name = 'ErgoZoneLine';
    ergoLine.visible = ergoPlane.visible;
    group.add(ergoLine);

    group.position.set(
      itemData.x * MM_TO_UNIT,
      (itemData.y || 0) * MM_TO_UNIT,
      itemData.z * MM_TO_UNIT
    );
    group.rotation.y = THREE.MathUtils.degToRad(itemData.rotY || 0);

    return group;
  }

  // ==================== [기능 3-1] 스마트 파라미터 프리셋 블루프린트 생성기 ====================
  function generateSmartBlueprint(shapeKey, W, D, H, color, matType) {
    const parts = [];
    const mainColor = color || '#8B6F4E';
    const subColor = '#2B2D35';
    const primaryMat = matType || 'wood';

    if (shapeKey === 'round_slanted_table') {
      const topThick = Math.min(38, H * 0.08);
      const radius = Math.min(W, D) / 2;
      const legLen = H - topThick;
      const legTopR = Math.max(16, radius * 0.07);
      const legBotR = Math.max(11, radius * 0.045);
      const tiltDeg = 11.5;

      parts.push({
        name: 'tabletop_round',
        shape: 'cylinder',
        size: [radius, radius, topThick],
        position: [0, H - topThick / 2, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: primaryMat
      });

      const legSpread = radius * 0.65;
      const legAngles = [45, 135, 225, 315];
      legAngles.forEach((deg, idx) => {
        const rad = THREE.MathUtils.degToRad(deg);
        const px = Math.cos(rad) * legSpread;
        const pz = Math.sin(rad) * legSpread;
        const rx = -Math.sin(rad) * tiltDeg;
        const rz = Math.cos(rad) * tiltDeg;

        parts.push({
          name: `slanted_leg_${idx + 1}`,
          shape: 'cylinder',
          size: [legTopR, legBotR, legLen],
          position: [px, legLen / 2, pz],
          rotation: [rx, deg, rz],
          color: mainColor,
          materialType: 'wood'
        });
      });

      parts.push({
        name: 'under_brace_ring',
        shape: 'cylinder',
        size: [radius * 0.72, radius * 0.72, 16],
        position: [0, H - topThick - 8, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'lower_foot_ring',
        shape: 'cylinder',
        size: [radius * 0.55, radius * 0.55, 12],
        position: [0, legLen * 0.3, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
    } else if (shapeKey === 'modern_rect_desk') {
      const topThick = 40;
      const legH = H - topThick;
      const legThick = 38;

      parts.push({
        name: 'desktop_surface',
        shape: 'box',
        size: [W, topThick, D],
        position: [0, H - topThick / 2, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: primaryMat
      });

      const lx = -W / 2 + 50;
      parts.push({
        name: 'leg_loop_left_front',
        shape: 'box',
        size: [legThick, legH, legThick],
        position: [lx, legH / 2, D / 2 - 40],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'leg_loop_left_back',
        shape: 'box',
        size: [legThick, legH, legThick],
        position: [lx, legH / 2, -D / 2 + 40],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'leg_loop_left_bottom',
        shape: 'box',
        size: [legThick, legThick, D - 40],
        position: [lx, legThick / 2, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });

      const rx = W / 2 - 50;
      parts.push({
        name: 'leg_loop_right_front',
        shape: 'box',
        size: [legThick, legH, legThick],
        position: [rx, legH / 2, D / 2 - 40],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'leg_loop_right_back',
        shape: 'box',
        size: [legThick, legH, legThick],
        position: [rx, legH / 2, -D / 2 + 40],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'leg_loop_right_bottom',
        shape: 'box',
        size: [legThick, legThick, D - 40],
        position: [rx, legThick / 2, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });

      parts.push({
        name: 'cable_crossbar',
        shape: 'box',
        size: [W - 140, 60, 20],
        position: [0, legH * 0.75, -D * 0.35],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
    } else if (shapeKey === 'cushion_sofa_armchair') {
      const legH = Math.max(90, H * 0.16);
      const baseH = Math.max(120, H * 0.22);
      const armW = Math.min(140, W * 0.14);
      const seatW = W - armW * 2;
      const backH = H - legH - baseH;

      const legPositions = [
        [-W / 2 + 60, -D / 2 + 60],
        [W / 2 - 60,  -D / 2 + 60],
        [W / 2 - 60,  D / 2 - 60],
        [-W / 2 + 60, D / 2 - 60]
      ];
      legPositions.forEach(([lx, lz], idx) => {
        parts.push({
          name: `sofa_leg_${idx + 1}`,
          shape: 'cylinder',
          size: [24, 16, legH],
          position: [lx, legH / 2, lz],
          rotation: [0, 0, 0],
          color: subColor,
          materialType: 'metal'
        });
      });

      parts.push({
        name: 'seat_chassis',
        shape: 'box',
        size: [seatW, baseH, D * 0.88],
        position: [0, legH + baseH / 2, 20],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });

      parts.push({
        name: 'seat_cushion_top',
        shape: 'box',
        size: [seatW - 20, 90, D * 0.82],
        position: [0, legH + baseH + 45, 20],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });

      parts.push({
        name: 'backrest_cushion',
        shape: 'box',
        size: [seatW, backH, 180],
        position: [0, legH + baseH + backH / 2, -D / 2 + 90],
        rotation: [-7, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });

      parts.push({
        name: 'armrest_left',
        shape: 'box',
        size: [armW, (H - legH) * 0.72, D],
        position: [-W / 2 + armW / 2, legH + (H - legH) * 0.36, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });
      parts.push({
        name: 'armrest_right',
        shape: 'box',
        size: [armW, (H - legH) * 0.72, D],
        position: [W / 2 - armW / 2, legH + (H - legH) * 0.36, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });
    } else if (shapeKey === 'open_shelf_bookcase') {
      const sideT = 30;
      const shelfT = 24;
      parts.push({
        name: 'upright_left',
        shape: 'box',
        size: [sideT, H, D],
        position: [-W / 2 + sideT / 2, H / 2, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'upright_right',
        shape: 'box',
        size: [sideT, H, D],
        position: [W / 2 - sideT / 2, H / 2, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      const shelfW = W - sideT * 2;
      for (let i = 0; i < 5; i++) {
        const sy = 60 + i * ((H - 120) / 4);
        parts.push({
          name: `shelf_tier_${i + 1}`,
          shape: 'box',
          size: [shelfW, shelfT, D - 10],
          position: [0, sy, 0],
          rotation: [0, 0, 0],
          color: mainColor,
          materialType: 'wood'
        });
      }
      parts.push({
        name: 'rear_x_brace_1',
        shape: 'cylinder',
        size: [6, 6, Math.hypot(shelfW, H * 0.6)],
        position: [0, H * 0.5, -D / 2 + 8],
        rotation: [0, 0, 36],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'rear_x_brace_2',
        shape: 'cylinder',
        size: [6, 6, Math.hypot(shelfW, H * 0.6)],
        position: [0, H * 0.5, -D / 2 + 8],
        rotation: [0, 0, -36],
        color: subColor,
        materialType: 'metal'
      });
    } else if (shapeKey === 'office_swivel_chair') {
      const seatY = H * 0.46;
      parts.push({
        name: 'chair_caster_base',
        shape: 'cylinder',
        size: [W * 0.42, W * 0.46, 36],
        position: [0, 24, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'gas_lift_piston',
        shape: 'cylinder',
        size: [28, 28, seatY - 24],
        position: [0, seatY / 2, 0],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'metal'
      });
      parts.push({
        name: 'chair_seat_cushion',
        shape: 'box',
        size: [W * 0.82, 65, D * 0.78],
        position: [0, seatY, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });
      parts.push({
        name: 'chair_backrest_mesh',
        shape: 'box',
        size: [W * 0.74, H - seatY - 40, 50],
        position: [0, seatY + (H - seatY) / 2, -D * 0.35],
        rotation: [-4, 0, 0],
        color: mainColor,
        materialType: 'fabric'
      });
      parts.push({
        name: 'armrest_left_t',
        shape: 'box',
        size: [45, 180, D * 0.45],
        position: [-W * 0.42, seatY + 110, -10],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'plastic'
      });
      parts.push({
        name: 'armrest_right_t',
        shape: 'box',
        size: [45, 180, D * 0.45],
        position: [W * 0.42, seatY + 110, -10],
        rotation: [0, 0, 0],
        color: subColor,
        materialType: 'plastic'
      });
    } else {
      const baseH = H * 0.3;
      parts.push({
        name: 'primary_frame',
        shape: 'box',
        size: [W, baseH, D],
        position: [0, baseH / 2, 0],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: primaryMat
      });
      parts.push({
        name: 'headboard',
        shape: 'box',
        size: [W, H - baseH, 70],
        position: [0, baseH + (H - baseH) / 2, -D / 2 + 35],
        rotation: [0, 0, 0],
        color: mainColor,
        materialType: primaryMat
      });
    }

    return { parts };
  }

  // ==================== [기능 2-1] AI MULTIMODAL API CALLERS ====================
  async function callAIBlueprintAPI(imageBase64, mimeType, name, W, D, H, shapeKey, userPrompt) {
    const provider = state.aiConfig.provider;

    const systemInstruction = `너는 3D 공간 그래픽스 엔지니어다. 사용자가 업로드한 가구 이미지와 전체 규격(가로 W, 세로 D, 높이 H mm)을 분석하여, Three.js에서 이 가구를 가장 사실적이고 입체적으로 조립할 수 있도록 하위 부품(Parts)들의 배열로 분해한 순수 JSON 데이터를 반환해라. 절대 이미지를 평면에 텍스처로 붙이지 말고, 상판(원기둥/직육면체), 다리(개수, 기울기 각도, 원뿔대/원기둥 여부), 등받이, 팔걸이, 서랍, 프레임 등 최소 4개~12개의 세부 파츠로 쪼개어 설계해라.
각 파츠(parts 배열)는 다음 속성을 가진다:
- name: 부위 이름 (예: tabletop, leg_1, leg_2, backrest, armrest_l)
- shape: 'box' | 'cylinder' | 'sphere' | 'rounded_box'
- size: [width, height, depth] (단위: mm, 'cylinder'일 경우 [radiusTop, radiusBottom, height])
- position: [x, y, z] (가구 중심 바닥 기준 상대 좌표, 단위: mm)
- rotation: [rx, ry, rz] (단위: 도, 비스듬히 뻗은 다리 등을 표현할 때 적극 활용)
- color: 이미지의 해당 부위에서 추출한 실제 Hex 색상 코드 (예: '#C89D7C')
- materialType: 'wood' | 'metal' | 'fabric' | 'glass' | 'plastic'
오직 파싱 가능한 순수 JSON 객체 { "parts": [...] } 만 응답해라.`;

    const userTextPrompt = `가구 이름: ${name}
규격: 가로(W) ${W}mm x 깊이(D) ${D}mm x 높이(H) ${H}mm
기본 형태 스타일: ${shapeKey}
사용자 추가 지시사항: ${userPrompt || '이미지의 형태적 특성과 비율, 다리의 기울기 각도를 최대한 반영해 입체적으로 분해해 줘.'}`;

    if (provider === 'gemini') {
      const apiKey = state.aiConfig.geminiApiKey?.trim();
      if (!apiKey) throw new Error('Gemini API 키가 입력되지 않았습니다. [키 저장] 후 다시 시도하세요.');

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: systemInstruction + '\n\n' + userTextPrompt },
              ...(imageBase64 ? [{
                inline_data: {
                  mime_type: mimeType || 'image/jpeg',
                  data: imageBase64
                }
              }] : [])
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${errText}`);
      }
      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return extractJsonFromAiResponse(rawText);
    } else if (provider === 'openai') {
      const apiKey = state.aiConfig.openaiApiKey?.trim();
      if (!apiKey) throw new Error('OpenAI API 키가 입력되지 않았습니다. [키 저장] 후 다시 시도하세요.');

      const endpoint = 'https://api.openai.com/v1/chat/completions';
      const contentParts = [
        { type: 'text', text: userTextPrompt }
      ];
      if (imageBase64) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` }
        });
      }

      const payload = {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: contentParts }
        ],
        response_format: { type: 'json_object' }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API Error (${res.status}): ${errText}`);
      }
      const data = await res.json();
      const rawText = data?.choices?.[0]?.message?.content;
      return extractJsonFromAiResponse(rawText);
    } else if (provider === 'ollama') {
      const url = state.aiConfig.ollamaUrl || 'http://localhost:11434/api/generate';
      const model = state.aiConfig.ollamaModel || 'llama3.2-vision';

      const payload = {
        model,
        prompt: systemInstruction + '\n\n' + userTextPrompt,
        stream: false,
        format: 'json',
        ...(imageBase64 ? { images: [imageBase64] } : {})
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(`Ollama Server Error (${res.status}). 로컬 서버가 실행 중인지 확인하세요.`);
      }
      const data = await res.json();
      const rawText = data?.response || data?.message?.content;
      return extractJsonFromAiResponse(rawText);
    } else {
      return null;
    }
  }

  // FIX 1: Robust JSON extractor capable of parsing JSON embedded in conversational text
  function extractJsonFromAiResponse(rawText) {
    if (!rawText) return null;
    let text = rawText.trim();

    // 1. Try direct parse
    try {
      return JSON.parse(text);
    } catch (_) {}

    // 2. Try codeblock extraction
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch (_) {}
    }

    // 3. Match outermost { ... }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        const jsonStr = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(jsonStr);
      } catch (_) {}
    }

    return null;
  }

  // ==================== [기능 3-2] 외부 .GLB/.GLTF 직접 로드 & 캐싱 ====================
  function handleGLBUpload(file, targetW, targetD, targetH, name) {
    if (!file) return;
    const reader = new FileReader();

    showToast(`'${file.name}' GLB 모델을 파싱 및 스케일 변환 중...`);

    reader.onload = (e) => {
      const arrayBuffer = e.target.result;
      if (typeof THREE.GLTFLoader === 'undefined') {
        showToast('GLTFLoader 라이브러리를 불러오지 못했습니다.');
        return;
      }

      const loader = new THREE.GLTFLoader();
      loader.parse(
        arrayBuffer,
        '',
        (gltf) => {
          const model = gltf.scene;
          model.name = 'VisualMeshes';

          model.updateMatrixWorld(true);
          const origBox = new THREE.Box3().setFromObject(model);
          const origSize = origBox.getSize(new THREE.Vector3());
          const origCenter = origBox.getCenter(new THREE.Vector3());

          const targetWU = targetW * MM_TO_UNIT;
          const targetDU = targetD * MM_TO_UNIT;
          const targetHU = targetH * MM_TO_UNIT;

          const sx = origSize.x > 0.001 ? targetWU / origSize.x : 1;
          const sy = origSize.y > 0.001 ? targetHU / origSize.y : 1;
          const sz = origSize.z > 0.001 ? targetDU / origSize.z : 1;

          model.position.x = -origCenter.x * sx;
          model.position.y = -origBox.min.y * sy;
          model.position.z = -origCenter.z * sz;
          model.scale.set(sx, sy, sz);

          model.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          const id = 'glb_' + Date.now();
          const itemData = {
            id,
            catalogId: id,
            name: name || file.name.replace(/\.[^/.]+$/, ''),
            category: 'decor',
            shape: 'glb_custom',
            w: targetW,
            d: targetD,
            h: targetH,
            x: 0, y: 0, z: 0,
            rotY: 0,
            isGLB: true,
            isAI: true,
            tag: 'GLB 3D',
            origCenter: { x: origCenter.x, y: origBox.min.y, z: origCenter.z },
            origSize: { x: origSize.x, y: origSize.y, z: origSize.z }
          };

          // Cache GLB original model in memory
          state.glbModelCache.set(id, gltf.scene.clone());

          const group = buildGLBFurnitureGroup(gltf.scene, itemData);
          state.furnitureList.push(itemData);
          furnitureGroup.add(group);
          furnitureMeshMap.set(id, group);

          state.aiVault.unshift(itemData);
          renderAIVaultUI();

          if (state.mode !== '3d') switchViewportMode('3d');
          selectFurniture(id);
          evaluateAllCollisions();
          draw2DFloorplan();
          showToast(`'${itemData.name}' .GLB 3D 가구가 방 중앙에 성공적으로 배치되었습니다!`);
        },
        (err) => {
          console.error(err);
          showToast('GLB 파일 로드 중 오류가 발생했습니다.');
        }
      );
    };
    reader.readAsArrayBuffer(file);
  }

  // FIX 5: Proper GLB Group Builder with outline and collision shells
  function buildGLBFurnitureGroup(modelScene, itemData) {
    const group = new THREE.Group();
    group.name = 'Furniture_' + itemData.id;
    group.userData = { furnitureId: itemData.id, itemData };

    const visualNode = modelScene.clone();
    visualNode.name = 'VisualMeshes';
    group.add(visualNode);

    const targetWU = itemData.w * MM_TO_UNIT;
    const targetDU = itemData.d * MM_TO_UNIT;
    const targetHU = itemData.h * MM_TO_UNIT;

    const boundGeo = new THREE.BoxGeometry(targetWU + 0.02, targetHU + 0.02, targetDU + 0.02);
    boundGeo.translate(0, targetHU / 2, 0);

    const outlineBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(boundGeo),
      new THREE.LineBasicMaterial({ color: 0x4F46E5, linewidth: 2, transparent: true, opacity: 0.0 })
    );
    outlineBox.name = 'SelectionOutline';
    group.add(outlineBox);

    const tintBox = new THREE.Mesh(
      boundGeo,
      new THREE.MeshBasicMaterial({ color: 0xEF4444, transparent: true, opacity: 0.0, depthWrite: false })
    );
    tintBox.name = 'CollisionShell';
    group.add(tintBox);

    // Ergonomic Zone
    const ergoGeo = new THREE.PlaneGeometry(targetWU + 0.4, targetDU + 0.5);
    ergoGeo.rotateX(-Math.PI / 2);
    ergoGeo.translate(0, 0.005, 0.25);
    const ergoPlane = new THREE.Mesh(
      ergoGeo,
      new THREE.MeshBasicMaterial({ color: 0x10B981, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
    );
    ergoPlane.name = 'ErgoZoneMesh';
    ergoPlane.visible = state.globalErgoVisible;
    group.add(ergoPlane);

    group.position.set(itemData.x * MM_TO_UNIT, (itemData.y || 0) * MM_TO_UNIT, itemData.z * MM_TO_UNIT);
    group.rotation.y = THREE.MathUtils.degToRad(itemData.rotY || 0);
    return group;
  }

  // ==================== [기능 3] 중앙 색상 추출 (배경 제외) ====================
  function handleAIImageUpload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    state.aiUploadedMimeType = file.type;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      state.aiUploadedBase64 = dataUrl.split(',')[1];

      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 128;
        c.height = 128;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 128, 128);

        const imgData = ctx.getImageData(32, 32, 64, 64).data;
        let rSum = 0, gSum = 0, bSum = 0, validCount = 0;

        for (let i = 0; i < imgData.length; i += 4) {
          const r = imgData[i];
          const g = imgData[i + 1];
          const b = imgData[i + 2];
          const a = imgData[i + 3];

          if (a < 128) continue;
          if (r < 32 && g < 32 && b < 32) continue;
          if (r > 235 && g > 235 && b > 235) continue;

          rSum += r;
          gSum += g;
          bSum += b;
          validCount++;
        }

        let hex = '#C89D7C';
        if (validCount > 10) {
          const r = Math.round(rSum / validCount);
          const g = Math.round(gSum / validCount);
          const b = Math.round(bSum / validCount);
          hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        }

        state.aiExtractedHex = hex;
        document.getElementById('ai-fallback-color').value = hex;
        document.getElementById('ai-fallback-color-label').textContent = hex;
        document.getElementById('ai-extracted-swatch').style.background = hex;
        document.getElementById('ai-extracted-hex').textContent = `추출 색상: ${hex}`;

        const previewImg = document.getElementById('ai-preview-img');
        previewImg.src = dataUrl;
        document.getElementById('ai-dropzone-prompt').classList.add('hidden');
        document.getElementById('ai-preview-wrap').classList.remove('hidden');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  // ==================== AI BLUEPRINT TRIGGER ====================
  async function triggerAIFurnitureGeneration() {
    const name = document.getElementById('ai-furn-name').value.trim() || 'AI 커스텀 가구';
    const shape = document.getElementById('ai-furn-shape').value;
    const w = Math.max(200, Number(document.getElementById('ai-dim-w').value) || 650);
    const d = Math.max(200, Number(document.getElementById('ai-dim-d').value) || 650);
    const h = Math.max(200, Number(document.getElementById('ai-dim-h').value) || 520);
    const color = document.getElementById('ai-fallback-color').value || state.aiExtractedHex;
    const matType = document.getElementById('ai-material-type').value || 'wood';
    const promptText = document.getElementById('ai-extra-prompt').value.trim();

    const loadingBox = document.getElementById('ai-loading-box');
    const loadingTitle = document.getElementById('ai-loading-title');
    const progressBar = document.getElementById('ai-progress-bar');
    const stepText = document.getElementById('ai-loading-step');
    const logBox = document.getElementById('ai-blueprint-log');
    const genBtn = document.getElementById('btn-generate-ai-furniture');

    loadingBox.classList.remove('hidden');
    logBox.classList.add('hidden');
    genBtn.disabled = true;
    progressBar.style.width = '15%';
    loadingTitle.textContent = 'AI 3D 부품 조합(Blueprint) 설계 중...';
    stepText.textContent = `엔진: ${state.aiConfig.provider.toUpperCase()} | 이미지/규격 전송 중...`;

    let blueprint = null;
    let isAIGenerated = false;

    try {
      if (state.aiConfig.provider !== 'smart_preset') {
        progressBar.style.width = '45%';
        stepText.textContent = '멀티모달 Vision 분석 및 Three.js JSON 파츠 분해 중...';
        blueprint = await callAIBlueprintAPI(
          state.aiUploadedBase64,
          state.aiUploadedMimeType,
          name,
          w, d, h,
          shape,
          promptText
        );
        if (blueprint && Array.isArray(blueprint.parts) && blueprint.parts.length > 0) {
          isAIGenerated = true;
        }
      }
    } catch (err) {
      console.warn('AI API call failed, falling back to smart procedural generator:', err);
      showToast(`AI 호출 오류: ${err.message}. 정밀 파라미터 조립기로 자동 전환합니다.`);
    }

    progressBar.style.width = '80%';
    stepText.textContent = isAIGenerated
      ? `AI가 ${blueprint.parts.length}개 세부 파츠 설계도를 완성했습니다! Three.js 조립 중...`
      : '고급 디테일 파라미터 파츠 생성 알고리즘으로 3D 메쉬를 합성 중...';

    if (!blueprint || !Array.isArray(blueprint.parts) || blueprint.parts.length === 0) {
      blueprint = generateSmartBlueprint(shape, w, d, h, color, matType);
    }

    logBox.textContent = `// AI 3D Furniture Blueprint JSON (${isAIGenerated ? 'Online API' : 'Smart Procedural'})\n` + JSON.stringify(blueprint, null, 2);
    logBox.classList.remove('hidden');

    setTimeout(() => {
      progressBar.style.width = '100%';
      loadingBox.classList.add('hidden');
      genBtn.disabled = false;

      const newItemData = {
        id: 'ai_' + Date.now(),
        catalogId: 'ai_' + Date.now(),
        name,
        category: 'decor',
        shape,
        w, d, h,
        x: 0, y: 0, z: 0,
        rotY: 0,
        color,
        materialType: matType,
        blueprintData: blueprint,
        isAI: true,
        tag: isAIGenerated ? 'AI Vision' : 'AI Blueprint',
        ergoClearance: { front: 550, side: 200 }
      };

      state.furnitureList.push(newItemData);
      const meshGroup = buildFurnitureFromAIJson(blueprint, newItemData);
      furnitureGroup.add(meshGroup);
      furnitureMeshMap.set(newItemData.id, meshGroup);

      state.aiVault.unshift(newItemData);
      renderAIVaultUI();

      if (state.mode !== '3d') switchViewportMode('3d');
      selectFurniture(newItemData.id);
      evaluateAllCollisions();
      draw2DFloorplan();
      showToast(`3D 가구 '${name}' 조립 완료 (${blueprint.parts.length}개 파츠 입체 결합)!`);
    }, 500);
  }

  // ==================== FURNITURE CRUD & SELECTION ====================
  // FIX 5: Handle GLB cloning when adding from template/vault
  function addFurnitureFromTemplate(template, customTransform = {}) {
    const id = 'furn_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const isGLB = !!template.isGLB;

    const newItem = {
      id,
      catalogId: template.catalogId || id,
      name: template.name,
      category: template.category || 'decor',
      shape: template.shape || 'legged',
      w: Number(template.w),
      d: Number(template.d),
      h: Number(template.h),
      x: customTransform.x !== undefined ? customTransform.x : 0,
      y: customTransform.y !== undefined ? customTransform.y : 0,
      z: customTransform.z !== undefined ? customTransform.z : 0,
      rotY: customTransform.rotY !== undefined ? customTransform.rotY : 0,
      color: template.color || '#8B6F4E',
      materialType: template.materialType || 'wood',
      isGLB,
      isAI: !!template.isAI,
      isColliding: false,
      collisionReason: '',
      ergoClearance: template.ergoClearance || { front: 550, side: 200 },
      ergoVisible: true
    };

    let meshGroup = null;

    if (isGLB) {
      const cachedScene = state.glbModelCache.get(template.catalogId) || state.glbModelCache.get(template.id);
      if (cachedScene) {
        meshGroup = buildGLBFurnitureGroup(cachedScene, newItem);
      } else {
        const bp = generateSmartBlueprint('modern_rect_desk', newItem.w, newItem.d, newItem.h, newItem.color, 'wood');
        newItem.blueprintData = bp;
        meshGroup = buildFurnitureFromAIJson(bp, newItem);
      }
    } else {
      newItem.blueprintData = template.blueprintData || generateSmartBlueprint(template.shape, template.w, template.d, template.h, template.color, template.materialType);
      meshGroup = buildFurnitureFromAIJson(newItem.blueprintData, newItem);
    }

    state.furnitureList.push(newItem);
    furnitureGroup.add(meshGroup);
    furnitureMeshMap.set(id, meshGroup);

    selectFurniture(id);
    evaluateAllCollisions();
    draw2DFloorplan();
    HistoryManager.pushState();
    return newItem;
  }

  // FIX 4: Rebuild without destroying custom AI blueprints or GLB models
  function rebuildSingleFurnitureMesh(item) {
    const oldMesh = furnitureMeshMap.get(item.id);
    if (oldMesh) furnitureGroup.remove(oldMesh);

    let newMesh = null;

    if (item.isGLB) {
      const cachedScene = state.glbModelCache.get(item.catalogId) || state.glbModelCache.get(item.id);
      if (cachedScene) {
        newMesh = buildGLBFurnitureGroup(cachedScene, item);
      } else {
        const bp = generateSmartBlueprint('modern_rect_desk', item.w, item.d, item.h, item.color, 'wood');
        newMesh = buildFurnitureFromAIJson(bp, item);
      }
    } else if (item.blueprintData && Array.isArray(item.blueprintData.parts)) {
      // Scale blueprint parts proportionally to new dimensions
      const origW = item.blueprintData.origW || item.w;
      const origD = item.blueprintData.origD || item.d;
      const origH = item.blueprintData.origH || item.h;

      const sx = origW > 0 ? item.w / origW : 1;
      const sy = origH > 0 ? item.h / origH : 1;
      const sz = origD > 0 ? item.d / origD : 1;

      // Update part sizes and positions
      const scaledBlueprint = {
        parts: item.blueprintData.parts.map((p) => {
          const szArr = p.size || [100, 100, 100];
          const posArr = p.position || [0, 0, 0];
          return {
            ...p,
            size: [szArr[0] * sx, szArr[1] * sy, szArr[2] * sz],
            position: [posArr[0] * sx, posArr[1] * sy, posArr[2] * sz]
          };
        }),
        origW: item.w,
        origD: item.d,
        origH: item.h
      };
      item.blueprintData = scaledBlueprint;
      newMesh = buildFurnitureFromAIJson(scaledBlueprint, item);
    } else {
      const blueprint = generateSmartBlueprint(item.shape, item.w, item.d, item.h, item.color, item.materialType);
      item.blueprintData = blueprint;
      newMesh = buildFurnitureFromAIJson(blueprint, item);
    }

    furnitureGroup.add(newMesh);
    furnitureMeshMap.set(item.id, newMesh);
    updateFurnitureVisualStatus(item);
  }

  // FIX 4b: Fast Material Color Update without destroying 3D mesh
  function updateFurnitureMaterialColor(item, newColor) {
    item.color = newColor;
    const group = furnitureMeshMap.get(item.id);
    if (!group) return;

    const visualNode = group.getObjectByName('VisualMeshes');
    if (visualNode) {
      visualNode.traverse((child) => {
        if (child.isMesh && child.material) {
          // If material is primary, update color
          if (child.material.color) {
            child.material.color.set(newColor);
          }
        }
      });
    }
  }

  function selectFurniture(id) {
    state.selectedFurnitureId = id;
    if (id) {
      state.selectedWallId = null;
      if (state.deviceMode === 'mobile') {
        openMobileDrawer('right');
      }
    }
    state.furnitureList.forEach((item) => updateFurnitureVisualStatus(item));
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
    HistoryManager.pushState();
  }

  // ==================== [기능 2-3] 충돌 감지 & 900mm 방문 반경 체크 ====================
  function evaluateAllCollisions() {
    const itemBoxes = new Map();

    state.furnitureList.forEach((item) => {
      const group = furnitureMeshMap.get(item.id);
      if (!group) return;
      group.updateMatrixWorld(true);
      const visualNode = group.getObjectByName('VisualMeshes') || group;
      const box3 = new THREE.Box3().setFromObject(visualNode);
      box3.expandByScalar(-0.008);
      itemBoxes.set(item.id, box3);

      item.isColliding = false;
      item.collisionReason = '';
    });

    // 1. Furniture vs Furniture Collision
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

    // 2. Furniture vs Walls & Floor Boundary
    const poly = getEffectiveFloorPolygon();
    state.furnitureList.forEach((item) => {
      const box = itemBoxes.get(item.id);
      if (!box) return;

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

      for (const wall of state.walls) {
        const halfThick = (wall.thickness || state.wallThickness) / 2 - 12;
        if (boxIntersectsWallSegmentMM(box, wall, halfThick)) {
          item.isColliding = true;
          item.collisionReason = '가구가 벽체(Wall) 내부와 충돌하고 있습니다.';
          break;
        }
      }

      // 3. Furniture vs 900mm Door Swing Zone
      for (const doorZone of doorSwingZones) {
        if (box.intersectsBox(doorZone.box3)) {
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
    if (state.selectedFurnitureId) updateSelectedCollisionUI();
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
        outline.material.color.setHex(0xEF4444);
        outline.material.opacity = 1.0;
      } else if (isSelected) {
        outline.material.color.setHex(0x4F46E5);
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
    if (ergoLine) ergoLine.visible = showErgo;
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

  // FIX 2: Point to Line Segment Distance for accurate wall erasing
  function distToSegment(px, pz, x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) return Math.hypot(px - x1, pz - z1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / lenSq));
    const projX = x1 + t * dx;
    const projZ = z1 + t * dz;
    return Math.hypot(px - projX, pz - projZ);
  }

  // ==================== 3D RAYCASTER DRAG & DROP ====================
  function on3DPointerDown(e) {
    if (state.mode !== '3d') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouseNDC, camera);
    const hitList = raycaster.intersectObjects(furnitureGroup.children, true);

    if (hitList.length > 0) {
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
      selectFurniture(null);
      if (state.deviceMode === 'mobile') {
        closeMobileDrawers();
      }
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
      evaluateAllCollisions();
      draw2DFloorplan();
      HistoryManager.pushState();
    }
  }

  function onGlobalKeyDown(e) {
    const isInputFocused = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    // Undo / Redo Shortcuts
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCtrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

    if (isCtrlOrCmd) {
      if (!isInputFocused) {
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          e.preventDefault();
          HistoryManager.undo();
          return;
        }
        if ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
          e.preventDefault();
          HistoryManager.redo();
          return;
        }
      }
    }

    if (isInputFocused) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedFurnitureId) {
        deleteSelectedFurniture();
      } else if (state.selectedWallId) {
        deleteSelectedWall();
      }
    } else if (e.key === 'r' || e.key === 'R') {
      if (state.selectedFurnitureId) rotateSelectedFurnitureBy(90);
    } else if (e.key === 'Escape') {
      if (state.isDrawingWall) {
        state.isDrawingWall = false;
        state.drawStartPt = null;
        state.drawCurrentPt = null;
        draw2DFloorplan();
        showToast('벽 그리기가 취소되었습니다.');
      } else if (state.selectedFurnitureId) {
        selectFurniture(null);
      } else if (state.selectedWallId) {
        selectWall(null);
      }
    }
  }

  // ==================== FRONT WALL CUTAWAY ====================
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

      camDir.copy(camera.position).sub(wallGroup.userData.midPoint).normalize();
      const dot = camDir.dot(wallGroup.userData.outwardNormal);

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
    window.addEventListener('pointermove', on2DPointerMove);
    window.addEventListener('pointerup', on2DPointerUp);
    window.addEventListener('pointercancel', on2DPointerUp);
    canvas2D.addEventListener('wheel', on2DWheel, { passive: false });
    canvas2D.addEventListener('contextmenu', (e) => e.preventDefault());
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

    // 1. Grid
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

    // 2. Floor Polygon
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

    // 3. Furniture Footprints in 2D
    state.furnitureList.forEach((item) => {
      const center = mmToCanvas2D(item.x, item.z);
      const pw = item.w * state.zoom2D;
      const pd = item.d * state.zoom2D;

      ctx2D.save();
      ctx2D.translate(center.px, center.py);
      ctx2D.rotate(THREE.MathUtils.degToRad(-item.rotY));

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

      ctx2D.fillStyle = item.isColliding ? 'rgba(239, 68, 68, 0.45)' : (item.color || '#4B5563');
      ctx2D.strokeStyle = item.id === state.selectedFurnitureId ? '#4F46E5' : (item.isColliding ? '#EF4444' : '#E2E4E9');
      ctx2D.lineWidth = item.id === state.selectedFurnitureId ? 2.5 : 1.2;
      ctx2D.fillRect(-pw / 2, -pd / 2, pw, pd);
      ctx2D.strokeRect(-pw / 2, -pd / 2, pw, pd);

      ctx2D.fillStyle = '#FFFFFF';
      ctx2D.font = '600 11px Inter, sans-serif';
      ctx2D.textAlign = 'center';
      ctx2D.textBaseline = 'middle';
      ctx2D.fillText(item.name.slice(0, 11), 0, 0);
      ctx2D.restore();
    });

    // 4. Walls & Dimensions (with selection highlight and hover glow)
    state.walls.forEach((wall) => {
      const p1 = mmToCanvas2D(wall.x1, wall.z1);
      const p2 = mmToCanvas2D(wall.x2, wall.z2);
      const thickPx = Math.max(6, (wall.thickness || state.wallThickness) * state.zoom2D);

      const isSelected = wall.id === state.selectedWallId;
      const isHovered = wall.id === state.hoveredWallId;

      if (isSelected) {
        ctx2D.strokeStyle = 'rgba(99, 102, 241, 0.45)';
        ctx2D.lineWidth = thickPx + 8;
        ctx2D.lineCap = 'round';
        ctx2D.beginPath();
        ctx2D.moveTo(p1.px, p1.py);
        ctx2D.lineTo(p2.px, p2.py);
        ctx2D.stroke();
      }

      ctx2D.strokeStyle = isSelected ? '#6366F1' : (isHovered ? '#818CF8' : '#9CA3AF');
      ctx2D.lineWidth = thickPx;
      ctx2D.lineCap = 'square';
      ctx2D.beginPath();
      ctx2D.moveTo(p1.px, p1.py);
      ctx2D.lineTo(p2.px, p2.py);
      ctx2D.stroke();

      const lenMM = Math.round(Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1));
      const midX = (p1.px + p2.px) / 2;
      const midY = (p1.py + p2.py) / 2;
      ctx2D.fillStyle = isSelected ? '#1E1B4B' : '#18191C';
      ctx2D.fillRect(midX - 30, midY - 10, 60, 20);
      ctx2D.strokeStyle = isSelected ? '#818CF8' : '#3F4352';
      ctx2D.lineWidth = isSelected ? 1.5 : 1;
      ctx2D.strokeRect(midX - 30, midY - 10, 60, 20);
      ctx2D.fillStyle = isSelected ? '#C7D2FE' : '#E2E4E9';
      ctx2D.font = '600 10.5px "JetBrains Mono", monospace';
      ctx2D.textAlign = 'center';
      ctx2D.textBaseline = 'middle';
      ctx2D.fillText(`${lenMM}mm`, midX, midY);
    });

    // 4b. Circular Vertex Handles (Active in Select Mode)
    if (state.drawTool === 'select') {
      const drawnVerts = new Set();
      state.walls.forEach((wall) => {
        ['start', 'end'].forEach((ep) => {
          const wx = ep === 'start' ? wall.x1 : wall.x2;
          const wz = ep === 'start' ? wall.z1 : wall.z2;
          const key = `${Math.round(wx)},${Math.round(wz)}`;
          if (drawnVerts.has(key)) return;
          drawnVerts.add(key);

          const cp = mmToCanvas2D(wx, wz);
          const isHovered = state.hoveredVertex && Math.hypot(state.hoveredVertex.x - wx, state.hoveredVertex.z - wz) < 50;
          const isDragging = state.draggingVertex && Math.hypot(state.draggingVertex.origX - wx, state.draggingVertex.origZ - wz) < 50;

          const radius = isDragging ? 8.5 : (isHovered ? 7.5 : 5.5);
          ctx2D.beginPath();
          ctx2D.arc(cp.px, cp.py, radius, 0, Math.PI * 2);
          ctx2D.fillStyle = isDragging ? '#4F46E5' : (isHovered ? '#818CF8' : '#1E1F24');
          ctx2D.fill();
          ctx2D.strokeStyle = isDragging || isHovered ? '#FFFFFF' : '#818CF8';
          ctx2D.lineWidth = isDragging || isHovered ? 2.5 : 1.8;
          ctx2D.stroke();
        });
      });
    }

    // 4c. Ortho Alignment Guide Line
    if (state.orthoGuideLine) {
      ctx2D.save();
      ctx2D.strokeStyle = '#38BDF8';
      ctx2D.lineWidth = 1.2;
      ctx2D.setLineDash([6, 4]);
      ctx2D.beginPath();
      if (state.orthoGuideLine.type === 'vertical') {
        const p = mmToCanvas2D(state.orthoGuideLine.x, 0);
        ctx2D.moveTo(p.px, 0);
        ctx2D.lineTo(p.px, H);
      } else if (state.orthoGuideLine.type === 'horizontal') {
        const p = mmToCanvas2D(0, state.orthoGuideLine.z);
        ctx2D.moveTo(0, p.py);
        ctx2D.lineTo(W, p.py);
      }
      ctx2D.stroke();
      ctx2D.restore();
    }

    // 5. Doors with 900mm swing and Windows
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

      ctx2D.fillStyle = '#121316';
      ctx2D.fillRect(-widthPx / 2, -thickPx / 2, widthPx, thickPx);

      if (op.type === 'door') {
        const rPx = 900 * state.zoom2D;
        ctx2D.fillStyle = 'rgba(79, 70, 229, 0.22)';
        ctx2D.strokeStyle = '#818CF8';
        ctx2D.lineWidth = 1.5;
        ctx2D.beginPath();
        ctx2D.moveTo(-widthPx / 2, 0);
        ctx2D.arc(-widthPx / 2, 0, rPx, 0, Math.PI / 2);
        ctx2D.closePath();
        ctx2D.fill();
        ctx2D.stroke();

        ctx2D.fillStyle = '#A5B4FC';
        ctx2D.font = '500 10px "JetBrains Mono", monospace';
        ctx2D.fillText('R900', -widthPx / 2 + rPx * 0.45, rPx * 0.45);
      } else {
        ctx2D.strokeStyle = '#38BDF8';
        ctx2D.lineWidth = 2;
        ctx2D.strokeRect(-widthPx / 2, -thickPx / 3, widthPx, (thickPx * 2) / 3);
      }
      ctx2D.restore();
    });

    // 6. Active Wall Line
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

  const activePointers2D = new Map();
  let pinchStartDist = 0;
  let pinchStartZoom = 0.11;
  let pinchStartMid = { x: 0, y: 0 };
  let pinchStartPan = { x: 0, y: 0 };
  let isPinching2D = false;

  // 2D Panning, Drawing, Multi-Touch Pinch/Pan, Wall/Vertex/Furniture Dragging & Selection
  function on2DPointerDown(e) {
    if (state.mode !== '2d') return;
    activePointers2D.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Multi-touch pinch & two-finger pan handling
    if (activePointers2D.size === 2) {
      isPinching2D = true;
      state.isPanning2D = false;
      state.isDrawingWall = false;
      state.draggingVertex = null;
      state.draggingWall = null;
      state.dragging2DFurnitureId = null;
      state.drag2DMode = null;

      const pts = Array.from(activePointers2D.values());
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoom = state.zoom2D;
      pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchStartPan = { x: state.pan2D.x, y: state.pan2D.y };
      draw2DFloorplan();
      return;
    }

    if (activePointers2D.size > 2) return;
    const rect = canvas2D.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Right-click, middle-click or dedicated Pan tool -> start pan
    if (e.button === 2 || e.button === 1 || state.drawTool === 'pan') {
      state.isPanning2D = true;
      state.panStart2D = { x: e.clientX - state.pan2D.x, y: e.clientY - state.pan2D.y };
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) return;

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
      // Tool: 'select'
      const isMobileTouch = state.deviceMode === 'mobile' || (e.pointerType === 'touch') || ('ontouchstart' in window);
      const vertHitRadius = isMobileTouch ? 26 : 14;
      const wallHitDist = isMobileTouch ? 360 : 220;

      // 1. Check Vertex handles first
      const hitVertex = findVertexNearCanvasPoint(px, py, vertHitRadius);
      if (hitVertex) {
        selectWall(hitVertex.wallId);
        const conns = getConnectedWallEndpoints(hitVertex.x, hitVertex.z);
        state.draggingVertex = {
          origX: hitVertex.x,
          origZ: hitVertex.z,
          connections: conns,
          startMouseMM: canvas2DToMM(px, py, 1)
        };
        state.drag2DMode = 'vertex';
        state.hasDragged2D = false;
        draw2DFloorplan();
        return;
      }

      // 2. Check Furniture
      const clickMM = canvas2DToMM(px, py, 1);
      const hitFurn = findFurnitureAt2DPoint(clickMM.x, clickMM.z);
      if (hitFurn) {
        selectFurniture(hitFurn.id);
        state.dragging2DFurnitureId = hitFurn.id;
        state.drag2DOffset = {
          x: hitFurn.x - clickMM.x,
          z: hitFurn.z - clickMM.z
        };
        state.drag2DMode = 'furniture';
        state.hasDragged2D = false;
        draw2DFloorplan();
        return;
      }

      // 3. Check Wall segment
      const hitWall = findWallNearPoint(clickMM, wallHitDist);
      if (hitWall) {
        selectWall(hitWall.id);
        const origStart = { x: hitWall.x1, z: hitWall.z1 };
        const origEnd = { x: hitWall.x2, z: hitWall.z2 };
        const startConns = getConnectedWallEndpoints(origStart.x, origStart.z).filter((c) => c.wall.id !== hitWall.id);
        const endConns = getConnectedWallEndpoints(origEnd.x, origEnd.z).filter((c) => c.wall.id !== hitWall.id);
        state.draggingWall = {
          wall: hitWall,
          origStart,
          origEnd,
          startConns,
          endConns,
          startMouseMM: clickMM
        };
        state.drag2DMode = 'wall';
        state.hasDragged2D = false;
        draw2DFloorplan();
        return;
      }

      // 4. Clicked empty canvas -> deselect all & close drawers on mobile
      selectFurniture(null);
      selectWall(null);
      if (state.deviceMode === 'mobile') {
        closeMobileDrawers();
      }
    }
  }

  function on2DPointerMove(e) {
    if (state.mode !== '2d') return;

    if (activePointers2D.has(e.pointerId)) {
      activePointers2D.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch-to-zoom & two-finger pan
    if (isPinching2D && activePointers2D.size >= 2) {
      const pts = Array.from(activePointers2D.values());
      const curDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDist > 5) {
        const factor = curDist / pinchStartDist;
        state.zoom2D = Math.min(0.4, Math.max(0.025, pinchStartZoom * factor));
      }
      const curMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      state.pan2D.x = pinchStartPan.x + (curMid.x - pinchStartMid.x);
      state.pan2D.y = pinchStartPan.y + (curMid.y - pinchStartMid.y);
      draw2DFloorplan();
      return;
    }

    if (state.isPanning2D) {
      state.pan2D.x = e.clientX - state.panStart2D.x;
      state.pan2D.y = e.clientY - state.panStart2D.y;
      draw2DFloorplan();
      return;
    }

    const rect = canvas2D.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (state.isDrawingWall) {
      state.drawCurrentPt = canvas2DToMM(px, py, 100);
      draw2DFloorplan();
      return;
    }

    if (state.drag2DMode === 'vertex' && state.draggingVertex) {
      state.hasDragged2D = true;
      const curMM = canvas2DToMM(px, py, 1);
      let nx = curMM.x;
      let nz = curMM.z;

      if (state.snapToGrid) {
        nx = Math.round(nx / 50) * 50;
        nz = Math.round(nz / 50) * 50;
      }

      // Ortho guide check with connected walls
      state.orthoGuideLine = null;
      for (const c of state.draggingVertex.connections) {
        const otherX = c.endpoint === 'start' ? c.wall.x2 : c.wall.x1;
        const otherZ = c.endpoint === 'start' ? c.wall.z2 : c.wall.z1;
        if (Math.abs(nx - otherX) <= 35) {
          nx = otherX;
          state.orthoGuideLine = { type: 'vertical', x: otherX };
          break;
        }
        if (Math.abs(nz - otherZ) <= 35) {
          nz = otherZ;
          state.orthoGuideLine = { type: 'horizontal', z: otherZ };
          break;
        }
      }

      // Update all connected endpoints
      state.draggingVertex.connections.forEach((c) => {
        if (c.endpoint === 'start') {
          c.wall.x1 = nx;
          c.wall.z1 = nz;
        } else {
          c.wall.x2 = nx;
          c.wall.z2 = nz;
        }
      });

      updateInspectorUI();
      draw2DFloorplan();
      return;
    }

    if (state.drag2DMode === 'wall' && state.draggingWall) {
      state.hasDragged2D = true;
      const curMM = canvas2DToMM(px, py, 1);
      let dx = curMM.x - state.draggingWall.startMouseMM.x;
      let dz = curMM.z - state.draggingWall.startMouseMM.z;

      if (state.snapToGrid) {
        dx = Math.round(dx / 50) * 50;
        dz = Math.round(dz / 50) * 50;
      }

      const wall = state.draggingWall.wall;
      wall.x1 = state.draggingWall.origStart.x + dx;
      wall.z1 = state.draggingWall.origStart.z + dz;
      wall.x2 = state.draggingWall.origEnd.x + dx;
      wall.z2 = state.draggingWall.origEnd.z + dz;

      // Connected vertex update
      state.draggingWall.startConns.forEach((c) => {
        if (c.endpoint === 'start') {
          c.wall.x1 = c.origX + dx;
          c.wall.z1 = c.origZ + dz;
        } else {
          c.wall.x2 = c.origX + dx;
          c.wall.z2 = c.origZ + dz;
        }
      });

      state.draggingWall.endConns.forEach((c) => {
        if (c.endpoint === 'start') {
          c.wall.x1 = c.origX + dx;
          c.wall.z1 = c.origZ + dz;
        } else {
          c.wall.x2 = c.origX + dx;
          c.wall.z2 = c.origZ + dz;
        }
      });

      updateInspectorUI();
      draw2DFloorplan();
      return;
    }

    if (state.drag2DMode === 'furniture' && state.dragging2DFurnitureId) {
      state.hasDragged2D = true;
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
      return;
    }

    // Hover state updates when in select tool
    if (state.drawTool === 'select') {
      const hitVert = findVertexNearCanvasPoint(px, py, 14);
      const prevVert = state.hoveredVertex;
      const prevWall = state.hoveredWallId;

      if (hitVert) {
        state.hoveredVertex = hitVert;
        state.hoveredWallId = null;
        canvas2D.className = 'cursor-crosshair';
      } else {
        state.hoveredVertex = null;
        const curMM = canvas2DToMM(px, py, 1);
        const hitFurn = findFurnitureAt2DPoint(curMM.x, curMM.z);
        if (hitFurn) {
          state.hoveredWallId = null;
          canvas2D.className = 'cursor-grab';
        } else {
          const hitW = findWallNearPoint(curMM, 220);
          if (hitW) {
            state.hoveredWallId = hitW.id;
            canvas2D.className = 'cursor-move';
          } else {
            state.hoveredWallId = null;
            canvas2D.className = 'cursor-default';
          }
        }
      }

      if (state.hoveredVertex !== prevVert || state.hoveredWallId !== prevWall) {
        draw2DFloorplan();
      }
    }
  }

  function on2DPointerUp(e) {
    activePointers2D.delete(e.pointerId);
    if (activePointers2D.size < 2) {
      isPinching2D = false;
    }

    if (state.isPanning2D) {
      state.isPanning2D = false;
      return;
    }

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
        HistoryManager.pushState();
        showToast(`새 벽체 (${Math.round(len)}mm)가 추가되었습니다.`);
      }
    }
    state.isDrawingWall = false;
    state.drawStartPt = null;
    state.drawCurrentPt = null;

    if (state.drag2DMode === 'vertex') {
      if (state.hasDragged2D) {
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        HistoryManager.pushState();
      }
      state.draggingVertex = null;
      state.orthoGuideLine = null;
    } else if (state.drag2DMode === 'wall') {
      if (state.hasDragged2D) {
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        HistoryManager.pushState();
      }
      state.draggingWall = null;
    } else if (state.drag2DMode === 'furniture') {
      if (state.hasDragged2D) {
        HistoryManager.pushState();
      }
      state.dragging2DFurnitureId = null;
    }

    state.drag2DMode = null;
    state.hasDragged2D = false;
    draw2DFloorplan();
  }

  function on2DWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    state.zoom2D = Math.min(0.35, Math.max(0.035, state.zoom2D * factor));
    draw2DFloorplan();
  }

  // FIX 8: Safe margin check for door/window placement
  function placeOpeningOnClosestWall(ptMM, type) {
    let bestWall = null;
    let bestT = 0.5;
    let bestDist = Infinity;

    state.walls.forEach((w) => {
      const dx = w.x2 - w.x1;
      const dz = w.z2 - w.z1;
      const lenMM = Math.hypot(dx, dz);
      if (lenMM < 300) return;

      const lenSq = dx * dx + dz * dz;
      let t = ((ptMM.x - w.x1) * dx + (ptMM.z - w.z1) * dz) / lenSq;

      // Safe margin from wall endpoints
      const halfW = (type === 'door' ? 450 : 700) + 40;
      const marginT = Math.min(0.4, halfW / lenMM);
      t = Math.max(marginT, Math.min(1 - marginT, t));

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
      const wallLen = Math.hypot(bestWall.x2 - bestWall.x1, bestWall.z2 - bestWall.z1);
      const requiredW = type === 'door' ? 900 : 1200;
      if (wallLen < requiredW + 80) {
        showToast(`벽 길이(${Math.round(wallLen)}mm)가 요소 폭(${requiredW}mm)보다 짧아 배치할 수 없습니다.`);
        return;
      }

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
      HistoryManager.pushState();
      showToast(type === 'door' ? '방문(개폐 반경 900mm)이 배치되었습니다.' : '창문이 배치되었습니다.');
    } else {
      showToast('문/창문을 배치하려면 기존 벽 선분 위를 클릭하세요.');
    }
  }

  // FIX 2: Accurate point-to-segment distance for erasing walls anywhere along their length
  function erase2DElementNear(ptMM) {
    // 1. Check openings first
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
        HistoryManager.pushState();
        showToast('문/창문 요소가 삭제되었습니다.');
        return;
      }
    }

    // 2. Check all walls using point-to-segment distance
    for (let i = state.walls.length - 1; i >= 0; i--) {
      const w = state.walls[i];
      const dist = distToSegment(ptMM.x, ptMM.z, w.x1, w.z1, w.x2, w.z2);
      if (dist < 280) {
        const wid = w.id;
        state.walls.splice(i, 1);
        state.openings = state.openings.filter((o) => o.wallId !== wid);
        rebuild3DRoomGeometry();
        evaluateAllCollisions();
        draw2DFloorplan();
        HistoryManager.pushState();
        showToast('벽체가 삭제되었습니다.');
        return;
      }
    }

    showToast('삭제할 벽 또는 문/창문 위를 클릭하세요.');
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
      card.innerHTML = `
        <div class="catalog-card-top">
          <span class="catalog-swatch" style="background:${item.color || '#4F46E5'};"></span>
          <span class="catalog-tag" style="color:#A5B4FC;">${item.tag || 'AI Custom'}</span>
        </div>
        <div class="catalog-name">${item.name}</div>
        <div class="catalog-dim">${item.w} × ${item.d} × ${item.h} mm</div>
      `;
      card.addEventListener('click', () => {
        addFurnitureFromTemplate(item, { x: 0, z: 0, rotY: 0 });
        showToast(`보관함에서 '${item.name}' 가구를 배치했습니다.`);
      });
      vaultEl.appendChild(card);
    });
  }

  // FIX 7: Render Placed Furniture list in both empty and selected states for seamless switching
  function renderPlacedFurnitureListUI() {
    const countEls = document.querySelectorAll('#placed-count, .placed-count-alt');
    countEls.forEach((el) => {
      if (el) el.textContent = state.furnitureList.length;
    });

    const listContainers = document.querySelectorAll('.placed-list');
    listContainers.forEach((listEl) => {
      listEl.innerHTML = '';
      if (state.furnitureList.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary); font-size:11px; padding:6px 0;">배치된 가구가 없습니다.</div>';
        return;
      }
      state.furnitureList.forEach((item) => {
        const row = document.createElement('div');
        const isSelected = item.id === state.selectedFurnitureId;
        row.className = 'placed-item-row' + (item.isColliding ? ' colliding' : '') + (isSelected ? ' selected' : '');
        row.innerHTML = `
          <span>${item.name}</span>
          <span class="mono-val">${item.isColliding ? '충돌 경고' : `${item.w}×${item.d}`}</span>
        `;
        row.addEventListener('click', () => selectFurniture(item.id));
        listEl.appendChild(row);
      });
    });
  }

  function updateInspectorUI() {
    const emptyState = document.getElementById('inspector-empty-state');
    const furnState = document.getElementById('inspector-furniture-state');
    const wallState = document.getElementById('inspector-wall-state');
    const badge = document.getElementById('inspector-target-badge');

    // Case 1: Furniture Selected
    if (state.selectedFurnitureId) {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (item) {
        if (emptyState) emptyState.classList.add('hidden');
        if (wallState) wallState.classList.add('hidden');
        if (furnState) furnState.classList.remove('hidden');
        if (badge) badge.textContent = item.isGLB ? 'GLB 3D 가구' : (item.isAI ? 'AI 커스텀 가구' : '선택된 가구');

        document.getElementById('prop-item-category').textContent = `${(item.category || 'decor').toUpperCase()} · ${item.shape || 'CUSTOM'}`;
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
        renderPlacedFurnitureListUI();
        return;
      }
    }

    // Case 2: Wall Selected
    if (state.selectedWallId) {
      const wall = state.walls.find((w) => w.id === state.selectedWallId);
      if (wall) {
        if (emptyState) emptyState.classList.add('hidden');
        if (furnState) furnState.classList.add('hidden');
        if (wallState) wallState.classList.remove('hidden');
        if (badge) badge.textContent = '선택된 벽체';

        const lenMM = Math.round(Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1));
        const titleEl = document.getElementById('prop-wall-title');
        if (titleEl) titleEl.textContent = `벽체 (ID: ${wall.id})`;

        const lenInput = document.getElementById('prop-wall-length');
        if (lenInput) lenInput.value = lenMM;

        const thickInput = document.getElementById('prop-wall-thickness');
        if (thickInput) thickInput.value = wall.thickness || state.wallThickness;

        const heightInput = document.getElementById('prop-wall-height');
        if (heightInput) heightInput.value = wall.height || state.ceilingHeight;

        const wallOpenings = state.openings.filter((o) => o.wallId === wall.id);
        const doorsCount = wallOpenings.filter((o) => o.type === 'door').length;
        const winsCount = wallOpenings.filter((o) => o.type === 'window').length;
        const infoEl = document.getElementById('prop-wall-openings-info');
        if (infoEl) infoEl.textContent = `방문 ${doorsCount}개, 창문 ${winsCount}개 부착됨`;

        renderPlacedFurnitureListUI();
        return;
      }
    }

    // Case 3: Nothing Selected (Room Setting)
    if (emptyState) emptyState.classList.remove('hidden');
    if (furnState) furnState.classList.add('hidden');
    if (wallState) wallState.classList.add('hidden');
    if (badge) badge.textContent = '공간 설정';
    renderPlacedFurnitureListUI();
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

    const mbLabel = document.getElementById('mb-mode-label');
    if (mbLabel) {
      mbLabel.textContent = mode === '2d' ? '3D 보기' : '2D 도면';
    }

    if (mode === '3d') {
      rebuild3DRoomGeometry();
      evaluateAllCollisions();
    } else {
      onWindowResize();
      draw2DFloorplan();
    }
  }

  // 2D Draw Tools (Top-Level Scope)
  function setDrawTool(tool) {
    state.drawTool = tool;
    document.querySelectorAll('.draw-tool-btn, .hud-tool-chip').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    if (canvas2D) {
      canvas2D.className = 'cursor-' + tool;
    }
    if (state.mode !== '2d') switchViewportMode('2d');
  }

  function updatePresetCardUI() {
    document.querySelectorAll('.preset-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.activePreset);
    });
  }

  function bindUIEvents() {
    // Device Mode Toggle (PC vs Mobile)
    const btnDeviceMode = document.getElementById('btn-toggle-device-mode');
    if (btnDeviceMode) {
      btnDeviceMode.addEventListener('click', () => {
        const nextMode = state.deviceMode === 'mobile' ? 'pc' : 'mobile';
        setDeviceMode(nextMode, true);
        showToast(nextMode === 'mobile' ? '📱 모바일/태블릿 최적화 모드로 전환되었습니다.' : '💻 PC 프로페셔널 CAD 모드로 전환되었습니다.');
      });
    }

    // Mobile Hamburger Menu Button
    const btnMobileMenu = document.getElementById('btn-mobile-menu');
    if (btnMobileMenu) {
      btnMobileMenu.addEventListener('click', () => {
        const leftSidebar = document.getElementById('left-sidebar');
        if (leftSidebar && leftSidebar.classList.contains('mobile-open')) {
          closeMobileDrawers();
        } else {
          openMobileDrawer('left');
        }
      });
    }

    // Drawer Close Buttons & Backdrop
    const btnCloseLeft = document.getElementById('btn-close-left-sidebar');
    if (btnCloseLeft) btnCloseLeft.addEventListener('click', closeMobileDrawers);

    const btnCloseInsp = document.getElementById('btn-close-inspector');
    if (btnCloseInsp) btnCloseInsp.addEventListener('click', closeMobileDrawers);

    const backdrop = document.getElementById('mobile-drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeMobileDrawers);

    // Mobile Bottom Nav Bar Buttons
    const mbCatalog = document.getElementById('mb-btn-catalog');
    if (mbCatalog) {
      mbCatalog.addEventListener('click', () => {
        const leftSidebar = document.getElementById('left-sidebar');
        if (leftSidebar && leftSidebar.classList.contains('mobile-open')) {
          closeMobileDrawers();
        } else {
          openMobileDrawer('left');
        }
      });
    }

    const mbModeToggle = document.getElementById('mb-btn-mode-toggle');
    if (mbModeToggle) {
      mbModeToggle.addEventListener('click', () => {
        switchViewportMode(state.mode === '2d' ? '3d' : '2d');
      });
    }

    const mbTools = document.getElementById('mb-btn-tools');
    if (mbTools) {
      mbTools.addEventListener('click', () => {
        if (state.mode !== '2d') switchViewportMode('2d');
        const tab1 = document.querySelector('.sidebar-tab[data-tab="tab-floorplan"]');
        if (tab1) tab1.click();
        openMobileDrawer('left');
      });
    }

    const mbInspector = document.getElementById('mb-btn-inspector');
    if (mbInspector) {
      mbInspector.addEventListener('click', () => {
        const rightSidebar = document.getElementById('right-sidebar');
        if (rightSidebar && rightSidebar.classList.contains('mobile-open')) {
          closeMobileDrawers();
        } else {
          openMobileDrawer('right');
        }
      });
    }

    const mbUndo = document.getElementById('mb-btn-undo');
    if (mbUndo) {
      mbUndo.addEventListener('click', () => {
        HistoryManager.undo();
      });
    }


    // Mode Switch
    document.getElementById('btn-mode-2d').addEventListener('click', () => switchViewportMode('2d'));
    document.getElementById('btn-mode-3d').addEventListener('click', () => switchViewportMode('3d'));
    document.getElementById('btn-open-2d-editor').addEventListener('click', () => switchViewportMode('2d'));
    document.getElementById('btn-2d-to-3d-extrude').addEventListener('click', () => {
      switchViewportMode('3d');
      showToast('2D 단면도를 3D 벽체 및 공간 메쉬로 입체 변환(Extrude)했습니다.');
    });

    // Left Sidebar Main Tabs
    document.querySelectorAll('.sidebar-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        tabBtn.classList.add('active');
        document.getElementById(tabBtn.dataset.tab).classList.add('active');
      });
    });

    // Sub-tab switch (AI Blueprint vs GLB Upload)
    document.querySelectorAll('.subtab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.ai-subpanel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.subtab).classList.add('active');
      });
    });

    // Preset Cards
    document.querySelectorAll('.preset-card').forEach((card) => {
      card.addEventListener('click', () => {
        loadFloorplanPreset(card.dataset.preset, false);
        HistoryManager.pushState();
        showToast(`'${state.roomName}' 프리셋 구조가 적용되었습니다.`);
      });
    });

    // Custom Room Dim Apply
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
      HistoryManager.pushState();
      showToast(`방 치수(${W}×${D}×${H}mm)가 2D/3D 공간에 반영되었습니다.`);
    });

    // 2D Draw Tools Button Bindings
    document.querySelectorAll('.draw-tool-btn, .hud-tool-chip').forEach((btn) => {
      btn.addEventListener('click', () => setDrawTool(btn.dataset.tool));
    });

    // Undo / Redo Header Buttons
    const btnUndo = document.getElementById('btn-undo');
    if (btnUndo) btnUndo.addEventListener('click', () => HistoryManager.undo());

    const btnRedo = document.getElementById('btn-redo');
    if (btnRedo) btnRedo.addEventListener('click', () => HistoryManager.redo());

    // Wall Inspector Controls
    const btnDeselectWall = document.getElementById('btn-deselect-wall');
    if (btnDeselectWall) btnDeselectWall.addEventListener('click', () => selectWall(null));

    const btnDeleteWall = document.getElementById('btn-delete-wall');
    if (btnDeleteWall) btnDeleteWall.addEventListener('click', deleteSelectedWall);

    const btnApplyWallLen = document.getElementById('btn-apply-wall-length');
    if (btnApplyWallLen) {
      btnApplyWallLen.addEventListener('click', () => {
        const val = Number(document.getElementById('prop-wall-length').value);
        applySelectedWallLength(val);
      });
    }

    const wallLenInput = document.getElementById('prop-wall-length');
    if (wallLenInput) {
      wallLenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          applySelectedWallLength(Number(wallLenInput.value));
        }
      });
    }

    const wallThickInput = document.getElementById('prop-wall-thickness');
    if (wallThickInput) {
      wallThickInput.addEventListener('change', (e) => {
        if (!state.selectedWallId) return;
        const wall = state.walls.find((w) => w.id === state.selectedWallId);
        if (wall) {
          wall.thickness = Math.max(80, Math.min(500, Number(e.target.value) || 160));
          rebuild3DRoomGeometry();
          evaluateAllCollisions();
          draw2DFloorplan();
          HistoryManager.pushState();
        }
      });
    }

    const wallHeightInput = document.getElementById('prop-wall-height');
    if (wallHeightInput) {
      wallHeightInput.addEventListener('change', (e) => {
        if (!state.selectedWallId) return;
        const wall = state.walls.find((w) => w.id === state.selectedWallId);
        if (wall) {
          wall.height = Math.max(1500, Math.min(5000, Number(e.target.value) || 2400));
          rebuild3DRoomGeometry();
          evaluateAllCollisions();
          draw2DFloorplan();
          HistoryManager.pushState();
        }
      });
    }

    // FIX 3: Reset state.floorPolygon as well when clearing 2D walls
    document.getElementById('btn-clear-2d-walls').addEventListener('click', () => {
      state.walls = [];
      state.openings = [];
      state.floorPolygon = [];
      rebuild3DRoomGeometry();
      draw2DFloorplan();
      HistoryManager.pushState();
      showToast('모든 벽체와 문/창문, 바닥 경계가 초기화되었습니다. 2D 캔버스에서 새로 그려보세요.');
    });

    // Header Utilities
    document.getElementById('chk-auto-cutaway').addEventListener('change', (e) => {
      state.autoCutaway = e.target.checked;
    });

    document.getElementById('btn-reset-camera').addEventListener('click', () => {
      resetCameraView();
      showToast('카메라 시점이 초기화되었습니다.');
    });

    // Save & Load State
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
      localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(payload));
      showToast('현재 도면 및 가구 배치가 브라우저(localStorage)에 저장되었습니다.');
    });

    document.getElementById('btn-load-state').addEventListener('click', () => {
      const raw = localStorage.getItem(STORAGE_KEY_STATE);
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
          let meshGroup = null;

          if (item.isGLB) {
            const cachedScene = state.glbModelCache.get(item.catalogId) || state.glbModelCache.get(item.id);
            if (cachedScene) {
              meshGroup = buildGLBFurnitureGroup(cachedScene, item);
            } else {
              const bp = item.blueprintData || generateSmartBlueprint('modern_rect_desk', item.w, item.d, item.h, item.color, 'wood');
              meshGroup = buildFurnitureFromAIJson(bp, item);
            }
          } else {
            const bp = item.blueprintData || generateSmartBlueprint(item.shape, item.w, item.d, item.h, item.color, item.materialType);
            meshGroup = buildFurnitureFromAIJson(bp, item);
          }

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

    // Global Ergo & Snap
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

    // AI Provider Select & Key Persistence
    document.getElementById('ai-provider-select').addEventListener('change', (e) => {
      state.aiConfig.provider = e.target.value;
      saveAIConfig();
      syncAIConfigUI();
    });

    document.getElementById('btn-save-api-key').addEventListener('click', () => {
      const key = document.getElementById('ai-api-key-input').value.trim();
      if (state.aiConfig.provider === 'gemini') {
        state.aiConfig.geminiApiKey = key;
      } else if (state.aiConfig.provider === 'openai') {
        state.aiConfig.openaiApiKey = key;
      }
      saveAIConfig();
      showToast(`${state.aiConfig.provider.toUpperCase()} API 키가 저장되었습니다.`);
    });

    document.getElementById('btn-save-ollama-cfg').addEventListener('click', () => {
      state.aiConfig.ollamaUrl = document.getElementById('ai-ollama-url').value.trim();
      state.aiConfig.ollamaModel = document.getElementById('ai-ollama-model').value.trim();
      saveAIConfig();
      syncAIConfigUI();
      showToast('Ollama 로컬 서버 설정이 저장되었습니다.');
    });

    // AI Studio Image Dropzone
    const dropzone = document.getElementById('ai-dropzone');
    const fileInput = document.getElementById('ai-image-input');

    dropzone.addEventListener('click', (e) => {
      if (e.target.id === 'btn-remove-ai-img') return;
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) handleAIImageUpload(e.target.files[0]);
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleAIImageUpload(e.dataTransfer.files[0]);
    });

    document.getElementById('btn-remove-ai-img').addEventListener('click', (e) => {
      e.stopPropagation();
      state.aiUploadedBase64 = null;
      fileInput.value = '';
      document.getElementById('ai-dropzone-prompt').classList.remove('hidden');
      document.getElementById('ai-preview-wrap').classList.add('hidden');
    });

    document.getElementById('ai-fallback-color').addEventListener('input', (e) => {
      document.getElementById('ai-fallback-color-label').textContent = e.target.value.toUpperCase();
    });

    document.getElementById('btn-generate-ai-furniture').addEventListener('click', triggerAIFurnitureGeneration);

    // GLB / GLTF Upload Handlers
    const glbDropzone = document.getElementById('glb-dropzone');
    const glbFileInput = document.getElementById('glb-file-input');

    glbDropzone.addEventListener('click', () => glbFileInput.click());
    document.getElementById('btn-trigger-glb-select').addEventListener('click', () => glbFileInput.click());

    glbDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      glbDropzone.classList.add('dragover');
    });
    glbDropzone.addEventListener('dragleave', () => glbDropzone.classList.remove('dragover'));
    glbDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      glbDropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        processGLBFile(e.dataTransfer.files[0]);
      }
    });

    glbFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) processGLBFile(e.target.files[0]);
    });

    function processGLBFile(file) {
      const name = document.getElementById('glb-furn-name').value.trim() || file.name;
      const w = Number(document.getElementById('glb-dim-w').value) || 800;
      const d = Number(document.getElementById('glb-dim-d').value) || 800;
      const h = Number(document.getElementById('glb-dim-h').value) || 750;
      handleGLBUpload(file, w, d, h, name);
    }

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
      if (mesh) mesh.rotation.y = THREE.MathUtils.degToRad(item.rotY);
      evaluateAllCollisions();
      draw2DFloorplan();
    });

    document.querySelectorAll('.rot-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => rotateSelectedFurnitureBy(Number(btn.dataset.rotDelta)));
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
      HistoryManager.pushState();
      showToast(`'${item.name}' 치수가 ${item.w}×${item.d}×${item.h}mm로 변경되었습니다.`);
    });

    // FIX 4b: Fast smooth non-destructive color update
    document.getElementById('prop-color-picker').addEventListener('input', (e) => {
      const item = state.furnitureList.find((f) => f.id === state.selectedFurnitureId);
      if (!item) return;
      const newHex = e.target.value;
      document.getElementById('prop-color-hex').textContent = newHex.toUpperCase();
      updateFurnitureMaterialColor(item, newHex);
      draw2DFloorplan();
    });

    document.getElementById('prop-color-picker').addEventListener('change', () => {
      HistoryManager.pushState();
    });

    document.getElementById('prop-rot-slider').addEventListener('change', () => {
      HistoryManager.pushState();
    });

    ['prop-pos-x', 'prop-pos-y', 'prop-pos-z'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        HistoryManager.pushState();
      });
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
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('toast-notification');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // Export for debugging and external tests
  window.state = state;
  window.spaceCraftState = state;
  window.extractJsonFromAiResponse = extractJsonFromAiResponse;
  window.addFurnitureFromTemplate = addFurnitureFromTemplate;
  window.evaluateAllCollisions = evaluateAllCollisions;
  window.furnitureMeshMap = furnitureMeshMap;
  window.roomGroup = roomGroup;
  window.scene = scene;
  window.furnitureGroup = furnitureGroup;
  window.HistoryManager = HistoryManager;
  window.setDeviceMode = setDeviceMode;
  window.openMobileDrawer = openMobileDrawer;
  window.closeMobileDrawers = closeMobileDrawers;
  window.selectFurniture = selectFurniture;
  window.selectWall = selectWall;
  window.deleteSelectedWall = deleteSelectedWall;
  window.applySelectedWallLength = applySelectedWallLength;
  window.rebuild3DRoomGeometry = rebuild3DRoomGeometry;
  window.loadFloorplanPreset = loadFloorplanPreset;
  window.setDrawTool = setDrawTool;
  window.switchViewportMode = switchViewportMode;

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
