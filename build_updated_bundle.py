# build_updated_bundle.py
# -*- coding: utf-8 -*-
import sys
import os

with open('style.css', 'r', encoding='utf-8') as f:
    style_content = f.read()

with open('app.js', 'r', encoding='utf-8') as f:
    app_content = f.read()

with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Update Header Left with mobile menu button
old_header_left = '''      <div class="header-left">
        <div class="brand-logo">'''

new_header_left = '''      <div class="header-left">
        <button id="btn-mobile-menu" class="header-action-btn mobile-menu-btn" title="메뉴 열기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div class="brand-logo">'''

if 'id="btn-mobile-menu"' not in html:
    assert old_header_left in html, "old_header_left not found"
    html = html.replace(old_header_left, new_header_left, 1)

# 2. Update Header Right with device mode toggle button
old_header_right = '''      <div class="header-right">
        <button id="btn-undo"'''

new_header_right = '''      <div class="header-right">
        <button id="btn-toggle-device-mode" class="device-mode-toggle" title="PC 모드 / 모바일 모드 전환">
          <span class="device-icon-pc">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            PC 모드
          </span>
          <span class="device-icon-mobile">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line>
            </svg>
            모바일 모드
          </span>
        </button>
        <button id="btn-undo"'''

if 'id="btn-toggle-device-mode"' not in html:
    assert old_header_right in html, "old_header_right not found"
    html = html.replace(old_header_right, new_header_right, 1)

# 3. Add mobile close header to left sidebar
old_left_sidebar = '''      <aside id="left-sidebar">
        <div class="sidebar-tabs">'''

new_left_sidebar = '''      <aside id="left-sidebar">
        <div class="sidebar-header-mobile">
          <span>가구 &amp; 공간 카탈로그</span>
          <button id="btn-close-left-sidebar" class="drawer-close-btn" title="닫기">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="sidebar-tabs">'''

if 'id="btn-close-left-sidebar"' not in html:
    assert old_left_sidebar in html, "old_left_sidebar not found"
    html = html.replace(old_left_sidebar, new_left_sidebar, 1)

# 4. Add Pan tool to left sidebar tool-palette
old_erase_tool = '''              <button class="draw-tool-btn danger-outline" data-tool="erase"'''
pan_tool_markup = '''              <button class="draw-tool-btn" data-tool="pan" title="화면 자유 이동(Pan)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
                <span>화면 이동 (Pan)</span>
              </button>\n'''

if 'data-tool="pan"' not in html:
    assert old_erase_tool in html, "old_erase_tool not found"
    html = html.replace(old_erase_tool, pan_tool_markup + old_erase_tool, 1)

# 5. Add Pan tool chip to hud-2d-tools
old_hud_erase = '''              <button class="hud-tool-chip" data-tool="erase">'''
hud_pan_chip = '''              <button class="hud-tool-chip" data-tool="pan">✋ 이동</button>\n'''
if 'data-tool="pan"' not in html[html.find('hud-2d-tools'):html.find('hud-2d-tools')+500]:
    html = html.replace(old_hud_erase, hud_pan_chip + old_hud_erase, 1)

# 6. Add mobile drawer backdrop before center-viewport
old_center_viewport = '''      <!-- ==================== 중앙 메인 뷰포트 영역 ==================== -->
      <main id="center-viewport">'''

new_center_viewport = '''      <!-- 모바일 드로어 배경 딤 처리 -->
      <div id="mobile-drawer-backdrop" class="drawer-backdrop hidden"></div>

      <!-- ==================== 중앙 메인 뷰포트 영역 ==================== -->
      <main id="center-viewport">'''

if 'id="mobile-drawer-backdrop"' not in html:
    assert old_center_viewport in html, "old_center_viewport not found"
    html = html.replace(old_center_viewport, new_center_viewport, 1)

# 7. Add close button in right-sidebar header
old_inspector_header = '''        <div class="right-panel-header">
          <h2>상세 속성 제어창</h2>'''

new_inspector_header = '''        <div class="right-panel-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <button id="btn-close-inspector" class="drawer-close-btn" title="닫기">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
            <h2>상세 속성 제어창</h2>
          </div>'''

if 'id="btn-close-inspector"' not in html:
    assert old_inspector_header in html, "old_inspector_header not found"
    html = html.replace(old_inspector_header, new_inspector_header, 1)

# 8. Add mobile-bottom-bar before closing #app-container
mobile_bottom_bar_html = '''
    <!-- 모바일/태블릿 하단 플로팅 네비게이션 바 -->
    <nav id="mobile-bottom-bar" class="mobile-bottom-nav">
      <button id="mb-btn-catalog" class="mobile-nav-item" title="가구/구조 메뉴">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        <span>가구/구조</span>
      </button>
      <button id="mb-btn-mode-toggle" class="mobile-nav-item" title="2D/3D 뷰 전환">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        <span id="mb-mode-label">2D 도면</span>
      </button>
      <button id="mb-btn-tools" class="mobile-nav-item" title="도면 도구">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2.5"/><circle cx="20" cy="4" r="2.5"/></svg>
        <span>도구</span>
      </button>
      <button id="mb-btn-inspector" class="mobile-nav-item" title="상세 속성창">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>속성창</span>
      </button>
      <button id="mb-btn-undo" class="mobile-nav-item" title="되돌리기">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        <span>되돌리기</span>
      </button>
    </nav>
'''

old_app_container_end = '''      </aside>
    </div>
  </div>'''

new_app_container_end = '''      </aside>
    </div>
''' + mobile_bottom_bar_html + '''  </div>'''

if 'id="mobile-bottom-bar"' not in html:
    assert old_app_container_end in html, "old_app_container_end not found"
    html = html.replace(old_app_container_end, new_app_container_end, 1)

# 9. Update <style>...</style> with style_content
style_start = html.find('<style>')
style_end = html.find('</style>')
assert style_start != -1 and style_end != -1, "style tags not found"
html = html[:style_start + len('<style>\n')] + style_content + '\n' + html[style_end:]

# 10. Update <script>...</script> with app_content
all_script_starts = [i for i in range(len(html)) if html.startswith('<script>', i)]
app_script_start = all_script_starts[-1]
app_script_end = html.find('</script>', app_script_start)
assert app_script_start != -1 and app_script_end != -1, "script tags not found"
html = html[:app_script_start + len('<script>\n')] + app_content + '\n' + html[app_script_end:]

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("index.html fully updated with mobile & tablet features! New size:", len(html))
