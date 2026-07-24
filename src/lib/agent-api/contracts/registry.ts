import { z } from 'zod'
import {
  ignoreOverride,
  type JsonSchema7Type,
  zodToJsonSchema,
} from 'zod-to-json-schema'

import { hashArtifact } from '../canonical-json'
import { AssetsCommitRequestSchema } from './assets'
import { FinalizeRequestSchema } from './finalize'
import { ResolveProjectRequestSchema } from './project'
import { CreateRunRequestSchema } from './run'
import { ScreenplayCommitRequestSchema } from './screenplay'
import { StoryCommitRequestSchema } from './story'
import { StoryboardsCommitRequestSchema } from './storyboards'
import {
  UPLOAD_FILE_DESCRIPTION,
  UPLOAD_FILE_JSON_SCHEMA_MARKER,
  UploadFieldsSchema,
} from './upload'

export const AGENT_CONTRACT_IDS = [
  'waoo-agent-resolve-project.v1',
  'waoo-agent-create-run.v1',
  'waoo-agent-story.v1',
  'waoo-agent-assets.v1',
  'waoo-agent-screenplay.v1',
  'waoo-agent-storyboards.v1',
  'waoo-agent-upload.v1',
  'waoo-agent-finalize.v1',
] as const

export type AgentContractId = (typeof AGENT_CONTRACT_IDS)[number]

function jsonSchemaFor(
  id: AgentContractId,
  schema: z.ZodTypeAny,
): JsonSchema7Type & { $schema: string } {
  return zodToJsonSchema(schema, {
    name: id,
    target: 'jsonSchema7',
    $refStrategy: 'root',
    effectStrategy: 'input',
    removeAdditionalStrategy: 'strict',
    strictUnions: true,
    override: (definition) => {
      if (definition.description === UPLOAD_FILE_JSON_SCHEMA_MARKER) {
        return {
          type: 'string',
          format: 'binary',
          description: UPLOAD_FILE_DESCRIPTION,
        }
      }
      return ignoreOverride
    },
  }) as JsonSchema7Type & { $schema: string }
}

function createRegistryEntry<T extends z.ZodTypeAny>(
  id: AgentContractId,
  zodSchema: T,
) {
  const jsonSchema = jsonSchemaFor(id, zodSchema)
  return {
    id,
    zodSchema,
    jsonSchema,
    hash: hashArtifact(jsonSchema),
  } as const
}

export const agentContractRegistry = {
  'waoo-agent-resolve-project.v1': createRegistryEntry(
    'waoo-agent-resolve-project.v1',
    ResolveProjectRequestSchema,
  ),
  'waoo-agent-create-run.v1': createRegistryEntry(
    'waoo-agent-create-run.v1',
    CreateRunRequestSchema,
  ),
  'waoo-agent-story.v1': createRegistryEntry(
    'waoo-agent-story.v1',
    StoryCommitRequestSchema,
  ),
  'waoo-agent-assets.v1': createRegistryEntry(
    'waoo-agent-assets.v1',
    AssetsCommitRequestSchema,
  ),
  'waoo-agent-screenplay.v1': createRegistryEntry(
    'waoo-agent-screenplay.v1',
    ScreenplayCommitRequestSchema,
  ),
  'waoo-agent-storyboards.v1': createRegistryEntry(
    'waoo-agent-storyboards.v1',
    StoryboardsCommitRequestSchema,
  ),
  'waoo-agent-upload.v1': createRegistryEntry(
    'waoo-agent-upload.v1',
    UploadFieldsSchema,
  ),
  'waoo-agent-finalize.v1': createRegistryEntry(
    'waoo-agent-finalize.v1',
    FinalizeRequestSchema,
  ),
} as const satisfies Record<
  AgentContractId,
  ReturnType<typeof createRegistryEntry>
>

export function getAgentContract(id: string) {
  if (!AGENT_CONTRACT_IDS.includes(id as AgentContractId)) return undefined
  return agentContractRegistry[id as AgentContractId]
}
