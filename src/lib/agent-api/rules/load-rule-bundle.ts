import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getArtStylePrompt } from '@/lib/constants'
import { prisma } from '@/lib/prisma'
import {
  getPromptTemplate,
  type PromptId,
  type PromptLocale,
} from '@/lib/prompt-i18n'

import {
  hashArtifact,
  sha256Prefixed,
} from '../canonical-json'
import {
  agentContractRegistry,
} from '../contracts/registry'
import { AgentApiError } from '../errors'
import {
  AGENT_RULE_MANIFEST,
  CREATOR_CONTRACT_MANIFEST,
  PROJECT_PROMPT_RULE_MANIFEST,
  RULE_SET_VERSION,
  type CreatorRuleKind,
} from './manifest'

export type CreatorRuleLocale = 'zh' | 'en'

export type CreatorProjectSettingsSource = {
  artStyle: string
  videoRatio: string
  imageResolution: string
  forcedStoryboardDurationSec: number | null
}

export type CreatorRuleBundleDependencies = {
  findProjectSettings: (
    projectId: string,
  ) => Promise<CreatorProjectSettingsSource | null>
  getPromptTemplate: (promptId: PromptId, locale: PromptLocale) => string
  getArtStylePrompt: (
    artStyle: string | null | undefined,
    locale: CreatorRuleLocale,
  ) => string
  readAgentRule: (
    pathStem: `agent-creator/${string}`,
    locale: CreatorRuleLocale,
  ) => Promise<string> | string
}

type CreatorRule = {
  id: string
  kind: CreatorRuleKind
  content: string
  hash: string
}

async function readManifestAgentRule(
  pathStem: `agent-creator/${string}`,
  locale: CreatorRuleLocale,
): Promise<string> {
  const promptRoot = path.resolve(process.cwd(), 'lib', 'prompts')
  const filePath = path.resolve(promptRoot, `${pathStem}.${locale}.txt`)
  const allowedFiles = new Set(
    AGENT_RULE_MANIFEST.map((entry) => (
      path.resolve(promptRoot, `${entry.pathStem}.${locale}.txt`)
    )),
  )

  if (!allowedFiles.has(filePath)) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }
  return readFile(filePath, 'utf8')
}

const defaultDependencies: CreatorRuleBundleDependencies = {
  findProjectSettings: async (projectId) => prisma.novelPromotionProject.findUnique({
    where: { projectId },
    select: {
      artStyle: true,
      videoRatio: true,
      imageResolution: true,
      forcedStoryboardDurationSec: true,
    },
  }),
  getPromptTemplate,
  getArtStylePrompt,
  readAgentRule: readManifestAgentRule,
}

function rule(
  id: string,
  kind: CreatorRuleKind,
  content: string,
): CreatorRule {
  return {
    id,
    kind,
    content,
    hash: sha256Prefixed(content),
  }
}

export async function loadCreatorRuleBundle(
  input: {
    projectId: string
    locale: CreatorRuleLocale
  },
  dependencies: CreatorRuleBundleDependencies = defaultDependencies,
) {
  const project = await dependencies.findProjectSettings(input.projectId)
  if (!project) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }

  const projectRules = PROJECT_PROMPT_RULE_MANIFEST.map((entry) => rule(
    entry.id,
    entry.kind,
    dependencies.getPromptTemplate(entry.promptId, input.locale),
  ))
  const agentRules = await Promise.all(AGENT_RULE_MANIFEST.map(async (entry) => rule(
    entry.id,
    entry.kind,
    await dependencies.readAgentRule(entry.pathStem, input.locale),
  )))
  const contracts = CREATOR_CONTRACT_MANIFEST.map(({ id, url }) => {
    const contract = agentContractRegistry[id]
    return {
      id,
      url,
      hash: hashArtifact(contract.jsonSchema),
    }
  })

  const dataWithoutContentHash = {
    schemaVersion: 1 as const,
    ruleSetVersion: RULE_SET_VERSION,
    locale: input.locale,
    projectSettings: {
      artStyle: project.artStyle,
      artStylePrompt: getNullableArtStylePrompt(
        dependencies.getArtStylePrompt(project.artStyle, input.locale),
      ),
      videoRatio: project.videoRatio,
      imageResolution: project.imageResolution,
      forcedStoryboardDurationSec: project.forcedStoryboardDurationSec,
    },
    rules: [...projectRules, ...agentRules],
    contracts,
  }

  return {
    ...dataWithoutContentHash,
    contentHash: hashArtifact(dataWithoutContentHash),
  }
}

function getNullableArtStylePrompt(value: string): string | null {
  const prompt = value.trim()
  return prompt || null
}
