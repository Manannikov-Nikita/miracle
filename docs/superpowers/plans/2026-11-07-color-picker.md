# Miracle Color Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Replace native color selectors with a shared Miracle picker and add saved palette settings.

**Architecture:** Shared React color controls and color conversion helpers; a validated browser-local external store shared between picker and settings. Existing #RRGGBB document contracts stay intact.

**Tech Stack:** React 19, TypeScript, existing Radix primitives, Phosphor icons, Vitest/jsdom.

**Spec:** docs/superpowers/specs/2026-11-07-color-picker-design.md

## Global Constraints

- Preserve unrelated dirty work, existing board data and server APIs; no commits or release.
- Personal palette persists per browser origin, within that origin; max 64 colors.
- Reuse Miracle color/font/spacing tokens; no new dependencies.
- Existing color payloads remain #RRGGBB or supported transparent literal.

## Review Focus

- Invalid numeric/HEX drafts must never emit invalid document colors.
- Achromatic HSV editing must retain hue and saturation intent.
- Nested modal focus, Escape and canvas shortcuts must remain isolated.
- Corrupt/blocked storage and cross-tab updates must not crash or silently lose user edits.
- Popover placement and pointer drag must work at viewport edges and narrow widths.

### Task 1: Palette persistence and settings

Files: src/client/colors/saved-colors.ts, ColorSettings.tsx, color-settings.css; tests/saved-colors.test.ts, color-settings.test.ts.
Interfaces: SavedColor { id, name, color }; useSavedColors() returns colors,error,add(color,name?),update(id,patch),remove(id),move(id,-1|1). ColorSettings({open,onOpenChange}). ColorPicker shared component consumed by settings for editing.
- [x] Test add/dedup/update/remove/order/reload, corrupt and blocked storage, cross-tab delivery.
- [x] Implement validated synchronous persistence and settings UI with accessible buttons/fields.
- [x] Run store/settings tests.

### Task 2: Shared picker

Files: src/client/colors/ColorPicker.tsx, color-picker.css, color-values.ts and focused tests.
Interface: ColorPicker({value,onChange,label,disabled?,allowTransparent?,compact?,className?}); valid values only, no native color input.
- [x] Test conversion vectors, invalid drafts, keyboard controls, save/apply palette, Escape/focus, transparency and eyedropper cancellation.
- [x] Implement HSV surface, hue slider, HEX/RGB/HSL input, preview and palette.
- [x] Run picker tests and typecheck.

### Task 3: Existing editor integration

Files: ShapeSettings.tsx, ChartColors.tsx, PresentationSlides.tsx, WorkspaceRail.tsx, App.tsx and existing relevant tests.
- [x] Replace existing native selectors using shared component, preserve disabled state and existing persistence callbacks.
- [x] Add gear bottom-left and mount settings dialog with focus restoration.
- [x] Verify integration tests and typecheck; review diff.
- [x] Verify actual UI in browser at desktop/narrow widths using synthetic fixtures; capture picker/settings screenshots.


## Проверка результата

- Полный набор: `npm test` — 169 файлов / 2155 тестов, все прошли. Лог: `.local/release-0.9.0/color-full-tests.log`.
- `npm run typecheck` — client и server прошли. Четыре новых набора — 39 тестов.
- Независимая проверка нашла отклонённое изменение цвета и потерю HSL-оттенка на сером. Оба случая исправлены с регрессиями. Черновик имени также сохраняется при обновлении из другой вкладки.
- Браузер: проверены перетаскивание HSV, RGB-ввод, сохранение и переименование образцов, порядок, сохранение после reload, отклонение дубликата без ложного предпросмотра, вложенный Escape, возврат фокуса.
- На ширинах 1280, 375 и 320 пикер помещается в окно без горизонтальной прокрутки. Исправлена привязка первого открытия к кнопке после монтирования Radix Portal и специфичность CSS формы настроек.
- Основной стенд `http://127.0.0.1:3078/` показывает шестерёнку и рабочий диалог. Изменения палитры проверялись в отдельном origin localhost на синтетическом макете; пользовательские объекты не изменялись.
- Снимки: `.local/release-0.9.0/color-picker.png`, `color-settings.png`, `color-settings-live.png`.
- Решения реализации: общий пикер сохраняет существующие внешние HEX-поля; прозрачность цвета не расширяет формат документов, остаётся прежняя настройка фигуры. Пипетка использует доступность EyeDropper; физический системный выбор пикселя не проверялся, отмена и поздний ответ покрыты тестами.
