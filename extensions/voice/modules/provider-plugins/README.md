# Voice Provider Plugins Module

Loads voice provider manifests and compat modules from the voice extension plugin root.

## Import rules
- Runtime code must import only from `extensions/voice/modules/provider-plugins/index.ts`.
- Do not import from `extensions/voice/modules/provider-plugins/internal/**` outside of this module.

