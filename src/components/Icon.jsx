import { library, icon } from '@fortawesome/fontawesome-svg-core'
import {
  faMicrochip, faFolderOpen, faWandMagicSparkles,
  faFileLines, faArrowRight, faGear, faTriangleExclamation,
  faRotateLeft, faHand, faCircleCheck, faArrowDown, faEye,
} from '@fortawesome/free-solid-svg-icons'

library.add(
  faMicrochip, faFolderOpen, faWandMagicSparkles,
  faFileLines, faArrowRight, faGear, faTriangleExclamation,
  faRotateLeft, faHand, faCircleCheck, faArrowDown, faEye,
)

export function Icon({ name, className = '' }) {
  const i = icon({ prefix: 'fas', iconName: name })
  if (!i) return null
  return <span class={`fa-icon ${className}`} dangerouslySetInnerHTML={{ __html: i.html[0] }} />
}
