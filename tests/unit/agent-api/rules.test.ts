import { describe, expect, it } from 'vitest'

import {
  hashArtifact,
  sha256Prefixed,
} from '@/lib/agent-api/canonical-json'
import { agentContractRegistry } from '@/lib/agent-api/contracts/registry'
import {
  AGENT_RULE_MANIFEST,
  CREATOR_CONTRACT_MANIFEST,
  PROJECT_PROMPT_RULE_MANIFEST,
  RULE_SET_VERSION,
} from '@/lib/agent-api/rules/manifest'
import {
  loadCreatorRuleBundle,
  type CreatorRuleBundleDependencies,
} from '@/lib/agent-api/rules/load-rule-bundle'

const EXPECTED_PROMPT_IDS = [
  'np_episode_split',
  'np_ai_story_expand',
  'np_agent_character_profile',
  'np_agent_character_visual',
  'np_select_location',
  'np_select_prop',
  'np_agent_clip',
  'np_screenplay_conversion',
  'np_agent_storyboard_plan',
  'np_agent_cinematographer',
  'np_agent_acting_direction',
  'np_agent_storyboard_detail',
  'np_single_panel_image',
  'np_storyboard_prompt_refine',
]

const EXPECTED_AGENT_RULE_IDS = [
  'pipeline-hard-rules',
  'asset-image-generation',
  'storyboard-image-generation',
  'quality-check',
]

const EXPECTED_CONTRACT_IDS = [
  'waoo-agent-resolve-project.v1',
  'waoo-agent-create-run.v1',
  'waoo-agent-story.v1',
  'waoo-agent-assets.v1',
  'waoo-agent-screenplay.v1',
  'waoo-agent-storyboards.v1',
  'waoo-agent-upload.v1',
  'waoo-agent-finalize.v1',
]

function dependencies(overrides: Partial<CreatorRuleBundleDependencies> = {}): CreatorRuleBundleDependencies {
  return {
    findProjectSettings: async () => ({
      artStyle: 'realistic',
      videoRatio: '16:9',
      imageResolution: '4K',
      forcedStoryboardDurationSec: 10,
    }),
    getPromptTemplate: (promptId, locale) => `${locale}:project:${promptId}`,
    getArtStylePrompt: (artStyle, locale) => `${locale}:style:${artStyle}`,
    readAgentRule: (relativePath, locale) => `${locale}:agent:${relativePath}`,
    ...overrides,
  }
}

function withoutContentHash<T extends { contentHash: string }>(
  data: T,
): Omit<T, 'contentHash'> {
  const { contentHash: _contentHash, ...rest } = data
  void _contentHash
  return rest
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return keys
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
    return keys
  }
  for (const [key, item] of Object.entries(value)) {
    keys.add(key.toLowerCase().replace(/[_\-\s]/g, ''))
    collectKeys(item, keys)
  }
  return keys
}

describe('creator rule manifest', () => {
  it('is fixed to the fourteen WAOO prompts, four Agent hard rules, and registered contracts', () => {
    expect(RULE_SET_VERSION).toBe('waoo-creator-v1')
    expect(PROJECT_PROMPT_RULE_MANIFEST.map((rule) => rule.promptId)).toEqual(
      EXPECTED_PROMPT_IDS,
    )
    expect(AGENT_RULE_MANIFEST.map((rule) => rule.id)).toEqual(
      EXPECTED_AGENT_RULE_IDS,
    )
    expect(CREATOR_CONTRACT_MANIFEST.map((contract) => contract.id)).toEqual(
      EXPECTED_CONTRACT_IDS,
    )
    expect(CREATOR_CONTRACT_MANIFEST.map((contract) => contract.id)).toEqual(
      Object.keys(agentContractRegistry),
    )
  })
})

