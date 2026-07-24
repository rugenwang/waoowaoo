import { AGENT_CONTRACT_IDS } from '../contracts/registry'
import { PROMPT_IDS, type PromptId } from '@/lib/prompt-i18n'

export const RULE_SET_VERSION = 'waoo-creator-v1'

export type CreatorRuleKind = 'hard' | 'creative' | 'hard-and-creative'

export type ProjectPromptRuleManifestEntry = {
  id: string
  kind: CreatorRuleKind
  promptId: PromptId
}

export type AgentRuleManifestEntry = {
  id: string
  kind: 'hard'
  pathStem: `agent-creator/${string}`
}

// Bump RULE_SET_VERSION only for a semantic contract/workflow revision. Exact
// content changes are independently identified by the computed contentHash.
export const PROJECT_PROMPT_RULE_MANIFEST = [
  PROMPT_IDS.NP_EPISODE_SPLIT,
  PROMPT_IDS.NP_AI_STORY_EXPAND,
  PROMPT_IDS.NP_AGENT_CHARACTER_PROFILE,
  PROMPT_IDS.NP_AGENT_CHARACTER_VISUAL,
  PROMPT_IDS.NP_SELECT_LOCATION,
  PROMPT_IDS.NP_SELECT_PROP,
  PROMPT_IDS.NP_AGENT_CLIP,
  PROMPT_IDS.NP_SCREENPLAY_CONVERSION,
  PROMPT_IDS.NP_AGENT_STORYBOARD_PLAN,
  PROMPT_IDS.NP_AGENT_CINEMATOGRAPHER,
  PROMPT_IDS.NP_AGENT_ACTING_DIRECTION,
  PROMPT_IDS.NP_AGENT_STORYBOARD_DETAIL,
  PROMPT_IDS.NP_SINGLE_PANEL_IMAGE,
  PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE,
].map((promptId): ProjectPromptRuleManifestEntry => ({
  id: promptId,
  kind: 'hard-and-creative',
  promptId,
}))

export const AGENT_RULE_MANIFEST = [
  {
    id: 'pipeline-hard-rules',
    kind: 'hard',
    pathStem: 'agent-creator/pipeline-hard-rules',
  },
  {
    id: 'asset-image-generation',
    kind: 'hard',
    pathStem: 'agent-creator/asset-image-generation',
  },
  {
    id: 'storyboard-image-generation',
    kind: 'hard',
    pathStem: 'agent-creator/storyboard-image-generation',
  },
  {
    id: 'quality-check',
    kind: 'hard',
    pathStem: 'agent-creator/quality-check',
  },
] as const satisfies ReadonlyArray<AgentRuleManifestEntry>

export const CREATOR_CONTRACT_MANIFEST = AGENT_CONTRACT_IDS.map((id) => ({
  id,
  url: `/api/agent/v1/contracts/${id}`,
}))
