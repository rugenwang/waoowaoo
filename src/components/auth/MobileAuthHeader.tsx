import Image from 'next/image'

export default function MobileAuthHeader() {
  return (
    <header className="border-b border-slate-200/80 bg-white/95 px-5 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:hidden">
      <div className="mx-auto flex max-w-md items-center gap-3">
        <Image src="/logo-small.png?v=1" alt="Waoo" width={42} height={42} className="h-10 w-10 object-contain" priority />
        <div>
          <div className="text-base font-semibold text-slate-950">Waoo</div>
          <div className="text-xs text-slate-500">移动创作工作台</div>
        </div>
      </div>
    </header>
  )
}
