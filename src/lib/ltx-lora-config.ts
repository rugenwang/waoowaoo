export interface LtxVideoLoraConfig {
  path: string
  weight: number
}

export const DEFAULT_LTX_VIDEO_LORAS: LtxVideoLoraConfig[] = [
  {
    path: '/Volumes/mac-out/models/ltx-2.3-lora/ltx-2-19b-ic-lora-detailer.safetensors',
    weight: 0.5,
  },
  {
    path: '/Volumes/mac-out/models/ltx-2.3-lora/Cinematic_Hardcut.safetensors',
    weight: 0.2,
  },
  {
    path: '/Volumes/mac-out/models/ltx-2.3-lora/ltx2.3-transition.safetensors',
    weight: 0.4,
  },
  {
    path: '/Volumes/mac-out/models/ltx-2.3-lora/Ltx2.3-Licon-VBVR-I2V-390K-R32.safetensors',
    weight: 0.4,
  },
  {
    path: '/Volumes/mac-out/models/ltx-2.3-lora/ltx-2.3-22b-ic-lora-hdr-0.9.safetensors',
    weight: 0.4,
  },
]

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-10, Math.min(10, value))
}

function normalizeOne(raw: unknown): LtxVideoLoraConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (!path) return null
  const weight = typeof record.weight === 'number'
    ? record.weight
    : typeof record.weight === 'string'
      ? Number(record.weight)
      : 0
  return {
    path,
    weight: clampWeight(weight),
  }
}

export function normalizeLtxVideoLoras(raw: unknown): LtxVideoLoraConfig[] {
  const value = typeof raw === 'string'
    ? (() => {
        try {
          return JSON.parse(raw) as unknown
        } catch {
          return null
        }
      })()
    : raw
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeOne)
    .filter((item): item is LtxVideoLoraConfig => item !== null)
}

export function resolveLtxVideoLoras(raw: unknown): LtxVideoLoraConfig[] {
  const custom = normalizeLtxVideoLoras(raw)
  return custom.length > 0 ? custom : DEFAULT_LTX_VIDEO_LORAS
}

export function serializeLtxVideoLoras(raw: unknown): string {
  return JSON.stringify(normalizeLtxVideoLoras(raw))
}
