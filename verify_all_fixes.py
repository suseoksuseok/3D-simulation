import os
import json
from playwright.sync_api import sync_playwright

html_file = os.path.abspath(r"c:\Users\oem\OneDrive\바탕 화면\3D website\index.html")
file_url = f"file:///{html_file.replace(os.sep, '/')}"

test_report = {
    "tests_run": 0,
    "tests_passed": 0,
    "tests_failed": 0,
    "details": []
}

def log_test(name, passed, message=""):
    test_report["tests_run"] += 1
    if passed:
        test_report["tests_passed"] += 1
        status = "PASSED"
    else:
        test_report["tests_failed"] += 1
        status = "FAILED"
    test_report["details"].append({
        "test": name,
        "status": status,
        "message": message
    })

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto(file_url, wait_until="networkidle")
    page.wait_for_timeout(500)

    # TEST 1: Initial Render & Canvases
    t1 = page.locator("#three-canvas").is_visible() and page.locator("#floorplan-canvas").count() > 0
    log_test("3D & 2D Canvas Initialization", t1, "Both WebGL and 2D floorplan canvases are initialized")

    # TEST 2: Presets (4 Types)
    p1 = page.locator("#hud-room-text").inner_text()
    page.click(".preset-card[data-preset='onehalf']")
    page.wait_for_timeout(200)
    p2 = page.locator("#hud-room-text").inner_text()
    page.click(".preset-card[data-preset='aptbed']")
    page.wait_for_timeout(200)
    p3 = page.locator("#hud-room-text").inner_text()
    page.click(".preset-card[data-preset='lshape']")
    page.wait_for_timeout(200)
    p4 = page.locator("#hud-room-text").inner_text()
    page.click(".preset-card[data-preset='studio']")
    page.wait_for_timeout(200)
    log_test("Preset Loading (Studio, 1.5Room, Apt, LShape)", "1.5룸" in p2 and "국민평형" in p3 and "ㄱ자형" in p4, "All presets load geometry and update room name")

    # TEST 3: Persistent Placed Furniture List in Inspector (FIX 7)
    # Check that .placed-list is visible and has items even when an item is selected
    placed_items = page.locator("#inspector-furniture-state .placed-list .placed-item-row")
    item_count = placed_items.count()
    log_test("Persistent Placed List When Selected (FIX 7)", item_count > 0, f"Found {item_count} items in persistent placed list while furniture is selected")

    # Switch selection using the persistent list
    if item_count > 1:
        placed_items.nth(1).click()
        page.wait_for_timeout(200)
        selected_name = page.locator("#prop-item-name").inner_text()
        log_test("Switch Furniture via Placed List (FIX 7)", len(selected_name) > 0, f"Switched to '{selected_name}' directly from placed list")

    # TEST 4: Smooth Non-Destructive Color Picker Update (FIX 4)
    page.fill("#prop-color-picker", "#3b82f6")
    page.wait_for_timeout(100)
    hex_disp = page.locator("#prop-color-hex").inner_text()
    log_test("Color Picker Live Update (FIX 4)", hex_disp == "#3B82F6", f"Hex color updated to {hex_disp}")

    # TEST 5: 2D Wall Drawing & Accurate Erase (FIX 2)
    page.click("#btn-mode-2d")
    page.wait_for_timeout(300)
    # Check canvas cursor class
    cursor_cls = page.locator("#floorplan-canvas").get_attribute("class")
    log_test("2D Canvas Cursor Mode", "cursor-" in (cursor_cls or ""), f"Canvas class is '{cursor_cls}'")

    # Switch to wall tool
    page.click(".hud-tool-chip[data-tool='wall']")
    page.wait_for_timeout(100)
    canvas = page.locator("#floorplan-canvas")
    cbox = canvas.bounding_box()

    # Draw a custom wall
    sx = cbox["x"] + cbox["width"] / 2
    sy = cbox["y"] + cbox["height"] / 2
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 150, sy)
    page.mouse.up()
    page.wait_for_timeout(200)
    wall_count_after_draw = page.evaluate("state.walls.length")
    log_test("2D Wall Drawing Tool", wall_count_after_draw > 4, f"Walls count after drawing: {wall_count_after_draw}")

    # Test Erase Tool with Point-to-Segment distance anywhere along the wall (FIX 2)
    page.click(".hud-tool-chip[data-tool='erase']")
    page.wait_for_timeout(100)
    # Click on the wall segment drawn (offset from start)
    page.mouse.click(sx + 75, sy)
    page.wait_for_timeout(200)
    wall_count_after_erase = page.evaluate("state.walls.length")
    log_test("2D Wall Accurate Erase (FIX 2)", wall_count_after_erase < wall_count_after_draw, f"Walls count decreased to {wall_count_after_erase} upon clicking along segment")

    # TEST 6: Clear 2D Walls Resets Floor Polygon (FIX 3)
    page.click("#btn-clear-2d-walls")
    page.wait_for_timeout(200)
    poly_len = page.evaluate("state.floorPolygon.length")
    log_test("Clear 2D Walls Resets Floor Polygon (FIX 3)", poly_len == 0, f"state.floorPolygon length is {poly_len}")

    # Re-apply preset to restore clean room
    page.click(".preset-card[data-preset='studio']")
    page.wait_for_timeout(200)
    page.click("#btn-2d-to-3d-extrude")
    page.wait_for_timeout(200)

    # TEST 7: AI JSON Blueprint Extraction from Conversational LLM Text (FIX 1)
    parse_test_1 = page.evaluate("""
        (() => {
            const raw1 = "Sure! Here is the JSON structure:\\n```json\\n{\\"parts\\": [{\\"name\\":\\"leg\\",\\"shape\\":\\"cylinder\\",\\"size\\":[20,20,500]}]}\\n```\\nHope this helps!";
            const parsed1 = extractJsonFromAiResponse(raw1);
            return parsed1 && parsed1.parts && parsed1.parts.length === 1;
        })()
    """)
    parse_test_2 = page.evaluate("""
        (() => {
            const raw2 = "{\\"parts\\": [{\\"name\\":\\"top\\",\\"shape\\":\\"box\\",\\"size\\":[800,40,800]}]}";
            const parsed2 = extractJsonFromAiResponse(raw2);
            return parsed2 && parsed2.parts && parsed2.parts.length === 1;
        })()
    """)
    log_test("Robust LLM JSON Extraction (FIX 1)", parse_test_1 and parse_test_2, "Successfully extracts JSON from conversational LLM response and raw JSON")

    # TEST 8: AI Generator 3D Assembly & Vault
    page.click(".sidebar-tab[data-tab='tab-ai-studio']")
    page.wait_for_timeout(200)
    page.fill("#ai-furn-name", "북유럽 원목 테이블")
    page.click("#btn-generate-ai-furniture")
    page.wait_for_timeout(1500)
    vault_count = page.evaluate("state.aiVault.length")
    log_test("AI Generator 3D Assembly & Vault", vault_count > 0, f"Created AI furniture and saved in Vault (vault items: {vault_count})")

    # TEST 9: GLB Model Caching and Clone Re-placement (FIX 5)
    glb_vault_test = page.evaluate("""
        (() => {
            try {
                // Simulate GLB model caching
                const dummyScene = new THREE.Group();
                const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
                dummyScene.add(m);

                const glbId = 'glb_test_cache_' + Date.now();
                state.glbModelCache.set(glbId, dummyScene);

                const glbTemplate = {
                    id: glbId,
                    catalogId: glbId,
                    name: 'GLB 3D Cache Model',
                    shape: 'glb_custom',
                    isGLB: true,
                    isAI: true,
                    w: 600, d: 600, h: 600
                };

                const placed = addFurnitureFromTemplate(glbTemplate);
                const mesh = furnitureMeshMap.get(placed.id);
                return mesh && mesh.getObjectByName('VisualMeshes') !== null;
            } catch(e) {
                return false;
            }
        })()
    """)
    log_test("GLB Model Caching & Re-placement (FIX 5)", glb_vault_test, "Successfully cloned and placed GLB model from cache")

    # TEST 10: Escape Key Deselection (FIX 9)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    selected_id_after_esc = page.evaluate("state.selectedFurnitureId")
    log_test("Escape Key Deselection (FIX 9)", selected_id_after_esc is None, f"Selected furniture ID after Escape is {selected_id_after_esc}")

    # TEST 11: Collision Detection with 900mm Door Swing
    door_collision_test = page.evaluate("""
        (() => {
            // Find a furniture item and place directly inside door zone (bottom wall, x = -875, z = 2250)
            if (state.furnitureList.length === 0) return false;
            const item = state.furnitureList[0];
            item.x = -875;
            item.z = 2100;
            const mesh = furnitureMeshMap.get(item.id);
            if (mesh) {
                mesh.position.x = item.x * 0.001;
                mesh.position.z = item.z * 0.001;
            }
            evaluateAllCollisions();
            return item.isColliding === true;
        })()
    """)
    log_test("900mm Door Swing Collision Detection", door_collision_test, "Furniture inside door swing zone correctly triggers isColliding warning")

    browser.close()

with open(r"c:\Users\oem\OneDrive\바탕 화면\3D website\verification_report.json", "w", encoding="utf-8") as f:
    json.dump(test_report, f, indent=2, ensure_ascii=False)

print(f"=== VERIFICATION RESULTS: {test_report['tests_passed']}/{test_report['tests_run']} PASSED ===")
