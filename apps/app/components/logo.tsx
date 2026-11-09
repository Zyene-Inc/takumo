/**
 * Takumo's mark: a machined "T" with a sky accent block. A placeholder until
 * the real logo lands; replace the paths here and in app/icon.svg.
 */
export const LogoMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    viewBox="0 0 32 32"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect fill="currentColor" height="6" rx="1.5" width="24" x="4" y="5" />
    <rect
      fill="currentColor"
      height="17"
      rx="1.5"
      width="6.5"
      x="12.75"
      y="11"
    />
    <rect
      className="fill-sky-500"
      height="6"
      rx="1.5"
      width="6"
      x="22"
      y="21"
    />
  </svg>
);

export const Logo = ({ className }: { className?: string }) => (
  <span className={className}>
    <LogoMark className="w-7 shrink-0" />
    <span className="font-extrabold text-[15.5px] text-slate-900 tracking-tight">
      Takumo
    </span>
  </span>
);
