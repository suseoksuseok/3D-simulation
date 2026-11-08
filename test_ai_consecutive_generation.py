# test_ai_consecutive_generation.py
# -*- coding: utf-8 -*-
import sys
import os
import json
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

def run_ai_tests():
    html_path = os.path.abspath('index.html').replace('\\', '/')
    file_url = f"file:///{html_path}"

    report = {
        "total": 0,
        "passed": 0,
        "failed": 0,
        "tests": []
    }

    def record(name, passed, details=""):
        report["total"] += 1
        if passed:
            report["passed"] += 1
            status = "PASSED"
        else:
            report["failed"] += 1
            status = "FAILED"
        report["tests"].append({"name": name, "status": status, "details": details})
        print(f"  [{status}] {name} -> {details}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        console_errors = []
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        page.goto(file_url, wait_until="networkidle")
        page.wait_for_timeout(400)

        # Open Tab 3: AI Furniture Studio
        page.click(".sidebar-tab[data-tab='tab-ai-studio']")
        page.wait_for_timeout(200)

        # TEST 1: Image Upload & Immediate Overwrite on Second Upload
        t1_res = page.evaluate("""async () => {
            function createColorImageFile(hexColor, fileName) {
                const c = document.createElement('canvas');
                c.width = 128;
                c.height = 128;
                const ctx = c.getContext('2d');
                ctx.fillStyle = hexColor;
                ctx.fillRect(0, 0, 128, 128);
                const dataUrl = c.toDataURL('image/png');
                const byteString = atob(dataUrl.split(',')[1]);
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) {
                    ia[i] = byteString.charCodeAt(i);
                }
                const blob = new Blob([ab], { type: 'image/png' });
                return new File([blob], fileName, { type: 'image/png' });
            }

            // 1. Upload Red Image (#CC3333)
            const file1 = createColorImageFile('#CC3333', 'red_chair.png');
            window.handleAIImageUpload(file1);
            await new Promise(r => setTimeout(r, 250));

            const base64_1 = window.state.aiUploadedBase64;
            const hex_1 = window.state.aiExtractedHex;
            const previewVisible_1 = !document.getElementById('ai-preview-wrap').classList.contains('hidden');

            // 2. Immediately Upload Blue Image (#3366CC) without manual reset
            const file2 = createColorImageFile('#3366CC', 'blue_sofa.png');
            window.handleAIImageUpload(file2);
            await new Promise(r => setTimeout(r, 250));

            const base64_2 = window.state.aiUploadedBase64;
            const hex_2 = window.state.aiExtractedHex;
            const fileInputVal = document.getElementById('ai-image-input').value;

            return {
                hasBase64_1: !!base64_1,
                hasBase64_2: !!base64_2,
                base64Changed: base64_1 !== base64_2,
                hex_1,
                hex_2,
                hexChanged: hex_1 !== hex_2,
                previewVisible_1,
                fileInputCleared: fileInputVal === ''
            };
        }""")
        t1_ok = (
            t1_res["hasBase64_1"] and
            t1_res["hasBase64_2"] and
            t1_res["base64Changed"] and
            t1_res["hexChanged"] and
            t1_res["fileInputCleared"]
        )
        record("TEST 1: Immediate Image Overwrite & Color Re-Extraction on Second Upload", t1_ok, str(t1_res))

        # TEST 2: Manual Reset Button ([🔄 입력 초기화]) & resetAIGeneratorState Memory Cleanup
        t2_res = page.evaluate("""() => {
            document.getElementById('ai-furn-name').value = '임시 테스트 가구';
            document.getElementById('ai-extra-prompt').value = '임시 프롬프트 지시사항';

            // Click the manual reset button
            document.getElementById('btn-reset-ai-generator').click();

            const fileInputVal = document.getElementById('ai-image-input').value;
            const base64After = window.state.aiUploadedBase64;
            const objUrlAfter = window.state.aiPreviewObjectUrl;
            const tempImgAfter = window.state.aiTempImage;
            const tempCanvasAfter = window.state.aiTempCanvas;
            const nameVal = document.getElementById('ai-furn-name').value;
            const promptVal = document.getElementById('ai-extra-prompt').value;
            const promptVisible = !document.getElementById('ai-dropzone-prompt').classList.contains('hidden');
            const previewHidden = document.getElementById('ai-preview-wrap').classList.contains('hidden');
            const dropzoneText = document.querySelector('#ai-dropzone-prompt span').textContent;

            return {
                fileInputVal,
                base64After,
                objUrlAfter,
                tempImgAfter,
                tempCanvasAfter,
                nameVal,
                promptVal,
                promptVisible,
                previewHidden,
                dropzoneText
            };
        }""")
        t2_ok = (
            t2_res["fileInputVal"] == "" and
            t2_res["base64After"] is None and
            t2_res["objUrlAfter"] is None and
            t2_res["tempImgAfter"] is None and
            t2_res["tempCanvasAfter"] is None and
            t2_res["nameVal"] == "" and
            t2_res["promptVal"] == "" and
            t2_res["promptVisible"] is True and
            t2_res["previewHidden"] is True and
            "새 가구 이미지를 드래그하세요" in t2_res["dropzoneText"]
        )
        record("TEST 2: Manual Reset Button & Complete Memory/Form Cleanup", t2_ok, str(t2_res))

        # TEST 3: Stateless Independent AI API Calls (Zero Context Accumulation)
        t3_res = page.evaluate("""async () => {
            const capturedPayloads = [];
            const origFetch = window.fetch;

            window.fetch = async (url, options) => {
                const bodyObj = JSON.parse(options.body);
                capturedPayloads.push(bodyObj);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            content: {
                                parts: [{
                                    text: JSON.stringify({
                                        parts: [
                                            { name: 'top', shape: 'box', size: [600, 40, 600], position: [0, 500, 0], rotation: [0,0,0], color: '#CC3333', materialType: 'wood' }
                                        ]
                                    })
                                }]
                            }
                        }]
                    })
                };
            };

            try {
                window.state.aiConfig.provider = 'gemini';
                window.state.aiConfig.geminiApiKey = 'TEST_DUMMY_KEY_123';

                await window.callAIBlueprintAPI('BASE64_IMAGE_FIRST', 'image/png', '첫번째 레드 스툴', 500, 500, 450, 'round_slanted_table', '다리 3개 스툴');
                await window.callAIBlueprintAPI('BASE64_IMAGE_SECOND', 'image/jpeg', '두번째 블루 소파', 1800, 850, 780, 'cushion_sofa_armchair', '푹신한 팔걸이 소파');

                const p1 = capturedPayloads[0];
                const p2 = capturedPayloads[1];

                const p1Str = JSON.stringify(p1);
                const p2Str = JSON.stringify(p2);

                return {
                    callCount: capturedPayloads.length,
                    p1ContentsCount: p1.contents.length,
                    p2ContentsCount: p2.contents.length,
                    p1HasFirstOnly: p1Str.includes('BASE64_IMAGE_FIRST') && !p1Str.includes('BASE64_IMAGE_SECOND'),
                    p2HasSecondOnly: p2Str.includes('BASE64_IMAGE_SECOND') && !p2Str.includes('BASE64_IMAGE_FIRST') && !p2Str.includes('첫번째 레드 스툴') && !p2Str.includes('다리 3개 스툴')
                };
            } finally {
                window.fetch = origFetch;
                window.state.aiConfig.provider = 'smart_preset';
                window.state.aiConfig.geminiApiKey = '';
            }
        }""")
        t3_ok = (
            t3_res["callCount"] == 2 and
            t3_res["p1ContentsCount"] == 1 and
            t3_res["p2ContentsCount"] == 1 and
            t3_res["p1HasFirstOnly"] is True and
            t3_res["p2HasSecondOnly"] is True
        )
        record("TEST 3: Stateless Independent AI API Requests (No History Contamination)", t3_ok, str(t3_res))

        # TEST 4: Consecutive Multi-Furniture Generation, Auto-Reset, Unique IDs & Scene Persistence
        t4_res = page.evaluate("""async () => {
            function makeImg(hex, name) {
                const c = document.createElement('canvas');
                c.width = 128; c.height = 128;
                const ctx = c.getContext('2d');
                ctx.fillStyle = hex;
                ctx.fillRect(0, 0, 128, 128);
                const b64 = c.toDataURL('image/png').split(',')[1];
                const bin = atob(b64);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                return new File([new Blob([arr], { type: 'image/png' })], name, { type: 'image/png' });
            }

            const initialCount = window.state.furnitureList.length;

            // --- First Furniture Generation ---
            window.handleAIImageUpload(makeImg('#D97706', 'amber_table.png'));
            await new Promise(r => setTimeout(r, 150));
            document.getElementById('ai-furn-name').value = '연속생성 가구 1호';
            document.getElementById('ai-extra-prompt').value = '1호 전용 프롬프트';

            await window.triggerAIFurnitureGeneration();

            const toastAfter1 = document.getElementById('toast-notification').textContent;
            const autoResetBase64After1 = window.state.aiUploadedBase64;
            const autoResetPromptAfter1 = document.getElementById('ai-extra-prompt').value;
            const autoResetNameAfter1 = document.getElementById('ai-furn-name').value;
            const btnDisabledAfter1 = document.getElementById('btn-generate-ai-furniture').disabled;

            // --- Second Furniture Generation ---
            window.handleAIImageUpload(makeImg('#2563EB', 'cobalt_sofa.png'));
            await new Promise(r => setTimeout(r, 150));
            document.getElementById('ai-furn-name').value = '연속생성 가구 2호';
            document.getElementById('ai-extra-prompt').value = '2호 전용 프롬프트';

            await window.triggerAIFurnitureGeneration();

            const presetSelectRemoved = document.getElementById('ai-furn-shape') === null;

            const finalCount = window.state.furnitureList.length;
            const aiItems = window.state.furnitureList.filter(f => f.name === '연속생성 가구 1호' || f.name === '연속생성 가구 2호');
            const item1 = aiItems.find(f => f.name === '연속생성 가구 1호');
            const item2 = aiItems.find(f => f.name === '연속생성 가구 2호');

            const mesh1Exists = item1 ? window.furnitureMeshMap.has(item1.id) : false;
            const mesh2Exists = item2 ? window.furnitureMeshMap.has(item2.id) : false;

            return {
                addedCount: finalCount - initialCount,
                toastAfter1,
                autoResetBase64After1,
                autoResetPromptAfter1,
                autoResetNameAfter1,
                btnDisabledAfter1,
                id1: item1 ? item1.id : null,
                id2: item2 ? item2.id : null,
                uniqueIds: item1 && item2 ? (item1.id !== item2.id && item1.id.startsWith('ai_furniture_') && item2.id.startsWith('ai_furniture_')) : false,
                colorsDistinct: item1 && item2 ? (item1.color !== item2.color) : false,
                mesh1Exists,
                mesh2Exists
            };
        }""")
        t4_ok = (
            t4_res["addedCount"] == 2 and
            "다음 가구 이미지를 업로드할 수 있습니다" in t4_res["toastAfter1"] and
            t4_res["autoResetBase64After1"] is None and
            t4_res["autoResetPromptAfter1"] == "" and
            t4_res["autoResetNameAfter1"] == "" and
            t4_res["btnDisabledAfter1"] is False and
            t4_res["uniqueIds"] is True and
            t4_res["colorsDistinct"] is True and
            t4_res["mesh1Exists"] is True and
            t4_res["mesh2Exists"] is True
        )
        record("TEST 4: Consecutive Generation Auto-Reset, Unique IDs & 3D Scene Coexistence", t4_ok, str(t4_res))

        # TEST 5: Lock Release (finally block) Guarantee on API Error
        t5_res = page.evaluate("""async () => {
            window.state.aiConfig.provider = 'gemini';
            window.state.aiConfig.geminiApiKey = ''; // Missing key triggers error in callAIBlueprintAPI

            await window.triggerAIFurnitureGeneration();

            const isLocked = window.state.isGeneratingAI;
            const isBtnDisabled = document.getElementById('btn-generate-ai-furniture').disabled;
            const isLoadingHidden = document.getElementById('ai-loading-box').classList.contains('hidden');

            return { isLocked, isBtnDisabled, isLoadingHidden };
        }""")
        t5_ok = (
            t5_res["isLocked"] is False and
            t5_res["isBtnDisabled"] is False and
            t5_res["isLoadingHidden"] is True and
            len(console_errors) == 0
        )
        record("TEST 5: Finally Block Lock Release & Error Recovery Guarantee", t5_ok, str(t5_res))

        browser.close()

    print(f"\n==========================================")
    print(f"AI CONSECUTIVE GENERATION TESTS: {report['passed']}/{report['total']} PASSED")
    print(f"==========================================")
    assert report["failed"] == 0, f"{report['failed']} tests failed!"

if __name__ == "__main__":
    run_ai_tests()
