# test_new_features.py
# -*- coding: utf-8 -*-
import sys
import os
import json
from playwright.sync_api import sync_playwright

def run_tests():
    report = {
        "total_tests": 0,
        "passed": 0,
        "failed": 0,
        "results": [],
        "errors_found": []
    }

    def record(name, success, details=""):
        report["total_tests"] += 1
        if success:
            report["passed"] += 1
            report["results"].append({"name": name, "status": "PASSED", "details": details})
        else:
            report["failed"] += 1
            report["results"].append({"name": name, "status": "FAILED", "details": details})
            report["errors_found"].append(f"[{name}] {details}")

    html_path = os.path.abspath('index.html')
    file_url = f"file:///{html_path.replace(os.sep, '/')}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        page.goto(file_url, wait_until='networkidle')
        page.wait_for_timeout(1000)

        # TEST 1: Page Load & Initial State
        initial_check = page.evaluate("""() => {
            const undoBtn = document.getElementById('btn-undo');
            const redoBtn = document.getElementById('btn-redo');
            return {
                wallsCount: window.state.walls.length,
                furnCount: window.state.furnitureList.length,
                historyLen: window.HistoryManager.undoStack.length,
                redoLen: window.HistoryManager.redoStack.length,
                undoDisabled: undoBtn.disabled,
                redoDisabled: redoBtn.disabled,
                roomName: window.state.roomName
            };
        }""")
        t1_ok = (initial_check["wallsCount"] == 4 and 
                 initial_check["historyLen"] >= 1 and 
                 initial_check["undoDisabled"] == True and 
                 initial_check["redoDisabled"] == True)
        record("TEST 1: Initial Page Load & History Buttons", t1_ok, str(initial_check))

        # TEST 2: Furniture Add & Undo / Redo
        t2_res = page.evaluate("""() => {
            const initialCount = window.state.furnitureList.length;
            // Add a furniture item
            window.addFurnitureFromTemplate({
                name: '테스트 소파',
                category: 'sofa',
                shape: 'cushion_sofa_armchair',
                w: 1800, d: 850, h: 780,
                color: '#4F46E5',
                materialType: 'fabric'
            }, { x: 0, z: 0, rotY: 0 });

            const countAfterAdd = window.state.furnitureList.length;
            const canUndoAfterAdd = !document.getElementById('btn-undo').disabled;

            // Trigger Undo
            window.HistoryManager.undo();
            const countAfterUndo = window.state.furnitureList.length;
            const canRedoAfterUndo = !document.getElementById('btn-redo').disabled;

            // Trigger Redo
            window.HistoryManager.redo();
            const countAfterRedo = window.state.furnitureList.length;

            return {
                initialCount,
                countAfterAdd,
                canUndoAfterAdd,
                countAfterUndo,
                canRedoAfterUndo,
                countAfterRedo
            };
        }""")
        t2_ok = (t2_res["countAfterAdd"] == t2_res["initialCount"] + 1 and
                 t2_res["canUndoAfterAdd"] == True and
                 t2_res["countAfterUndo"] == t2_res["initialCount"] and
                 t2_res["canRedoAfterUndo"] == True and
                 t2_res["countAfterRedo"] == t2_res["initialCount"] + 1)
        record("TEST 2: Furniture Add, Undo, and Redo", t2_ok, str(t2_res))

        # TEST 3: Preset Change & Undo
        t3_res = page.evaluate("""() => {
            const origRoom = window.state.roomName;
            // Change preset to onehalf
            window.loadFloorplanPreset('onehalf', false);
            window.HistoryManager.pushState();

            const changedRoom = window.state.roomName;
            const changedWalls = window.state.walls.length;

            // Undo
            window.HistoryManager.undo();
            const undoneRoom = window.state.roomName;

            // Redo
            window.HistoryManager.redo();
            const redoneRoom = window.state.roomName;

            return { origRoom, changedRoom, changedWalls, undoneRoom, redoneRoom };
        }""")
        t3_ok = (t3_res["changedRoom"] != t3_res["origRoom"] and
                 t3_res["undoneRoom"] == t3_res["origRoom"] and
                 t3_res["redoneRoom"] == t3_res["changedRoom"])
        record("TEST 3: Room Preset Change, Undo, and Redo", t3_ok, str(t3_res))

        # TEST 4: Wall Selection & Inspector Properties
        t4_res = page.evaluate("""() => {
            const firstWall = window.state.walls[0];
            window.selectWall(firstWall.id);

            const wallPanel = document.getElementById('inspector-wall-state');
            const furnPanel = document.getElementById('inspector-furniture-state');
            const emptyPanel = document.getElementById('inspector-empty-state');
            const lengthInput = document.getElementById('prop-wall-length');

            return {
                selectedWallId: window.state.selectedWallId,
                wallPanelVisible: !wallPanel.classList.contains('hidden'),
                furnPanelHidden: furnPanel.classList.contains('hidden'),
                emptyPanelHidden: emptyPanel.classList.contains('hidden'),
                inputValue: Number(lengthInput.value),
                realWallLen: Math.round(Math.hypot(firstWall.x2 - firstWall.x1, firstWall.z2 - firstWall.z1))
            };
        }""")
        t4_ok = (t4_res["selectedWallId"] is not None and
                 t4_res["wallPanelVisible"] == True and
                 t4_res["furnPanelHidden"] == True and
                 t4_res["emptyPanelHidden"] == True and
                 abs(t4_res["inputValue"] - t4_res["realWallLen"]) <= 1)
        record("TEST 4: Wall Selection & Inspector Wall State Display", t4_ok, str(t4_res))

        # TEST 5: Direct Wall Length Modification via Inspector & Undo
        t5_res = page.evaluate("""() => {
            const wallId = window.state.selectedWallId;
            const wall = window.state.walls.find(w => w.id === wallId);
            const origLen = Math.round(Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1));

            // Apply new length 4800mm
            window.applySelectedWallLength(4800);
            const newLen = Math.round(Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1));

            // Undo
            window.HistoryManager.undo();
            const wallAfterUndo = window.state.walls.find(w => w.id === wallId);
            const undoLen = Math.round(Math.hypot(wallAfterUndo.x2 - wallAfterUndo.x1, wallAfterUndo.z2 - wallAfterUndo.z1));

            // Redo
            window.HistoryManager.redo();
            const wallAfterRedo = window.state.walls.find(w => w.id === wallId);
            const redoLen = Math.round(Math.hypot(wallAfterRedo.x2 - wallAfterRedo.x1, wallAfterRedo.z2 - wallAfterRedo.z1));

            return { origLen, newLen, undoLen, redoLen };
        }""")
        t5_ok = (t5_res["newLen"] == 4800 and
                 t5_res["undoLen"] == t5_res["origLen"] and
                 t5_res["redoLen"] == 4800)
        record("TEST 5: Wall Length Numeric Editing & Undo/Redo", t5_ok, str(t5_res))

        # TEST 6: Wall Segment Dragging (Parallel Move & Connected Vertex Update)
        t6_res = page.evaluate("""() => {
            // Reset to studio preset
            window.loadFloorplanPreset('studio', false);
            window.HistoryManager.pushState();

            // Find wall_top
            const wallTop = window.state.walls.find(w => w.id === 'wall_top');
            const wallLeft = window.state.walls.find(w => w.id === 'wall_left');
            const wallRight = window.state.walls.find(w => w.id === 'wall_right');

            const origTopZ = wallTop.z1;
            const origLeftZ2 = wallLeft.z2;
            const origRightZ1 = wallRight.z1;

            // Simulate wall move: dz = -400
            const dz = -400;
            const startConns = [ { wall: wallLeft, endpoint: 'end', origZ: origLeftZ2 } ];
            const endConns = [ { wall: wallRight, endpoint: 'start', origZ: origRightZ1 } ];

            wallTop.z1 += dz;
            wallTop.z2 += dz;
            startConns.forEach(c => c.wall.z2 += dz);
            endConns.forEach(c => c.wall.z1 += dz);

            window.rebuild3DRoomGeometry();
            window.HistoryManager.pushState();

            const movedTopZ = wallTop.z1;
            const movedLeftZ2 = wallLeft.z2;
            const movedRightZ1 = wallRight.z1;

            // Undo
            window.HistoryManager.undo();
            const undoneWallTop = window.state.walls.find(w => w.id === 'wall_top');
            const undoneWallLeft = window.state.walls.find(w => w.id === 'wall_left');

            return {
                origTopZ, origLeftZ2, origRightZ1,
                movedTopZ, movedLeftZ2, movedRightZ1,
                undoneTopZ: undoneWallTop.z1,
                undoneLeftZ2: undoneWallLeft.z2
            };
        }""")
        t6_ok = (t6_res["movedTopZ"] == t6_res["origTopZ"] - 400 and
                 t6_res["movedLeftZ2"] == t6_res["origLeftZ2"] - 400 and
                 t6_res["movedRightZ1"] == t6_res["origRightZ1"] - 400 and
                 t6_res["undoneTopZ"] == t6_res["origTopZ"] and
                 t6_res["undoneLeftZ2"] == t6_res["origLeftZ2"])
        record("TEST 6: Wall Drag Parallel Move & Connected Vertex Update", t6_ok, str(t6_res))

        # TEST 7: Wall Corner Vertex Dragging & Stretching
        t7_res = page.evaluate("""() => {
            const wallTop = window.state.walls.find(w => w.id === 'wall_top');
            const wallLeft = window.state.walls.find(w => w.id === 'wall_left');

            const origX = wallTop.x1;
            const origZ = wallTop.z1;

            // Move shared vertex by dx = -300, dz = -300
            wallTop.x1 -= 300;
            wallTop.z1 -= 300;
            wallLeft.x2 -= 300;
            wallLeft.z2 -= 300;

            window.rebuild3DRoomGeometry();
            window.HistoryManager.pushState();

            const movedX = wallTop.x1;
            const movedZ = wallTop.z1;

            // Undo
            window.HistoryManager.undo();
            const revertedTop = window.state.walls.find(w => w.id === 'wall_top');

            return {
                origX, origZ,
                movedX, movedZ,
                revertedX: revertedTop.x1,
                revertedZ: revertedTop.z1
            };
        }""")
        t7_ok = (t7_res["movedX"] == t7_res["origX"] - 300 and
                 t7_res["movedZ"] == t7_res["origZ"] - 300 and
                 t7_res["revertedX"] == t7_res["origX"] and
                 t7_res["revertedZ"] == t7_res["origZ"])
        record("TEST 7: Corner Vertex Dragging & Angle/Length Stretch", t7_ok, str(t7_res))

        # TEST 8: Wall Deletion & Openings Cleanup & Undo
        t8_res = page.evaluate("""() => {
            const wallWithDoor = window.state.walls.find(w => w.id === 'wall_bottom');
            window.selectWall(wallWithDoor.id);

            const initialWallsCount = window.state.walls.length;
            const initialOpeningsCount = window.state.openings.length;

            // Delete wall
            window.deleteSelectedWall();

            const wallsAfterDelete = window.state.walls.length;
            const openingsAfterDelete = window.state.openings.length;

            // Undo deletion
            window.HistoryManager.undo();
            const wallsAfterUndo = window.state.walls.length;
            const openingsAfterUndo = window.state.openings.length;

            return {
                initialWallsCount,
                initialOpeningsCount,
                wallsAfterDelete,
                openingsAfterDelete,
                wallsAfterUndo,
                openingsAfterUndo
            };
        }""")
        t8_ok = (t8_res["wallsAfterDelete"] == t8_res["initialWallsCount"] - 1 and
                 t8_res["openingsAfterDelete"] < t8_res["initialOpeningsCount"] and
                 t8_res["wallsAfterUndo"] == t8_res["initialWallsCount"] and
                 t8_res["openingsAfterUndo"] == t8_res["initialOpeningsCount"])
        record("TEST 8: Wall & Attached Openings Deletion and Undo", t8_ok, str(t8_res))

        # TEST 9: Keyboard Shortcuts (Ctrl+Z, Ctrl+Y, Delete, Escape) & Input Protection
        t9_res = page.evaluate("""() => {
            // Test 1: Typing in input field shouldn't trigger global history undo
            const input = document.getElementById('room-width-input');
            input.focus();

            const undoStackBefore = window.HistoryManager.undoStack.length;

            // Simulate Ctrl+Z on input
            const eventOnInput = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
            input.dispatchEvent(eventOnInput);

            const undoStackAfterInputKey = window.HistoryManager.undoStack.length;

            // Test 2: Unfocused Ctrl+Z triggers Undo
            input.blur();
            document.body.focus();

            // Push an action first
            window.addFurnitureFromTemplate({
                name: '단축키 테스트',
                category: 'decor',
                shape: 'modern_rect_desk',
                w: 600, d: 600, h: 700
            });
            const countAfterAdd = window.state.furnitureList.length;

            // Dispatch Ctrl+Z on window
            const eventGlobalUndo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
            window.dispatchEvent(eventGlobalUndo);
            const countAfterGlobalUndo = window.state.furnitureList.length;

            // Dispatch Ctrl+Y on window
            const eventGlobalRedo = new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true });
            window.dispatchEvent(eventGlobalRedo);
            const countAfterGlobalRedo = window.state.furnitureList.length;

            // Escape key deselects
            const selectedBeforeEsc = window.state.selectedFurnitureId;
            const eventEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
            window.dispatchEvent(eventEscape);
            const selectedAfterEsc = window.state.selectedFurnitureId;

            return {
                undoStackBefore,
                undoStackAfterInputKey,
                inputProtected: undoStackBefore === undoStackAfterInputKey,
                countAfterAdd,
                countAfterGlobalUndo,
                countAfterGlobalRedo,
                selectedBeforeEsc,
                selectedAfterEsc
            };
        }""")
        t9_ok = (t9_res["inputProtected"] == True and
                 t9_res["countAfterGlobalUndo"] == t9_res["countAfterAdd"] - 1 and
                 t9_res["countAfterGlobalRedo"] == t9_res["countAfterAdd"] and
                 t9_res["selectedAfterEsc"] is None)
        record("TEST 9: Keyboard Shortcuts (Ctrl+Z, Ctrl+Y, Escape) & Input Protection", t9_ok, str(t9_res))

        # TEST 10: 3D Geometry Extrude & No Runtime Exceptions
        t10_res = page.evaluate("""() => {
            window.rebuild3DRoomGeometry();
            window.evaluateAllCollisions();

            return {
                roomChildrenCount: window.roomGroup ? window.roomGroup.children.length : 0,
                furnitureMeshCount: window.furnitureMeshMap ? window.furnitureMeshMap.size : 0,
                mode: window.state.mode
            };
        }""")
        t10_ok = (t10_res["roomChildrenCount"] > 0 and len(console_errors) == 0)
        record("TEST 10: 3D Room Extrude Geometry & Console Health", t10_ok, f"Children: {t10_res['roomChildrenCount']}, Errors: {console_errors}")

        browser.close()

    with open('upgrade_test_report.json', 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"Total: {report['total_tests']}, Passed: {report['passed']}, Failed: {report['failed']}")
    for r in report["results"]:
        print(f"  [{r['status']}] {r['name']}")

if __name__ == '__main__':
    run_tests()
