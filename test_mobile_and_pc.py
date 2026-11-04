# test_mobile_and_pc.py
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

    html_path = os.path.abspath('index.html').replace('\\', '/')
    file_url = f"file:///{html_path}"

    with sync_playwright() as p:
        # ==============================================================
        # 1. DESKTOP / PC MODE TESTS (Viewport: 1440x900)
        # ==============================================================
        browser = p.chromium.launch(headless=True)
        desktop_page = browser.new_page(viewport={"width": 1440, "height": 900})

        desktop_errors = []
        desktop_page.on("console", lambda msg: desktop_errors.append(msg.text) if msg.type == "error" else None)
        desktop_page.on("pageerror", lambda err: desktop_errors.append(str(err)))

        desktop_page.goto(file_url, wait_until='networkidle')
        desktop_page.wait_for_timeout(800)

        # TEST 1: Desktop Default Layout & Device Toggle Pill
        t1_res = desktop_page.evaluate("""() => {
            const container = document.getElementById('app-container');
            const leftSidebar = document.getElementById('left-sidebar');
            const rightSidebar = document.getElementById('right-sidebar');
            const bottomBar = document.getElementById('mobile-bottom-bar');
            const toggleBtn = document.getElementById('btn-toggle-device-mode');

            const leftRect = leftSidebar.getBoundingClientRect();
            const rightRect = rightSidebar.getBoundingClientRect();
            const bottomStyle = window.getComputedStyle(bottomBar).display;

            return {
                deviceMode: window.state.deviceMode,
                hasPcClass: container.classList.contains('device-mode-pc'),
                leftWidth: leftRect.width,
                rightWidth: rightRect.width,
                bottomNavHidden: bottomStyle === 'none',
                toggleBtnVisible: !!toggleBtn
            };
        }""")
        t1_ok = (t1_res["leftWidth"] >= 340 and 
                 t1_res["rightWidth"] >= 300 and 
                 t1_res["bottomNavHidden"] == True and 
                 t1_res["toggleBtnVisible"] == True)
        record("TEST 1: Desktop PC Mode Docked Sidebars & Clean Layout", t1_ok, str(t1_res))

        # TEST 2: Manual Device Mode Switch (PC -> Mobile -> PC)
        t2_res = desktop_page.evaluate("""() => {
            const toggleBtn = document.getElementById('btn-toggle-device-mode');
            const bottomBar = document.getElementById('mobile-bottom-bar');

            // Switch to mobile mode
            toggleBtn.click();
            const modeAfter1 = window.state.deviceMode;
            const bottomDisplayAfter1 = window.getComputedStyle(bottomBar).display;

            // Switch back to PC mode
            toggleBtn.click();
            const modeAfter2 = window.state.deviceMode;
            const bottomDisplayAfter2 = window.getComputedStyle(bottomBar).display;

            return { modeAfter1, bottomDisplayAfter1, modeAfter2, bottomDisplayAfter2 };
        }""")
        t2_ok = (t2_res["modeAfter1"] == 'mobile' and 
                 t2_res["bottomDisplayAfter1"] != 'none' and 
                 t2_res["modeAfter2"] == 'pc' and 
                 t2_res["bottomDisplayAfter2"] == 'none')
        record("TEST 2: Manual Device Mode Toggle (PC <-> Mobile)", t2_ok, str(t2_res))

        desktop_page.close()

        # ==============================================================
        # 2. MOBILE PHONE TESTS (Emulating iPhone 14: 390x844 with Touch)
        # ==============================================================
        iphone_context = browser.new_context(
            viewport={"width": 390, "height": 844},
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
            has_touch=True,
            is_mobile=True
        )
        mobile_page = iphone_context.new_page()

        mobile_errors = []
        mobile_page.on("console", lambda msg: mobile_errors.append(msg.text) if msg.type == "error" else None)
        mobile_page.on("pageerror", lambda err: mobile_errors.append(str(err)))

        mobile_page.goto(file_url, wait_until='networkidle')
        mobile_page.wait_for_timeout(800)

        # TEST 3: Mobile Mode Auto-Detection & Full Width Viewport
        t3_res = mobile_page.evaluate("""() => {
            const container = document.getElementById('app-container');
            const centerVp = document.getElementById('center-viewport');
            const bottomBar = document.getElementById('mobile-bottom-bar');
            const leftSidebar = document.getElementById('left-sidebar');

            const vpRect = centerVp.getBoundingClientRect();
            const leftTransform = window.getComputedStyle(leftSidebar).transform;
            const bottomDisplay = window.getComputedStyle(bottomBar).display;

            return {
                deviceMode: window.state.deviceMode,
                isMobileClass: container.classList.contains('device-mode-mobile'),
                vpWidth: Math.round(vpRect.width),
                bottomBarVisible: bottomDisplay !== 'none',
                leftDrawerClosed: leftTransform.includes('matrix') || leftTransform.includes('translate')
            };
        }""")
        t3_ok = (t3_res["deviceMode"] == 'mobile' and 
                 t3_res["isMobileClass"] == True and 
                 abs(t3_res["vpWidth"] - 390) <= 2 and 
                 t3_res["bottomBarVisible"] == True)
        record("TEST 3: Mobile Phone Auto-Detection & Full Width Viewport", t3_ok, str(t3_res))

        # TEST 4: Mobile Left Drawer Open & Close (via Hamburger & Close Button)
        t4_res = mobile_page.evaluate("""() => {
            const btnMenu = document.getElementById('btn-mobile-menu');
            const leftSidebar = document.getElementById('left-sidebar');
            const btnCloseLeft = document.getElementById('btn-close-left-sidebar');
            const backdrop = document.getElementById('mobile-drawer-backdrop');

            // Open drawer
            btnMenu.click();
            const openedClass = leftSidebar.classList.contains('mobile-open');
            const backdropShown = !backdrop.classList.contains('hidden');

            // Close drawer
            btnCloseLeft.click();
            const closedClass = !leftSidebar.classList.contains('mobile-open');
            const backdropHidden = backdrop.classList.contains('hidden');

            return { openedClass, backdropShown, closedClass, backdropHidden };
        }""")
        t4_ok = (t4_res["openedClass"] == True and 
                 t4_res["backdropShown"] == True and 
                 t4_res["closedClass"] == True and 
                 t4_res["backdropHidden"] == True)
        record("TEST 4: Mobile Left Drawer Open, Close & Backdrop Integration", t4_ok, str(t4_res))

        # TEST 5: Mobile Bottom Bar Navigation (Catalog, 2D/3D Toggle, Undo)
        t5_res = mobile_page.evaluate("""() => {
            const mbCatalog = document.getElementById('mb-btn-catalog');
            const mbModeToggle = document.getElementById('mb-btn-mode-toggle');
            const leftSidebar = document.getElementById('left-sidebar');

            // 1. Open catalog from bottom bar
            mbCatalog.click();
            const catalogOpened = leftSidebar.classList.contains('mobile-open');

            // Close
            window.closeMobileDrawers();

            // 2. Toggle to 2D
            const initialMode = window.state.mode;
            mbModeToggle.click();
            const modeAfterToggle = window.state.mode;
            const mbLabelAfter = document.getElementById('mb-mode-label').textContent;

            return {
                catalogOpened,
                initialMode,
                modeAfterToggle,
                mbLabelAfter
            };
        }""")
        t5_ok = (t5_res["catalogOpened"] == True and 
                 t5_res["initialMode"] == '3d' and 
                 t5_res["modeAfterToggle"] == '2d')
        record("TEST 5: Mobile Bottom Bar Quick Controls & Viewport Toggle", t5_ok, str(t5_res))

        # TEST 6: 2D Mode Dedicated Pan Tool for Mobile Single-Finger Panning
        t6_res = mobile_page.evaluate("""() => {
            // Select pan tool
            window.setDrawTool('pan');
            const currentTool = window.state.drawTool;

            const canvas = document.getElementById('floorplan-canvas');
            const initialPanX = window.state.pan2D.x;
            const initialPanY = window.state.pan2D.y;

            // Simulate single finger touch drag on pan tool
            const downEvt = new PointerEvent('pointerdown', { pointerId: 101, pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true });
            const moveEvt = new PointerEvent('pointermove', { pointerId: 101, pointerType: 'touch', clientX: 260, clientY: 340, bubbles: true });
            const upEvt = new PointerEvent('pointerup', { pointerId: 101, pointerType: 'touch', clientX: 260, clientY: 340, bubbles: true });

            canvas.dispatchEvent(downEvt);
            window.dispatchEvent(moveEvt);
            window.dispatchEvent(upEvt);

            return {
                currentTool,
                initialPanX,
                initialPanY,
                movedPanX: window.state.pan2D.x,
                movedPanY: window.state.pan2D.y,
                dx: window.state.pan2D.x - initialPanX,
                dy: window.state.pan2D.y - initialPanY
            };
        }""")
        t6_ok = (t6_res["currentTool"] == 'pan' and 
                 t6_res["dx"] == 60 and 
                 t6_res["dy"] == 40)
        record("TEST 6: 2D Dedicated Pan Tool Single-Finger Drag Panning", t6_ok, str(t6_res))

        # TEST 7: 2D Multi-Touch Pinch-to-Zoom & Two-Finger Pan
        t7_res = mobile_page.evaluate("""() => {
            window.setDrawTool('select');
            const canvas = document.getElementById('floorplan-canvas');

            const initZoom = window.state.zoom2D;
            const initPanX = window.state.pan2D.x;

            // Two fingers down at dist = 100px
            const p1_down = new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300, bubbles: true });
            const p2_down = new PointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true });
            canvas.dispatchEvent(p1_down);
            canvas.dispatchEvent(p2_down);

            // Pinch apart to dist = 160px (Zoom in) and translate mid right by 20px
            const p1_move = new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 90, clientY: 300, bubbles: true });
            const p2_move = new PointerEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 300, bubbles: true });
            window.dispatchEvent(p1_move);
            window.dispatchEvent(p2_move);

            const zoomAfterPinch = window.state.zoom2D;
            const panXAfterPinch = window.state.pan2D.x;

            // Lift fingers
            const p1_up = new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true });
            const p2_up = new PointerEvent('pointerup', { pointerId: 2, pointerType: 'touch', bubbles: true });
            window.dispatchEvent(p1_up);
            window.dispatchEvent(p2_up);

            return {
                initZoom,
                zoomAfterPinch,
                isZoomedIn: zoomAfterPinch > initZoom,
                initPanX,
                panXAfterPinch
            };
        }""")
        t7_ok = (t7_res["isZoomedIn"] == True)
        record("TEST 7: 2D Multi-Touch Two-Finger Pinch-to-Zoom Gesture", t7_ok, str(t7_res))

        # TEST 8: Mobile Touch Tap on Furniture Auto-Opens Inspector Bottom Sheet
        t8_res = mobile_page.evaluate("""() => {
            window.closeMobileDrawers();
            const rightSidebar = document.getElementById('right-sidebar');

            // Select a furniture item (simulating touch tap on furniture)
            const firstFurn = window.state.furnitureList[0];
            window.selectFurniture(firstFurn.id);

            const isInspectorDrawerOpen = rightSidebar.classList.contains('mobile-open');

            // Close inspector
            const btnClose = document.getElementById('btn-close-inspector');
            btnClose.click();
            const isInspectorClosed = !rightSidebar.classList.contains('mobile-open');

            return { isInspectorDrawerOpen, isInspectorClosed };
        }""")
        t8_ok = (t8_res["isInspectorDrawerOpen"] == True and t8_res["isInspectorClosed"] == True)
        record("TEST 8: Mobile Touch Selection Auto-Opens Inspector Drawer", t8_ok, str(t8_res))

        # TEST 9: Mobile Touch-Action & Accessibility Target Sizing
        t9_res = mobile_page.evaluate("""() => {
            const threeCanvas = document.getElementById('three-canvas');
            const floorCanvas = document.getElementById('floorplan-canvas');

            const threeTouch = window.getComputedStyle(threeCanvas).touchAction;
            const floorTouch = window.getComputedStyle(floorCanvas).touchAction;

            const bottomNavBtn = document.querySelector('.mobile-nav-item');
            const btnRect = bottomNavBtn.getBoundingClientRect();

            return {
                threeTouchAction: threeTouch,
                floorTouchAction: floorTouch,
                btnHeight: btnRect.height,
                btnTouchCompliant: btnRect.height >= 40
            };
        }""")
        t9_ok = (t9_res["threeTouchAction"] == 'none' and 
                 t9_res["floorTouchAction"] == 'none' and 
                 t9_res["btnTouchCompliant"] == True)
        record("TEST 9: CSS Touch-Action 'none' & Mobile Touch Target Compliance", t9_ok, str(t9_res))

        iphone_context.close()

        # ==============================================================
        # 3. TABLET MODE TESTS (Emulating iPad Pro: 834x1194 with Touch)
        # ==============================================================
        ipad_context = browser.new_context(
            viewport={"width": 834, "height": 1194},
            user_agent="Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
            has_touch=True
        )
        tablet_page = ipad_context.new_page()

        tablet_errors = []
        tablet_page.on("console", lambda msg: tablet_errors.append(msg.text) if msg.type == "error" else None)
        tablet_page.on("pageerror", lambda err: tablet_errors.append(str(err)))

        tablet_page.goto(file_url, wait_until='networkidle')
        tablet_page.wait_for_timeout(800)

        t10_res = tablet_page.evaluate("""() => {
            const container = document.getElementById('app-container');
            const centerVp = document.getElementById('center-viewport');
            const vpRect = centerVp.getBoundingClientRect();

            // Switch to 3D mode
            window.switchViewportMode('3d');

            return {
                deviceMode: window.state.deviceMode,
                vpWidth: Math.round(vpRect.width),
                mode: window.state.mode,
                orbitControlsTouchDefined: !!window.controls && !!window.controls.touches
            };
        }""")
        t10_ok = (t10_res["vpWidth"] >= 800 and 
                  t10_res["mode"] == '3d' and 
                  len(desktop_errors) == 0 and 
                  len(mobile_errors) == 0 and 
                  len(tablet_errors) == 0)
        record("TEST 10: Tablet Responsive Viewport & Zero Console Errors Across All Devices", t10_ok, str(t10_res))

        ipad_context.close()
        browser.close()

    with open('mobile_test_report.json', 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\n==========================================")
    print(f"MOBILE & PC TEST RESULTS: {report['passed']}/{report['total_tests']} PASSED")
    print(f"==========================================")
    for r in report["results"]:
        print(f"  [{r['status']}] {r['name']}")

if __name__ == '__main__':
    run_tests()
