'use client'

import React from 'react'
import VideoPanelCardHeader from './VideoPanelCardHeader'
import VideoPanelCardBody from './VideoPanelCardBody'
import VideoPanelCardFooter from './VideoPanelCardFooter'
import { useVideoPanelActions, type VideoPanelCardShellProps } from './hooks/useVideoPanelActions'

export type { VideoPanelCardShellProps }

function VideoPanelCardLayout(props: VideoPanelCardShellProps) {
  const runtime = useVideoPanelActions(props)

  return (
     <div className="glass-surface-elevated overflow-visible">
       <VideoPanelCardHeader runtime={runtime} onUploadVideo={props.onUploadVideo} isUploadingVideo={props.isUploadingVideo} />
       <VideoPanelCardBody runtime={runtime} />
       <VideoPanelCardFooter runtime={runtime} />
     </div>
   )
}

export default React.memo(VideoPanelCardLayout)