describe('loadCreatorRuleBundle', () => {
  it.each(['zh', 'en'] as const)(
    'loads the current WAOO rules and project settings for locale %s',
    async (locale) => {
      const data = await loadCreatorRuleBundle(
        { projectId: 'project-1', locale },
        dependencies(),
      )

      expect(data).toMatchObject({
        schemaVersion: 1,
        ruleSetVersion: 'waoo-creator-v1',
        locale,
        projectSettings: {
          artStyle: 'realistic',
          artStylePrompt: `${locale}:style:realistic`,
          videoRatio: '16:9',
          imageResolution: '4K',
          forcedStoryboardDurationSec: 10,
        },
      })
      expect(data.rules.map((rule) => rule.id)).toEqual([
        ...EXPECTED_PROMPT_IDS,
        ...EXPECTED_AGENT_RULE_IDS,
      ])
      expect(data.rules.slice(0, EXPECTED_PROMPT_IDS.length).map((rule) => rule.content))
        .toEqual(EXPECTED_PROMPT_IDS.map((id) => `${locale}:project:${id}`))
      expect(data.contracts.map((contract) => contract.id)).toEqual(
        EXPECTED_CONTRACT_IDS,
      )
    },
  )

  it('hashes every UTF-8 rule verbatim and every canonical JSON Schema', async () => {
    const data = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'zh' },
      dependencies({
        getPromptTemplate: (promptId) => `  当前规则：${promptId}\r\n`,
        readAgentRule: (relativePath) => `  硬规则：${relativePath}\n`,
      }),
    )

    for (const rule of data.rules) {
      expect(rule.hash).toBe(sha256Prefixed(rule.content))
    }
    for (const contract of data.contracts) {
      expect(contract.hash).toBe(hashArtifact(
        agentContractRegistry[contract.id].jsonSchema,
      ))
    }
  })

  it('uses one canonical bundle hash as both contentHash and the later ruleSetHash', async () => {
    const data = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'zh' },
      dependencies(),
    )

    expect(data.contentHash).toBe(hashArtifact(withoutContentHash(data)))
    const laterCommitEnvelope = { ruleSetHash: data.contentHash }
    expect(laterCommitEnvelope.ruleSetHash).toBe(data.contentHash)
  })

  it('changes contentHash when any current Prompt content changes', async () => {
    let currentContent = 'first current WAOO prompt'
    const deps = dependencies({
      getPromptTemplate: (promptId, locale) => (
        promptId === 'np_agent_clip'
          ? `${locale}:${currentContent}`
          : `${locale}:project:${promptId}`
      ),
    })

    const before = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'zh' },
      deps,
    )
    currentContent = 'second current WAOO prompt'
    const after = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'zh' },
      deps,
    )

    expect(after.rules.find((rule) => rule.id === 'np_agent_clip')?.content)
      .toContain(currentContent)
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('derives artStylePrompt from getArtStylePrompt instead of a database field', async () => {
    let receivedArtStyle: string | null | undefined
    const data = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'en' },
      dependencies({
        findProjectSettings: async () => ({
          artStyle: 'chinese-xianxia',
          videoRatio: '9:16',
          imageResolution: '2K',
          forcedStoryboardDurationSec: null,
        }),
        getArtStylePrompt: (artStyle) => {
          receivedArtStyle = artStyle
          return 'authoritative current style prompt'
        },
      }),
    )

    expect(receivedArtStyle).toBe('chinese-xianxia')
    expect(data.projectSettings.artStylePrompt).toBe(
      'authoritative current style prompt',
    )
  })

  it('fails with a not-found Agent error when the project mode data is absent', async () => {
    await expect(loadCreatorRuleBundle(
      { projectId: 'missing-project', locale: 'zh' },
      dependencies({ findProjectSettings: async () => null }),
    )).rejects.toMatchObject({
      code: 'AGENT_RESOURCE_NOT_FOUND',
      status: 404,
    })
  })

  it('does not expose model, provider, API key, or token configuration fields', async () => {
    const data = await loadCreatorRuleBundle(
      { projectId: 'project-1', locale: 'zh' },
      dependencies(),
    )
    const keys = collectKeys(data)

    expect(keys).not.toContain('analysismodel')
    expect(keys).not.toContain('imagemodel')
    expect(keys).not.toContain('videomodel')
    expect(keys).not.toContain('provider')
    expect(keys).not.toContain('apikey')
    expect(keys).not.toContain('token')
  })
})
