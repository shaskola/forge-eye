/**
 * Solar Icons (Linear) by 480 Design, CC BY 4.0.
 * https://www.figma.com/community/file/1166831539721848736
 * Archivos oficiales servidos por Iconify (prefijo solar:*-linear).
 */
import altArrowDown from './solar/alt-arrow-down-linear.svg?raw'
import arrowLeft from './solar/arrow-left-linear.svg?raw'
import dangerTriangle from './solar/danger-triangle-linear.svg?raw'
import hamburgerMenu from './solar/hamburger-menu-linear.svg?raw'
import infoCircle from './solar/info-circle-linear.svg?raw'
import plain2 from './solar/plain-2-linear.svg?raw'
import shieldCheck from './solar/shield-check-linear.svg?raw'
import sledgehammer from './solar/sledgehammer-linear.svg?raw'
import stopCircle from './solar/stop-circle-linear.svg?raw'

const sprites = {
  back: arrowLeft,
  move: hamburgerMenu,
  collapse: altArrowDown,
  send: plain2,
  stop: stopCircle,
  tool: sledgehammer,
  approval: shieldCheck,
  warning: dangerTriangle,
  info: infoCircle,
} as const

export type SolarIconName = keyof typeof sprites

export function SolarIcon({
  name,
  size = 16,
  className,
}: {
  name: SolarIconName
  size?: number
  className?: string
}) {
  return (
    <span
      className={['solar-icon', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: sprites[name] }}
      aria-hidden
    />
  )
}
