import { Prisma } from '@prisma/client'

import { AgentApiError } from '@/lib/agent-api/errors'
import { isArtStyleValue } from '@/lib/constants'
import { prisma } from '@/lib/prisma'

export const PROJECT_PREFERENCE_DEFAULT_FIELDS = [
  'analysisModel',
  'characterModel',
  'locationModel',
  'storyboardModel',
  'editModel',
  'videoModel',
  'audioModel',
  'videoRatio',
  'artStyle',
  'ttsRate',
] as const

const PROJECT_PREFERENCE_SELECT = {
  analysisModel: true,
  characterModel: true,
  locationModel: true,
  storyboardModel: true,
  editModel: true,
  videoModel: true,
  audioModel: true,
  videoRatio: true,
  artStyle: true,
  ttsRate: true,
} satisfies Prisma.UserPreferenceSelect

export type ResolveCreatorProjectInput = {
  userId: string
  name: string
  description?: string
  initialVideoRatio?: string
  initialArtStyle?: string
}

export type ResolveCreatorProjectResult = {
  projectId: string
  name: string
  created: boolean
}

export async function resolveCreatorProject(
  input: ResolveCreatorProjectInput,
): Promise<ResolveCreatorProjectResult> {
  const name = input.name.trim()
  const description = input.description?.trim() || null

  return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM user WHERE id = ${input.userId} FOR UPDATE
    `)

    const candidates = await tx.project.findMany({
      where: {
        userId: input.userId,
        name,
      },
      select: {
        id: true,
        name: true,
      },
    })
    const exactMatches = candidates.filter((project) => project.name === name)

    if (exactMatches.length > 1) {
      throw new AgentApiError('PROJECT_NAME_AMBIGUOUS')
    }
    if (exactMatches.length === 1) {
      return {
        projectId: exactMatches[0].id,
        name: exactMatches[0].name,
        created: false,
      }
    }

    const userPreference = await tx.userPreference.findUnique({
      where: { userId: input.userId },
      select: PROJECT_PREFERENCE_SELECT,
    })
    const project = await tx.project.create({
      data: {
        userId: input.userId,
        name,
        description,
      },
      select: {
        id: true,
        name: true,
      },
    })

    await tx.novelPromotionProject.create({
      data: {
        projectId: project.id,
        ...(userPreference && {
          ...userPreference,
          artStyle: isArtStyleValue(userPreference.artStyle)
            ? userPreference.artStyle
            : 'american-comic',
        }),
        ...(input.initialVideoRatio && input.initialArtStyle && {
          videoRatio: input.initialVideoRatio,
          artStyle: input.initialArtStyle,
        }),
      },
    })

    return {
      projectId: project.id,
      name: project.name,
      created: true,
    }
  })
}
