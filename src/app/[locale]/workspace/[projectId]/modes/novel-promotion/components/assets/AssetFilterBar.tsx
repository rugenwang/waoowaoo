'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { SegmentedControl } from '@/components/ui/SegmentedControl'

// ─── Types ────────────────────────────────────────────

export type AssetKindFilter = 'all' | 'character' | 'location' | 'prop'

interface AssetFilterBarProps {
    /** Current kind filter */
    kindFilter: AssetKindFilter
    onKindFilterChange: (value: AssetKindFilter) => void
    /** Asset counts for display */
    counts: {
        all: number
        character: number
        location: number
        prop: number
    }
    mobile?: boolean
}

// ─── Component ────────────────────────────────────────

export default function AssetFilterBar({
    kindFilter,
    onKindFilterChange,
    counts,
    mobile = false,
}: AssetFilterBarProps) {
    const t = useTranslations('assets')

    const visibleOptions = useMemo(() => {
        const segmentOptions = [
            { value: 'all' as const, label: `${t('filterBar.all')} (${counts.all})` },
            { value: 'character' as const, label: `${t('stage.characters')} (${counts.character})` },
            { value: 'location' as const, label: `${t('stage.locations')} (${counts.location})` },
            { value: 'prop' as const, label: `${t('stage.props')} (${counts.prop})` },
        ]
        return mobile
            ? segmentOptions.filter((option) => option.value !== 'all')
            : segmentOptions
    }, [counts.all, counts.character, counts.location, counts.prop, mobile, t])

    return (
        <div className={mobile ? 'sticky top-[132px] z-20 rounded-[18px] bg-white/95 p-1.5 shadow-sm ring-1 ring-slate-200/80 backdrop-blur' : 'px-4 py-3 glass-surface rounded-xl'}>
            <div className={mobile ? 'w-full' : 'overflow-x-auto'}>
                <SegmentedControl
                    options={visibleOptions}
                    value={kindFilter}
                    onChange={onKindFilterChange}
                    layout={mobile ? 'fill' : 'compact'}
                    className={mobile ? 'w-full' : 'min-w-max'}
                />
            </div>
        </div>
    )
}
