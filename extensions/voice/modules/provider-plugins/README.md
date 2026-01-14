# Voice Provider Plugins Module

Loads voice provider manifests and compat modules from the voice extension plugin roots.

## Multi-Root Resolution

This module supports loading plugins from multiple root directories in priority order:
1. External roots from `llm-adapter.paths.json` (if configured)
2. `PACKAGE_ROOT/extensions/voice/plugins` (production/dist)
3. `cwd/extensions/voice/plugins` (development/source fallback)

**Manifest loading:** Manifests are loaded from all roots and combined. Duplicate provider IDs throw an error to prevent silent conflicts.

**Compat module resolution:** Uses first-match-wins across roots via `resolveModuleEntryAcrossRoots()`.

## Internal Structure

- `provider-plugins.ts` - Main API: `createVoiceProviderPlugins()`
- `resolve-module-entry.ts` - Multi-root module resolution helper (voice-extension-specific)

## Import rules
- Runtime code must import only from `extensions/voice/modules/provider-plugins/index.ts`.
- Do not import from `extensions/voice/modules/provider-plugins/internal/**` outside of this module.

