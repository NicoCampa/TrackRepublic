type BrandLogoProps = {
  size?: number;
  title?: string;
};

export function BrandLogo({ size = 44, title = "Track Republic" }: BrandLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={title}
      role="img"
      className="brand-mark-svg"
    >
      <defs>
        <linearGradient id="brand-line" x1="16" y1="46" x2="48" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#37D4FF" />
          <stop offset="0.58" stopColor="#4EE39A" />
          <stop offset="1" stopColor="#F7BF4A" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" fill="#0F131A" stroke="#273242" strokeWidth="2" />
      <path d="M16 20H48" stroke="#1B2431" strokeWidth="2" />
      <path d="M16 32H48" stroke="#1B2431" strokeWidth="2" />
      <path d="M16 44H48" stroke="#1B2431" strokeWidth="2" />
      <path d="M16 16V48" stroke="#1B2431" strokeWidth="2" />
      <path d="M32 16V48" stroke="#1B2431" strokeWidth="2" />
      <path d="M48 16V48" stroke="#1B2431" strokeWidth="2" />
      <path d="M16 40L26 31L35 35L48 20" stroke="url(#brand-line)" strokeWidth="5" strokeLinecap="square" strokeLinejoin="miter" />
      <rect x="13" y="37" width="6" height="6" fill="#37D4FF" />
      <rect x="23" y="28" width="6" height="6" fill="#4EE39A" />
      <rect x="32" y="32" width="6" height="6" fill="#7EE8C1" />
      <rect x="45" y="17" width="6" height="6" fill="#F7BF4A" />
    </svg>
  );
}
