import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from '../base'
import { generateImageViaOpenAICompat } from '@/lib/model-gateway'

/**
 * ⚠️ 兼容历史 providerId: eeeapi
 *
 * 旧版 EEEAPI 实现是“把参考图 dataURL 塞进 prompt”的私有协议。
 * 现在按《GPT Image 2 — API 接入文档》走 OpenAI 兼容协议：
 * - POST /v1/images/generations
 * - POST /v1/images/edits（multipart）
 */

export class EeeApiImageGenerator extends BaseImageGenerator {
  private readonly modelId?: string
  private readonly providerId?: string

  constructor(modelId?: string, providerId?: string) {
    super()
    this.modelId = modelId
    this.providerId = providerId
  }

  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params
    return await generateImageViaOpenAICompat({
      userId,
      providerId: this.providerId || 'eeeapi',
      modelId: this.modelId,
      prompt,
      referenceImages,
      options,
      profile: 'openai-compatible',
    })
  }
}
