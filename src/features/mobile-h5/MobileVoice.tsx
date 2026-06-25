'use client'

import dynamic from 'next/dynamic'
import { MobileLoadingState } from './MobileShell'

const VoiceStage = dynamic(
  () => import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VoiceStage'),
  { ssr: false, loading: () => <MobileLoadingState label="正在加载配音工作台..." /> },
)

interface MobileVoiceProps {
  projectId: string
  episodeId: string
  onBack: () => void
  onOpenAssets: (characterId?: string | null) => void
}

export default function MobileVoice({ projectId, episodeId, onBack, onOpenAssets }: MobileVoiceProps) {
  return (
    <div className="min-w-0 overflow-x-hidden pb-4 [&_button]:touch-manipulation">
      <VoiceStage
        projectId={projectId}
        episodeId={episodeId}
        embedded
        onBack={onBack}
        onOpenAssetLibraryForCharacter={onOpenAssets}
      />
    </div>
  )
}
